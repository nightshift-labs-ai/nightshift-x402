// Wallet / counterparty screen before sending funds or accepting a payer: OFAC SDN crypto addresses (0xB10C list, refreshed weekly upstream)
// + Base and Ethereum on-chain signals + optional address-poisoning look-alike check against the address you expected.
import { rpc, call, pad, decodeString, fmt, isAddr, USDC } from "./lib.mjs";

const OFAC_URL = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";
let ofac = null; // { set, t, count } plain data only (safe to share across requests on workerd)
async function ofacList() {
  if (ofac && Date.now() - ofac.t < 6 * 3600e3) return ofac;
  try {
    const r = await fetch(OFAC_URL, { headers: { "user-agent": "NightshiftLabs/1.0" }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { const lines = (await r.text()).split(/\s+/).filter(isAddr).map(a => a.toLowerCase()); if (lines.length > 50) ofac = { set: new Set(lines), t: Date.now(), count: lines.length }; }
  } catch {}
  return ofac;
}
async function ethRpc(method, params) {
  const r = await fetch("https://ethereum-rpc.publicnode.com", { method: "POST", headers: { "content-type": "application/json", "user-agent": "NightshiftLabs/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
const BURN = /^0x(0{40}|0{36}dead|dead0{36}|0{39}1)$/i;

export async function walletScreen(address, expected) {
  const a = address.toLowerCase(), flags = [];
  const [list, code, nonce, eth, usdc, ethNonce, ethCode] = await Promise.all([ofacList(), rpc("eth_getCode", [address, "latest"]).catch(() => null),
    rpc("eth_getTransactionCount", [address, "latest"]).catch(() => null), rpc("eth_getBalance", [address, "latest"]).catch(() => null), call(USDC, "0x70a08231" + pad(address)),
    ethRpc("eth_getTransactionCount", [address, "latest"]).catch(() => null), ethRpc("eth_getCode", [address, "latest"]).catch(() => null)]);
  const sanctioned = list ? list.set.has(a) : null;
  if (sanctioned) flags.push("OFAC_SANCTIONED");
  if (sanctioned == null) flags.push("SANCTIONS_LIST_UNAVAILABLE");
  if (BURN.test(address)) flags.push("BURN_OR_ZERO_ADDRESS");
  const hasCode = !!(code && code !== "0x"), delegated = hasCode && /^0xef0100/i.test(code);
  let kind = hasCode ? (delegated ? "eoa_with_7702_delegation" : "contract") : "eoa", token = null;
  if (hasCode && !delegated) {
    const [sym, dec] = await Promise.all([call(address, "0x95d89b41"), call(address, "0x313ce567")]);
    const s = decodeString(sym); if (s && dec && dec !== "0x") { kind = "token_contract"; token = { symbol: s, decimals: Number(BigInt(dec)) }; flags.push("IS_TOKEN_CONTRACT"); }
  }
  if (delegated) flags.push("EIP7702_DELEGATED");
  const baseTx = nonce ? Number(BigInt(nonce)) : null, ethTx = ethNonce ? Number(BigInt(ethNonce)) : null;
  if (kind === "eoa" && baseTx === 0 && ethTx === 0) flags.push("NO_OUTGOING_TX_ON_BASE_OR_ETHEREUM");
  let lookalike = null;
  if (expected && isAddr(expected) && expected.toLowerCase() !== a) {
    const e = expected.toLowerCase(), head = (x) => x.slice(2, 6), tail = (x) => x.slice(-4);
    const sameEnds = head(e) === head(a) && tail(e) === tail(a), partial = head(e) === head(a) || tail(e) === tail(a);
    lookalike = { expected, matchesExpected: false, sameFirst4AndLast4: sameEnds, sharesFirst4OrLast4: partial };
    flags.push(sameEnds ? "ADDRESS_POISONING_LOOKALIKE" : "DIFFERENT_FROM_EXPECTED");
  } else if (expected && isAddr(expected)) lookalike = { expected, matchesExpected: true };
  const verdict = sanctioned ? "block" : flags.some(f => ["BURN_OR_ZERO_ADDRESS", "ADDRESS_POISONING_LOOKALIKE", "IS_TOKEN_CONTRACT", "DIFFERENT_FROM_EXPECTED"].includes(f)) ? "high_risk"
    : flags.some(f => f !== "EIP7702_DELEGATED") ? "caution" : "no_red_flags";
  return { address, verdict, flags, sanctions: { listed: sanctioned, source: "OFAC SDN digital currency addresses (ETH/EVM) via github.com/0xB10C/ofac-sanctioned-digital-currency-addresses", listSize: list?.count ?? null },
    kind, token, base: { txCount: baseTx, eth: eth ? fmt(BigInt(eth), 18) : null, usdc: usdc ? fmt(BigInt(usdc), 6) : null },
    ethereum: { txCount: ethTx, isContract: ethCode ? ethCode !== "0x" : null }, lookalike,
    note: "Screening aid, not legal advice. 'no_red_flags' does not prove an address is safe; txCount counts outgoing transactions only." };
}
