// Pure logic, no payment code. Uses free public Base RPC.
import net from "node:net";
import { parseHTML } from "linkedom"; import { Readability } from "@mozilla/readability"; import TurndownService from "turndown";
const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
let dns = null; try { dns = await import("node:dns/promises"); if (!dns.lookup) dns = dns.default; } catch {}
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
let rid = 0;
// Read lazily: on Workers process.env is populated from vars/secrets; a keyed BASE_RPC_URL (Alchemy etc.) goes first.
const rpcList = () => [...new Set([globalThis.process?.env?.BASE_RPC_URL, "https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org",
  "https://base.gateway.tenderly.co", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.meowrpc.com"].filter(Boolean))];
// Try each public RPC in turn: shared Cloudflare egress IPs get rate-limited by single providers.
// JSON-RPC "execution" errors (e.g. revert) are real answers -> thrown immediately; transport/rate-limit errors -> next provider.
export async function rpc(method, params) {
  let last; const errs = [];
  for (const u of rpcList()) {
    try {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", "user-agent": "NightshiftLabs/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) { last = new Error(`rpc http ${r.status}`); errs.push(new URL(u).host + " " + r.status); continue; }
      const j = await r.json();
      if (j.error) { if (/rate|limit|exceed|too many|capacity|unavailable|timeout|not supported|does not exist|not available|block range|apikey/i.test(j.error.message || "")) { last = new Error(j.error.message); errs.push(new URL(u).host + " " + String(j.error.message).slice(0, 40)); continue; } throw Object.assign(new Error(j.error.message), { final: true }); }
      return j.result;
    } catch (e) { if (e.final) throw e; last = e; errs.push(new URL(u).host + " " + String(e.message || e).slice(0, 40)); }
  }
  throw new Error("rpc failed: " + errs.join("; "));
}
// JSON-RPC batch: many calls in ONE HTTP request (saves Workers subrequests and rate-limit budget). Returns results in order; per-item errors -> null.
export async function rpcBatch(reqs) {
  let last;
  for (const u of rpcList()) {
    try {
      const body = reqs.map((q, i) => ({ jsonrpc: "2.0", id: i, method: q[0], params: q[1] }));
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", "user-agent": "NightshiftLabs/1.0" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!r.ok) { last = new Error(`rpc http ${r.status}`); continue; }
      const j = await r.json();
      if (!Array.isArray(j)) { last = new Error(j?.error?.message || "batch not supported"); continue; }
      if (j.some(x => x.error && /rate|limit|exceed|too many|capacity/i.test(x.error.message || ""))) { last = new Error("rate limited"); continue; }
      const out = new Array(reqs.length).fill(null); for (const x of j) if (x && "result" in x) out[x.id] = x.result; return out;
    } catch (e) { last = e; }
  }
  // last resort: individual calls (each with provider fallback)
  const out = await Promise.all(reqs.map(q => rpc(q[0], q[1]).catch(() => null)));
  if (out.every(x => x == null)) throw last || new Error("rpc failed");
  return out;
}
export const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a || "");
export const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]).catch(() => null);
export const pad = a => a.toLowerCase().replace("0x", "").padStart(64, "0");
const toBig = h => (h && h !== "0x" ? BigInt(h) : null);
export function decodeString(h) {
  if (!h || h === "0x") return null;
  const b = Buffer.from(h.slice(2), "hex");
  try { if (b.length >= 64) { const off = Number(BigInt("0x" + b.subarray(0, 32).toString("hex"))); const len = Number(BigInt("0x" + b.subarray(off, off + 32).toString("hex"))); if (len < 1000) return b.subarray(off + 32, off + 32 + len).toString("utf8"); } } catch {}
  return b.toString("utf8").replace(/\0+$/, "") || null; // bytes32 style
}
export const fmt = (v, d) => { if (v == null) return null; const s = v.toString().padStart(d + 1, "0"); const i = s.slice(0, s.length - d), f = s.slice(s.length - d).replace(/0+$/, ""); return f ? `${i}.${f}` : i; };
// 4-byte selectors that indicate privileged powers
const RISKY = { "40c10f19": "mint(address,uint256)", "a0712d68": "mint(uint256)", "8456cb59": "pause()", "3f4ba83a": "unpause()",
  "f9f92be4": "blacklist(address)", "44337ea1": "addToBlacklist(address)", "e47d6060": "isBlackListed(address)", "0ecb93c0": "addBlackList(address)",
  "8da5cb5b": "owner()", "f2fde38b": "transferOwnership(address)", "715018a6": "renounceOwnership()",
  "69fe0e2d": "setFee(uint256)", "c0246668": "excludeFromFee(address,bool)", "3659cfe6": "upgradeTo(address)", "4f1ef286": "upgradeToAndCall(address,bytes)",
  "9dc29fac": "burn(address,uint256)", "a9059cbb": "transfer(address,uint256)" };
async function firstSlot(a, slots) {
  for (const sl of slots) { const v = await rpc("eth_getStorageAt", [a, sl, "latest"]).catch(() => null); if (v && BigInt(v) !== 0n) return v; }
  return null;
}
export async function tokenCheck(address) {
  const [code, name, symbol, dec, supply, owner, implSlot] = await Promise.all([
    rpc("eth_getCode", [address, "latest"]), call(address, "0x06fdde03"), call(address, "0x95d89b41"), call(address, "0x313ce567"),
    call(address, "0x18160ddd"), call(address, "0x8da5cb5b"),
    firstSlot(address, ["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967 impl
      "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"])]); // legacy Zeppelin impl
  const isContract = !!code && code !== "0x";
  const impl = implSlot && BigInt(implSlot) !== 0n ? "0x" + implSlot.slice(-40) : null;
  let scan = code || "";
  if (impl) scan += (await rpc("eth_getCode", [impl, "latest"]).catch(() => "")) || "";
  const found = Object.entries(RISKY).filter(([s]) => scan.includes("63" + s)).map(([, n]) => n); // PUSH4 <selector>
  const decimals = toBig(dec) != null ? Number(toBig(dec)) : null;
  const ownerAddr = owner && owner.length >= 66 ? "0x" + owner.slice(-40) : null;
  const renounced = ownerAddr ? /^0x0{40}$/.test(ownerAddr) || ownerAddr.toLowerCase() === "0x000000000000000000000000000000000000dead" : null;
  const flags = [];
  if (!isContract) flags.push("NOT_A_CONTRACT");
  const imp = impersonation(address, decodeString(symbol), decodeString(name)); if (imp) flags.push(imp);
  if (impl || found.some(f => f.startsWith("upgradeTo"))) flags.push("UPGRADEABLE_PROXY");
  if (found.some(f => f.startsWith("mint"))) flags.push("HAS_MINT_FUNCTION");
  if (found.some(f => /lack|Black/i.test(f))) flags.push("HAS_BLACKLIST");
  if (found.includes("pause()")) flags.push("PAUSABLE");
  if (found.some(f => /Fee/.test(f))) flags.push("ADJUSTABLE_FEES");
  if (ownerAddr && !renounced) flags.push("ACTIVE_OWNER");
  const risk = !isContract ? "n/a" : imp?.startsWith("IMPERSONATES") ? "high" : flags.filter(f => f !== "ACTIVE_OWNER").length >= 2 ? "elevated" : flags.length ? "moderate" : "low";
  return { chain: "base", address, isContract, bytecodeBytes: isContract ? (code.length - 2) / 2 : 0,
    name: decodeString(name), symbol: decodeString(symbol), decimals,
    totalSupply: supply && decimals != null ? fmt(toBig(supply), decimals) : toBig(supply)?.toString() ?? null,
    owner: ownerAddr, ownershipRenounced: renounced, proxyImplementation: impl, privilegedFunctions: found.filter(f => f !== "transfer(address,uint256)"),
    flags, heuristicRisk: risk,
    note: "Heuristic static check from on-chain bytecode and standard calls. Not financial advice; absence of flags does not prove safety." };
}
export async function balance(address) {
  const [eth, usdc] = await Promise.all([rpc("eth_getBalance", [address, "latest"]), call(USDC, "0x70a08231" + pad(address))]);
  return { chain: "base", address, eth: fmt(BigInt(eth), 18), usdc: fmt(toBig(usdc) ?? 0n, 6), block: Number(BigInt(await rpc("eth_blockNumber", []))) };
}
// ---- web extract ----
function privateIp(ip) {
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l === "::" || l.startsWith("::ffff:") && privateIp(l.slice(7)); }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export async function safeUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error("invalid url"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("only http/https");
  const h = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(h) || (net.isIP(h) && privateIp(h))) throw new Error("not fetched: local or private host");
  if (dns?.lookup) {
    const addrs = await dns.lookup(h, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error("not fetched: host does not resolve (no DNS address)");
    if (addrs.some(a => privateIp(a.address))) throw new Error("not fetched: host resolves to a private address");
  }
  return url;
}
const decode = s => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
export async function extract(u, maxChars = 20000) {
  let url = await safeUrl(u), r;
  for (let i = 0; i < 4; i++) { // follow redirects manually, re-checking each hop
    r = await fetch(url, { redirect: "manual", headers: { "user-agent": "NightshiftLabs-Extractor/1.0", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(12000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = await safeUrl(new URL(r.headers.get("location"), url).href); continue; }
    break;
  }
  const ct = r.headers.get("content-type") || "";
  const buf = Buffer.from(await r.arrayBuffer()).subarray(0, 3_000_000).toString("utf8");
  if (!/html|text|xml|json/.test(ct)) return { url: url.href, status: r.status, contentType: ct, error: "unsupported content type" };
  if (!/html/.test(ct)) return { url: url.href, status: r.status, contentType: ct, title: null, markdown: buf.slice(0, maxChars), truncated: buf.length > maxChars };
  const { document } = parseHTML(buf);
  const title = (document.querySelector("title")?.textContent || "").trim() || null;
  const desc = document.querySelector('meta[name="description"]')?.getAttribute("content") || document.querySelector('meta[property="og:description"]')?.getAttribute("content") || null;
  let html = null;
  try { const art = new Readability(document, { charThreshold: 200 }).parse(); if (art?.content) html = art.content; } catch {}
  const { document: d2 } = parseHTML(`<html><body>${html ?? (document.querySelector("main,article,[role=main]") || document.body || {}).innerHTML ?? buf}</body></html>`);
  d2.querySelectorAll("script,style,noscript,svg,iframe,template,nav,form,button").forEach(e => e.remove());
  const links = [];
  d2.querySelectorAll("a[href]").forEach(a => { const href = a.getAttribute("href"); if (!href || href.startsWith("#")) return; try { const abs = new URL(href, url).href; a.setAttribute("href", abs); const t = a.textContent.trim(); if (t && links.length < 100) links.push({ text: t, href: abs }); } catch {} });
  d2.querySelectorAll("a").forEach(a => { if (!a.textContent.trim() && !a.querySelector("img")) a.remove(); });
  d2.querySelectorAll("img").forEach(i => { const s = i.getAttribute("src"); if (s) try { i.setAttribute("src", new URL(s, url).href); } catch {} });
  const md = td.turndown(d2.body).replace(/\n{3,}/g, "\n\n").trim();
  return { url: url.href, status: r.status, title, description: desc, markdown: md.slice(0, maxChars), truncated: md.length > maxChars, wordCount: md.split(/\s+/).length, links };
}

// ---- impersonation detection ----
const CANONICAL = { USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", USDBC: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", WETH: "0x4200000000000000000000000000000000000006",
  CBBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", DAI: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", EURC: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", USDT: null, ETH: null };
export function impersonation(address, symbol, name) {
  if (!symbol && !name) return null;
  const raw = `${symbol || ""} ${name || ""}`;
  const nonAscii = /[^\x20-\x7E]/.test(raw);
  const folded = (symbol || "").normalize("NFKD").replace(/[^\x20-\x7E]/g, c => ({ "ꓚ": "C", "Ꭰ": "D", "Ѕ": "S", "Т": "T", "Е": "E", "Н": "H", "С": "C", "А": "A", "В": "B", "О": "O", "Р": "P", "Х": "X", "о": "o", "е": "e", "а": "a", "с": "c" }[c] ?? "")).replace(/\s|\./g, "").toUpperCase();
  const canon = Object.prototype.hasOwnProperty.call(CANONICAL, folded) ? CANONICAL[folded] : undefined;
  if (canon !== undefined && canon !== address.toLowerCase()) return `IMPERSONATES_${folded}${nonAscii ? "_WITH_LOOKALIKE_CHARACTERS" : ""}`;
  if (nonAscii && /[A-Za-z]/.test(raw)) return "NON_ASCII_SYMBOL";
  return null;
}

// ---- Base transaction decoder ----
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const tokenMetaCache = new Map();
async function tokenMeta(a) {
  if (tokenMetaCache.has(a)) return tokenMetaCache.get(a);
  const [sym, dec] = await Promise.all([call(a, "0x95d89b41"), call(a, "0x313ce567")]);
  const m = { symbol: decodeString(sym), decimals: toBig(dec) != null ? Number(toBig(dec)) : null };
  if (tokenMetaCache.size > 500) tokenMetaCache.clear(); tokenMetaCache.set(a, m); return m;
}
export const isHash = h => /^0x[0-9a-fA-F]{64}$/.test(h || "");
export async function txDecode(hash) {
  const [tx, rc] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
  if (!tx) return { chain: "base", hash, found: false };
  const block = rc ? await rpc("eth_getBlockByNumber", [rc.blockNumber, false]).catch(() => null) : null;
  const transfers = [];
  for (const lg of rc?.logs || []) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length !== 3) continue; // ERC-20 (ERC-721 has 4 topics)
    const m = await tokenMeta(lg.address);
    const raw = toBig(lg.data) ?? 0n;
    const warn = impersonation(lg.address, m.symbol);
    transfers.push({ token: lg.address, symbol: m.symbol, ...(warn ? { warning: warn } : {}), from: "0x" + lg.topics[1].slice(-40), to: "0x" + lg.topics[2].slice(-40),
      amount: m.decimals != null ? fmt(raw, m.decimals) : raw.toString(), rawAmount: raw.toString() });
  }
  const gasUsed = rc ? BigInt(rc.gasUsed) : null, price = rc?.effectiveGasPrice ? BigInt(rc.effectiveGasPrice) : null;
  return { chain: "base", hash, found: true, status: rc ? (rc.status === "0x1" ? "success" : "failed") : "pending",
    blockNumber: rc ? Number(BigInt(rc.blockNumber)) : null, timestamp: block ? new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() : null,
    from: tx.from, to: tx.to, contractCreated: rc?.contractAddress || null, valueEth: fmt(BigInt(tx.value), 18),
    methodSelector: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null,
    gasUsed: gasUsed?.toString() ?? null, feeEth: gasUsed != null && price != null ? fmt(gasUsed * price, 18) : null,
    logCount: rc?.logs?.length ?? 0, erc20Transfers: transfers };
}

// ---- Domain email/DNS health via DNS-over-HTTPS ----
async function doh(name, type) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  const j = await r.json(); return (j.Answer || []).filter(a => a.type === { A: 1, AAAA: 28, MX: 15, TXT: 16, NS: 2, CAA: 257 }[type]).map(a => a.data);
}
export const isDomain = d => /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d || "");
export async function domainCheck(domain) {
  domain = domain.toLowerCase();
  const unq = t => t.replace(/^"|"$/g, "").replace(/" "/g, "");
  const [a, aaaa, mx, txt, ns, dmarcTxt, caa] = await Promise.all([doh(domain, "A"), doh(domain, "AAAA"), doh(domain, "MX"), doh(domain, "TXT"), doh(domain, "NS"), doh("_dmarc." + domain, "TXT"), doh(domain, "CAA")]);
  const txts = txt.map(unq), spf = txts.filter(t => /^v=spf1/i.test(t)), dmarc = dmarcTxt.map(unq).find(t => /^v=DMARC1/i.test(t)) || null;
  const mxs = mx.map(m => { const [p, h] = m.split(/\s+/); return { priority: +p, host: (h || "").replace(/\.$/, "") }; }).sort((x, y) => x.priority - y.priority);
  const dmarcPolicy = dmarc ? (dmarc.match(/;\s*p=(\w+)/i) || [])[1]?.toLowerCase() || null : null;
  const issues = [];
  const nullMx = mxs.length === 1 && !mxs[0].host;
  if (nullMx) issues.push("NULL_MX: domain explicitly accepts no email (RFC 7505)");
  else if (!mxs.length) issues.push("NO_MX: domain cannot receive email");
  if (!spf.length) issues.push("NO_SPF: senders can spoof this domain more easily");
  if (spf.length > 1) issues.push("MULTIPLE_SPF: invalid, only one SPF record is allowed");
  if (spf.some(s => /\+all\b/.test(s))) issues.push("SPF_PLUS_ALL: SPF allows every sender");
  if (!dmarc) issues.push("NO_DMARC");
  else if (dmarcPolicy === "none") issues.push("DMARC_POLICY_NONE: monitoring only, not enforced");
  if (!a.length && !aaaa.length) issues.push("NO_A_RECORD: no website address");
  const score = Math.max(0, 100 - issues.filter(i => !i.startsWith("NULL_MX")).length * 20);
  return { domain, a, aaaa, ns: ns.map(n => n.replace(/\.$/, "")), mx: mxs, spf: spf[0] || null, dmarc, dmarcPolicy, caa,
    verificationRecords: txts.filter(t => /verification|verify|site-verification/i.test(t)).length,
    emailSecurityScore: score, issues };
}

// ---- calldata decoder (selector lookup via openchain signature DB, verified by re-encoding) ----
import { decodeFunctionData, encodeFunctionData, parseAbiItem } from "viem";
const MAXU = (1n << 256n) - 1n;
const ser = v => typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(ser) : (v && typeof v === "object") ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)])) : v;
export const isHex = d => /^0x([0-9a-fA-F]{2})*$/.test(d || "") && d.length >= 10;
async function sigLookup(sel) {
  const r = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json(); return (j?.result?.function?.[sel] || []).map(x => x.name);
}
async function decodeOne(data, depth) {
  const sel = data.slice(0, 10).toLowerCase();
  const cands = await sigLookup(sel);
  for (const sig of cands) {
    try {
      const abi = [parseAbiItem("function " + sig)];
      const { args = [] } = decodeFunctionData({ abi, data });
      if (encodeFunctionData({ abi, args }).toLowerCase() !== data.toLowerCase()) continue; // reject collisions that don't round-trip
      const out = { selector: sel, signature: sig, args: ser(args) };
      const name = sig.split("(")[0], warnings = [];
      if ((name === "approve" || name === "increaseAllowance") && args[1] === MAXU) warnings.push("UNLIMITED_TOKEN_APPROVAL");
      if (name === "approve" && args[1] > 0n) warnings.push("TOKEN_APPROVAL: spender " + args[0] + " can move your tokens");
      if (name === "setApprovalForAll" && args[1] === true) warnings.push("APPROVE_ALL_NFTS: operator " + args[0] + " can move every NFT of this collection");
      if (/^permit/i.test(name)) warnings.push("PERMIT_SIGNATURE_GRANTS_ALLOWANCE");
      if (name === "transferOwnership" || name === "renounceOwnership") warnings.push("OWNERSHIP_CHANGE");
      if (name === "upgradeTo" || name === "upgradeToAndCall") warnings.push("CONTRACT_UPGRADE");
      if (warnings.length) out.warnings = warnings;
      if (depth < 1 && /^multicall$|^aggregate$|^execute$/.test(name)) {
        const inner = args.find(a => Array.isArray(a) && a.every(x => typeof x === "string" && x.startsWith("0x")));
        if (inner) out.calls = await Promise.all(inner.slice(0, 20).map(c => isHex(c) ? decodeOne(c, depth + 1).catch(() => ({ selector: c.slice(0, 10), signature: null })) : null));
      }
      return out;
    } catch { /* try next candidate */ }
  }
  return { selector: sel, signature: null, candidates: cands.slice(0, 5), note: "selector unknown or args did not decode" };
}
export async function decodeCalldata(data) { return decodeOne(data.trim(), 0); }

// ---- Base gas / fee snapshot with USD estimates (Chainlink ETH/USD feed on Base) ----
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
export async function gas(gasLimit) {
  const [gp, tip, hist, rd] = await cached("gas", 4000, () => Promise.all([
    rpc("eth_gasPrice", []), rpc("eth_maxPriorityFeePerGas", []).catch(() => "0x0"),
    rpc("eth_feeHistory", ["0xa", "latest", [25, 50, 75]]),
    cached("feedraw:" + ETH_USD_FEED, 60000, () => rpc("eth_call", [{ to: ETH_USD_FEED, data: "0xfeaf968c" }, "latest"]).catch(() => null))]));
  const gwei = h => Number(BigInt(h)) / 1e9;
  const baseFees = hist.baseFeePerGas.map(gwei);
  const ethUsd = rd && rd.length >= 2 + 64 * 2 ? Number(BigInt("0x" + rd.slice(2 + 64, 2 + 128))) / 1e8 : null;
  const gasPriceGwei = gwei(gp);
  const cost = units => { const eth = units * gasPriceGwei / 1e9; return { gas: units, eth: +eth.toPrecision(4), usd: ethUsd ? +(eth * ethUsd).toPrecision(3) : null }; };
  return { chain: "base", block: Number(BigInt(hist.oldestBlock)) + baseFees.length - 2, gasPriceGwei: +gasPriceGwei.toPrecision(4),
    baseFeeGwei: +baseFees.at(-1).toPrecision(4), maxPriorityFeeGwei: +gwei(tip).toPrecision(4),
    baseFeeTrend10Blocks: baseFees.map(x => +x.toPrecision(3)), ethUsd,
    estimatedCost: { ethTransfer: cost(21000), erc20Transfer: cost(65000), uniswapSwap: cost(180000), contractDeploy: cost(1500000), ...(gasLimit ? { custom: cost(gasLimit) } : {}) } };
}

// ---- ENS / Basename resolution (forward + reverse + common text records) ----
import { createPublicClient, http, fallback } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
// One client per provider; we walk them ourselves. viem's non-strict ENS calls return null on ANY revert, and some RPCs answer
// rate limits with a revert ("Internal error") -> false "no address". So: strict:true, and only a clean resolver revert counts as "none".
let ensClients;
const ENS_RPCS = () => [...(process.env.ETH_RPC_URL ? [process.env.ETH_RPC_URL] : []), "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org",
  "https://eth-mainnet.public.blastapi.io", "https://1rpc.io/eth"];
const ens = () => ensClients ||= ENS_RPCS().map(u => createPublicClient({ chain: mainnet, transport: http(u, { timeout: 10000, retryCount: 0 }) }));
const ensRpc = async (f, what) => { const errs = [];
  for (const c of ens()) { try { return await f(c); } catch (e) { const m = (e?.shortMessage || e?.message || "").slice(0, 160);
    if (/revert|ResolverNotFound|ResolverNotContract|no resolver/i.test(m) && !/internal error|http request|timeout|429|rate|limit|exceeded/i.test(m)) return null;
    errs.push(m.split("\n")[0].slice(0, 60)); } }
  throw new Error(`ENS rpc unavailable (${what}): ${errs.join(" | ")}`); };
export const isEnsName = n => /^[^\s\/:?#]{1,250}\.[a-z0-9-]{2,}$/i.test(n || "");
const TEXT_KEYS = ["avatar", "description", "url", "com.twitter", "com.github", "email"];
async function texts(name) { const vals = await Promise.all(TEXT_KEYS.map(k => ensRpc(c => c.getEnsText({ name, key: k, strict: true }), "text").catch(() => null)));
  return Object.fromEntries(TEXT_KEYS.map((k, i) => [k, vals[i]]).filter(([, v]) => v)); }
export async function resolveName(q) {
  if (isAddr(q)) {
    const name = await ensRpc(c => c.getEnsName({ address: q, strict: true }), "reverse");
    let verified = false, records = {};
    if (name) { const back = await ensRpc(c => c.getEnsAddress({ name: normalize(name), strict: true }), "forward-check"); verified = !!back && back.toLowerCase() === q.toLowerCase(); if (verified) records = await texts(normalize(name)); }
    return { query: q, type: "reverse", address: q, name, forwardVerified: verified, records };
  }
  let n; try { n = normalize(q); } catch { return { query: q, error: "invalid ENS name" }; }
  const address = await ensRpc(c => c.getEnsAddress({ name: n, strict: true }), "forward");
  return { query: q, type: "forward", name: n, address, records: address ? await texts(n) : {}, note: n.endsWith(".base.eth") ? "Basename resolved via ENS CCIP-read" : undefined };
}

// ---- Domain registration lookup via RDAP (WHOIS successor): age, registrar, expiry, status; flags new domains ----
export async function domainWhois(domain) {
  domain = domain.toLowerCase();
  // RDAP works on the registrable domain; try the name as given, then strip leading labels.
  const labels = domain.split("."); let r = null, tried = [];
  for (let i = 0; i <= labels.length - 2 && i < 3; i++) {
    const d = labels.slice(i).join("."); tried.push(d);
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(d)}`, { headers: { accept: "application/rdap+json", "user-agent": "NightshiftLabs-API/1.0 (+x402)" }, redirect: "follow", signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (res && res.ok) { r = { d, j: await res.json() }; break; }
    if (res && (res.status >= 500 || res.status === 429)) return { domain, error: `RDAP lookup failed (HTTP ${res.status})`, rdapAvailable: false };
  }
  if (!r) return { domain, rdapAvailable: false, note: "No RDAP record found (unregistered, or the TLD registry has no public RDAP service, e.g. some ccTLDs).", tried };
  const j = r.j, ev = Object.fromEntries((j.events || []).map(e => [e.eventAction, e.eventDate]));
  const vcardName = e => (e.vcardArray?.[1] || []).find(x => x[0] === "fn")?.[3] || null;
  const reg = (j.entities || []).find(e => (e.roles || []).includes("registrar"));
  const abuse = reg?.entities?.find(e => (e.roles || []).includes("abuse"));
  const abuseEmail = (abuse?.vcardArray?.[1] || []).find(x => x[0] === "email")?.[3] || null;
  const now = Date.now(), days = t => t ? Math.floor((now - Date.parse(t)) / 864e5) : null;
  const ageDays = days(ev.registration), expiresInDays = ev.expiration ? -days(ev.expiration) : null;
  const status = j.status || [], flags = [];
  if (ageDays != null && ageDays < 30) flags.push("NEW_DOMAIN_UNDER_30_DAYS");
  else if (ageDays != null && ageDays < 180) flags.push("YOUNG_DOMAIN_UNDER_6_MONTHS");
  if (expiresInDays != null && expiresInDays < 30) flags.push("EXPIRES_WITHIN_30_DAYS");
  if (status.some(s => /hold|pending delete|redemption/i.test(s))) flags.push("PROBLEM_STATUS");
  if (domain.split(".").some(l => l.startsWith("xn--"))) flags.push("PUNYCODE_IDN");
  return { domain, registrableDomain: r.d, rdapAvailable: true, registered: ev.registration || null, ageDays, expires: ev.expiration || null, expiresInDays,
    lastChanged: ev["last changed"] || null, registrar: reg ? vcardName(reg) : null, registrarIanaId: reg?.publicIds?.find(p => /IANA/i.test(p.type))?.identifier || null,
    registrarAbuseEmail: abuseEmail, status, nameservers: (j.nameservers || []).map(n => (n.ldhName || "").toLowerCase()), dnssec: j.secureDNS?.delegationSigned ?? null, flags };
}

// ---- Base portfolio: ETH + major tokens, USD values from Chainlink feeds on Base ----
const PORTFOLIO_TOKENS = [
  ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "USD"], ["USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 6, "USD"],
  ["DAI", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18, "USD"], ["EURC", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", 6, null],
  ["WETH", "0x4200000000000000000000000000000000000006", 18, "ETH"], ["cbETH", "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", 18, null],
  ["wstETH", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", 18, null], ["cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8, "BTC"],
  ["AERO", "0x940181a94A35A4569E4529A3CDfB74e38FD98631", 18, null], ["DEGEN", "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", 18, null],
  ["VIRTUAL", "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", 18, null], ["BRETT", "0x532f27101965dd16442E59d40670FaF5eBB142E4", 18, null],
];
export const PORTFOLIO_SYMBOLS = PORTFOLIO_TOKENS.map(t => t[0]);
const FEEDS = { ETH: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", BTC: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" };
// tiny per-isolate cache for hot, slowly-changing reads (cuts public-RPC load; failures are not cached)
const memo = new Map();
async function cached(key, ttlMs, fn) { const h = memo.get(key); if (h && Date.now() - h.t < ttlMs) return h.v; const v = await fn(); if (v != null) memo.set(key, { t: Date.now(), v }); return v; }
async function feed(addr) { return cached("feed:" + addr, 60000, async () => { const rd = await call(addr, "0xfeaf968c"); return rd && rd.length >= 2 + 64 * 2 ? Number(BigInt("0x" + rd.slice(2 + 64, 2 + 128))) / 1e8 : null; }); }
export async function portfolio(address) {
  const res = await rpcBatch([["eth_getBalance", [address, "latest"]], ["eth_blockNumber", []], ["eth_call", [{ to: FEEDS.ETH, data: "0xfeaf968c" }, "latest"]], ["eth_call", [{ to: FEEDS.BTC, data: "0xfeaf968c" }, "latest"]],
    ...PORTFOLIO_TOKENS.map(t => ["eth_call", [{ to: t[1], data: "0x70a08231" + pad(address) }, "latest"]])]);
  const fd = rd => rd && rd.length >= 2 + 64 * 2 ? Number(BigInt("0x" + rd.slice(2 + 64, 2 + 128))) / 1e8 : null;
  const [eth, blk] = res, ethUsd = fd(res[2]), btcUsd = fd(res[3]), bals = res.slice(4);
  if (eth == null || blk == null) throw new Error("Base RPC unavailable, retry shortly");
  const px = { USD: 1, ETH: ethUsd, BTC: btcUsd };
  const ethAmt = Number(BigInt(eth)) / 1e18, holdings = [];
  holdings.push({ symbol: "ETH", token: null, amount: fmt(BigInt(eth), 18), usd: ethUsd != null ? +(ethAmt * ethUsd).toFixed(2) : null });
  PORTFOLIO_TOKENS.forEach((t, i) => { const v = toBig(bals[i]); if (!v) return;
    const p = t[3] ? px[t[3]] : null, amt = Number(v) / 10 ** t[2];
    holdings.push({ symbol: t[0], token: t[1], amount: fmt(v, t[2]), usd: p != null ? +(amt * p).toFixed(2) : null }); });
  const priced = holdings.filter(h => h.usd != null);
  return { chain: "base", address, block: Number(BigInt(blk)), holdings: holdings.filter(h => h.symbol === "ETH" || h.amount !== "0"),
    totalUsdPriced: +priced.reduce((s, h) => s + h.usd, 0).toFixed(2), prices: { ETH: ethUsd, BTC: btcUsd, stablecoinsUSD: 1 },
    tokensChecked: ["ETH", ...PORTFOLIO_SYMBOLS],
    note: "USD values use Chainlink ETH/USD and BTC/USD feeds on Base; USD stablecoins at $1 nominal; other tokens are listed without a USD value. Only the listed major tokens are checked." };
}

// ---- URL / link safety pre-check (heuristic): look-alike brands, IDN, domain age, DNS, redirect chain ----
import { domainToUnicode } from "node:url";
const BRANDS = ["google", "gmail", "youtube", "microsoft", "outlook", "apple", "icloud", "amazon", "paypal", "facebook", "instagram", "whatsapp",
  "netflix", "github", "gitlab", "linkedin", "twitter", "telegram", "discord", "dropbox", "docusign", "adobe", "coinbase", "binance", "kraken", "metamask",
  "uniswap", "opensea", "phantom", "ledger", "trezor", "stripe", "chase", "wellsfargo", "bankofamerica", "revolut", "steam", "roblox", "openai",
  "anthropic", "claude", "chatgpt", "basescan", "etherscan", "ethereum", "solana", "walletconnect", "blockchain", "kucoin", "okx", "bybit", "cloudflare", "dhl", "fedex", "usps"];
const CONFUSE = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "rn": "m", "vv": "w",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ӏ": "l", "ɑ": "a", "ο": "o", "ν": "v", "ı": "i", "ɡ": "g" };
const skeleton = s => { s = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, ""); for (const [k, v] of Object.entries(CONFUSE)) s = s.split(k).join(v); return s; };
function lev(a, b) { if (Math.abs(a.length - b.length) > 2) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length]; }
const RISKY_TLDS = new Set(["zip", "mov", "top", "xyz", "click", "link", "rest", "cam", "icu", "buzz", "gq", "tk", "ml", "cf", "ga", "work", "support", "country", "kim", "loan", "men", "quest", "sbs", "cfd"]);
export async function urlCheck(u) {
  let url; try { url = new URL(u); } catch { return { url: u, error: "invalid url" }; }
  const host = url.hostname.toLowerCase(), uni = (() => { try { return domainToUnicode(host) || host; } catch { return host; } })();
  const labels = host.split("."), tld = labels.at(-1), regGuess = labels.slice(-2).join(".");
  const flags = [], brandMatches = [];
  if (!/^https?:$/.test(url.protocol)) flags.push("NON_HTTP_SCHEME");
  if (url.protocol === "http:") flags.push("NO_HTTPS");
  if (url.username || url.password) flags.push("CREDENTIALS_IN_URL (classic 'user@host' trick)");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) flags.push("RAW_IP_HOST");
  if (labels.some(l => l.startsWith("xn--"))) flags.push("PUNYCODE_IDN");
  if (/[^\x00-\x7f]/.test(uni) && /[a-z]/i.test(uni) && /[Ѐ-ӿͰ-Ͽ]/.test(uni)) flags.push("MIXED_SCRIPT_HOMOGLYPHS");
  if (RISKY_TLDS.has(tld)) flags.push("HIGH_ABUSE_TLD");
  if (labels.length >= 5) flags.push("MANY_SUBDOMAINS");
  if (host.length > 60) flags.push("VERY_LONG_HOSTNAME");
  // brand look-alikes: compare the skeleton of every label / hyphen part with known brands
  const regLabel = skeleton(domainToUnicodeSafe(labels.at(-2) || ""));
  const parts = new Set(uni.split(".").slice(0, -1).flatMap(l => [l, ...l.split("-")]).map(skeleton).filter(Boolean));
  for (const b of BRANDS) for (const p of parts) {
    const isReg = p === regLabel, exact = p === b;
    if (exact && isReg && p === (labels.at(-2) || "")) continue; // genuine-looking brand.tld (still check age below)
    if (exact && !isReg) { brandMatches.push({ brand: b, how: "brand name used in subdomain or hyphenated part of another domain" }); continue; }
    if (exact && isReg) { brandMatches.push({ brand: b, how: "homoglyph/look-alike characters" }); continue; }
    if (p.length >= 4 && lev(p, b) === 1 && b.length >= 5) brandMatches.push({ brand: b, how: "one character away (typosquat)" });
  }
  if (brandMatches.length) flags.push("BRAND_LOOKALIKE");
  const isIpHost = !!net.isIP(host.replace(/^\[|\]$/g, ""));
  const [who, a] = isIpHost ? [null, [host]] : await Promise.all([domainWhois(host).catch(() => null), doh(host, "A").catch(() => [])]);
  if (!a.length) flags.push("NO_DNS_A_RECORD");
  if (who?.flags) flags.push(...who.flags.filter(f => f !== "PUNYCODE_IDN"));
  // redirect chain (only for http/https; SSRF-guarded, max 5 hops, HEAD then GET fallback)
  const chain = []; let finalUrl = null;
  if (/^https?:$/.test(url.protocol) && !url.username) {
    try { let cur = await safeUrl(url.href);
      for (let i = 0; i < 5; i++) {
        const r = await fetch(cur, { method: "GET", redirect: "manual", headers: { "user-agent": "NightshiftLabs-LinkCheck/1.0" }, signal: AbortSignal.timeout(8000) });
        try { r.body?.cancel(); } catch {}
        chain.push({ url: cur.href, status: r.status }); const loc = r.headers.get("location");
        if (r.status >= 300 && r.status < 400 && loc) { cur = await safeUrl(new URL(loc, cur).href); continue; }
        finalUrl = cur.href; break; }
    } catch (e) { chain.push({ error: e.message }); }
    const reg = who?.registrableDomain || regGuess, fh = finalUrl ? new URL(finalUrl).hostname.toLowerCase() : null;
    if (fh && fh !== reg && !fh.endsWith("." + reg)) flags.push("REDIRECTS_TO_OTHER_DOMAIN");
  }
  const severe = ["BRAND_LOOKALIKE", "MIXED_SCRIPT_HOMOGLYPHS", "CREDENTIALS_IN_URL (classic 'user@host' trick)", "NEW_DOMAIN_UNDER_30_DAYS", "PROBLEM_STATUS"];
  const score = flags.reduce((s, f) => s + (f === "BRAND_LOOKALIKE" ? 50 : severe.includes(f) ? 35 : 10), 0);
  return { url: url.href, host, hostUnicode: uni !== host ? uni : undefined, verdict: score >= 50 ? "high_risk" : score >= 30 ? "suspicious" : score > 0 ? "minor_issues" : "no_red_flags",
    riskScore: Math.min(100, score), flags: [...new Set(flags)], brandLookalikes: brandMatches, domainAgeDays: who?.ageDays ?? null, registrar: who?.registrar ?? null,
    resolves: a.length > 0, redirectChain: chain, finalUrl,
    note: "Heuristic pre-check (no blocklist lookup). 'no_red_flags' does not prove a link is safe." };
}
function domainToUnicodeSafe(l) { try { return domainToUnicode(l) || l; } catch { return l; } }

// ---- Base token USD price from on-chain DEX quotes (Uniswap v3 QuoterV2 + Aerodrome), with $1k price impact ----
import { decodeFunctionResult, parseAbi } from "viem";
const QABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const AABI = parseAbi(["struct Route { address from; address to; bool stable; address factory; }", "function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)"]);
const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const WETH_B = "0x4200000000000000000000000000000000000006";
async function quote(route, tokenIn, amountIn) {
  try {
    if (route.dex === "uniswap-v3") {
      const r = await rpc("eth_call", [{ to: UNI_QUOTER, data: encodeFunctionData({ abi: QABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut: route.out, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }] }) }, "latest"]);
      return decodeFunctionResult({ abi: QABI, functionName: "quoteExactInputSingle", data: r })[0];
    }
    const r = await rpc("eth_call", [{ to: AERO_ROUTER, data: encodeFunctionData({ abi: AABI, functionName: "getAmountsOut", args: [amountIn, [{ from: tokenIn, to: route.out, stable: route.stable, factory: AERO_FACTORY }]] }) }, "latest"]);
    return decodeFunctionResult({ abi: AABI, functionName: "getAmountsOut", data: r }).at(-1);
  } catch { return null; }
}
export async function tokenPrice(token, retried = false) {
  const t = token.toLowerCase();
  if (t === USDC.toLowerCase()) return { chain: "base", token, symbol: "USDC", priceUsd: 1, note: "USDC is the quote currency." };
  const [decH, symH, ethUsd] = await Promise.all([call(token, "0x313ce567"), call(token, "0x95d89b41"), feed(FEEDS.ETH)]);
  const decimals = toBig(decH) != null ? Number(toBig(decH)) : null;
  if (decimals == null && !retried) { // re-ask without swallowing errors: RPC outage -> throw -> 503 (buyer not charged); a revert is a real answer
    let d2 = null; try { d2 = toBig(await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])); } catch (e) { if (!e.final) throw e; }
    if (d2 == null || Number(d2) > 36) { const code = await rpc("eth_getCode", [token, "latest"]);
      return { chain: "base", token, error: code === "0x" ? "no contract at this address on Base" : "not an ERC-20 token (no decimals())" }; }
    return tokenPrice(token, true); }
  if (decimals == null) throw new Error("rpc: token reads failing, retry");
  if (decimals > 36) return { chain: "base", token, error: "not an ERC-20 token (bad decimals())" };
  const one = 10n ** BigInt(decimals), routes = [];
  for (const out of t === WETH_B.toLowerCase() ? [USDC] : [USDC, WETH_B]) {
    for (const fee of [500, 3000, 10000]) routes.push({ dex: "uniswap-v3", fee, out });
    routes.push({ dex: "aerodrome", stable: false, out });
  }
  const toUsd = (route, amt) => amt == null ? null : route.out === USDC ? Number(amt) / 1e6 : ethUsd ? Number(amt) / 1e18 * ethUsd : null;
  const quotes = await Promise.all(routes.map(async r => ({ r, usd: toUsd(r, await quote(r, token, one)) })));
  const valid = quotes.filter(q => q.usd != null && q.usd > 0).sort((a, b) => b.usd - a.usd);
  const label = r => `${r.dex}${r.fee ? ` ${r.fee / 1e4}%` : ""} → ${r.out === USDC ? "USDC" : "WETH"}`;
  if (!valid.length) return { chain: "base", token, symbol: decodeString(symH), decimals, priceUsd: null, flags: ["NO_LIQUIDITY_FOUND"], note: "No Uniswap v3 or Aerodrome volatile pool against USDC/WETH answered a quote." };
  const best = valid[0], flags = [];
  // depth: sell ~$1,000 worth through the best route
  const sizeTokens = 1000 / best.usd, amt1k = BigInt(Math.max(1, Math.floor(sizeTokens * 10 ** Math.min(decimals, 15)))) * 10n ** BigInt(Math.max(0, decimals - 15));
  // quote the $1k sale on the top routes (not only the best 1-token route: a thin pool can show the best spot price but the worst depth)
  const deep = (await Promise.all(valid.slice(0, 4).map(async q => ({ r: q.r, got: toUsd(q.r, await quote(q.r, token, amt1k).catch(() => null)) }))))
    .filter(x => x.got != null).sort((a, b) => b.got - a.got)[0];
  const got = deep ? deep.got : null;
  const impact = got != null ? Math.max(0, 1 - got / 1000) : null;
  if (impact == null) flags.push("CANNOT_SELL_1K_USD");
  else if (impact > 0.1) flags.push("LOW_LIQUIDITY_OVER_10PCT_IMPACT_AT_1K");
  if (valid.length > 1 && valid[1].usd < best.usd * 0.9) flags.push("ROUTES_DISAGREE_OVER_10PCT");
  return { chain: "base", token, symbol: decodeString(symH), decimals, priceUsd: +best.usd.toPrecision(6), bestRoute: label(best.r),
    priceImpactSell1kUsd: impact == null ? null : +(impact * 100).toFixed(2) + "%", bestRouteFor1kSell: deep ? label(deep.r) : null, ethUsd,
    quotes: valid.map(q => ({ route: label(q.r), priceUsd: +q.usd.toPrecision(6) })), flags,
    note: "Executable sell price for 1 token (pool fee included) from live on-chain quotes; WETH routes converted with Chainlink ETH/USD. Not financial advice." };
}

// ---- EIP-712 typed-data "check before you sign" (Permit / DAI permit / Permit2 / Seaport / generic approvals) ----
import { hashTypedData } from "viem";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const SEAPORTS = new Set(["0x00000000000000adc04c56bf30ac9d3c0aaf14dc", "0x0000000000000068f116a894984e2db1123eb395", "0x00000000006c3852cbef3e08e8df289169ede581"]);
const U160 = (1n << 160n) - 1n, U48 = (1n << 48n) - 1n;
const big = v => { try { return v == null || v === "" ? null : BigInt(v); } catch { return null; } };
const lc = a => (typeof a === "string" ? a.toLowerCase() : a);
export function parseTypedData(input) {
  const td = typeof input === "string" ? JSON.parse(input) : input;
  if (!td || typeof td !== "object" || !td.types || !td.message || !td.primaryType) throw new Error("expected EIP-712 JSON with types, domain, primaryType and message (as passed to eth_signTypedData_v4)");
  return td;
}
export async function typedDataCheck(td, nowSec = Math.floor(Date.now() / 1000)) {
  const d = td.domain || {}, m = td.message, pt = td.primaryType, vc = lc(d.verifyingContract) || null;
  const chainId = d.chainId != null ? Number(d.chainId) : null;
  const warnings = [], grants = [], out = { primaryType: pt, kind: "unknown", domain: { name: d.name ?? null, version: d.version ?? null, chainId, verifyingContract: d.verifyingContract ?? null } };
  try { const types = { ...td.types }; delete types.EIP712Domain; out.digest = hashTypedData({ domain: d, types, primaryType: pt, message: m }); }
  catch (e) { out.digest = null; warnings.push("MALFORMED_TYPED_DATA: " + String(e.shortMessage || e.message).slice(0, 160)); }
  const meta = async t => (chainId === 8453 && isAddr(t)) ? await tokenMeta(lc(t)).catch(() => ({})) : {};
  const fmt = (amt, dec) => (amt != null && dec != null) ? Number(amt) / 10 ** dec : null;
  const exp = (t, label) => { const x = big(t); if (x == null) return null;
    if (x === 0n) return null;
    const s = Number(x); if (s > nowSec + 365 * 86400 || x >= U48) warnings.push(`LONG_LIVED_${label.toUpperCase()}: valid for more than a year`);
    if (s < nowSec) warnings.push(`EXPIRED_${label.toUpperCase()}`);
    return s >= 1e11 ? null : new Date(s * 1000).toISOString(); };
  const grant = async (token, spender, amount, expiresAt, extra = {}) => {
    const mt = await meta(token), unlimited = amount != null && amount >= U160;
    if (unlimited) warnings.push(`UNLIMITED_ALLOWANCE: ${spender} could move ALL your ${mt.symbol || token}`);
    grants.push({ token, symbol: mt.symbol ?? null, amount: amount?.toString() ?? null, amountFormatted: unlimited ? "unlimited" : fmt(amount, mt.decimals), unlimited, spender, expiresAt, ...extra }); };
  if (pt === "Permit" && "spender" in m && "value" in m) {
    out.kind = "erc2612_permit"; await grant(d.verifyingContract, m.spender, big(m.value), exp(m.deadline, "permit"), { owner: m.owner });
    warnings.push("OFFCHAIN_APPROVAL: signing lets the spender pull tokens with no on-chain approve() you can see in your wallet history");
  } else if (pt === "Permit" && "holder" in m && "allowed" in m) {
    out.kind = "dai_permit"; if (m.allowed === true || m.allowed === "true") await grant(d.verifyingContract, m.spender, MAXU, exp(m.expiry, "permit"), { owner: m.holder });
    else out.note = "allowed=false: this REVOKES the allowance";
  } else if ((pt === "PermitSingle" || pt === "PermitBatch") && vc === PERMIT2) {
    out.kind = pt === "PermitSingle" ? "permit2_allowance" : "permit2_allowance_batch";
    for (const det of [].concat(m.details || [])) await grant(det.token, m.spender, big(det.amount), exp(det.expiration, "permit2"));
    exp(m.sigDeadline, "signature");
  } else if ((pt === "PermitTransferFrom" || pt === "PermitBatchTransferFrom" || /^PermitWitness/.test(pt)) && vc === PERMIT2) {
    out.kind = "permit2_transfer";
    for (const p of [].concat(m.permitted || [])) await grant(p.token, m.spender, big(p.amount), exp(m.deadline, "signature"), { oneTimeTransfer: true });
  } else if (pt === "OrderComponents" && (SEAPORTS.has(vc) || ("offer" in m && "consideration" in m))) {
    out.kind = "seaport_order";
    const ITEM = ["NATIVE", "ERC20", "ERC721", "ERC1155", "ERC721_WITH_CRITERIA", "ERC1155_WITH_CRITERIA"];
    const off = lc(m.offerer), item = i => ({ itemType: ITEM[Number(i.itemType)] ?? String(i.itemType), token: i.token, identifierOrCriteria: String(i.identifierOrCriteria ?? ""), amount: String(i.startAmount ?? i.amount ?? ""), recipient: i.recipient });
    const give = (m.offer || []).map(item), cons = (m.consideration || []).map(item);
    const toYou = cons.filter(c => lc(c.recipient) === off), toOthers = cons.filter(c => lc(c.recipient) !== off);
    out.seaport = { offerer: m.offerer, youGive: give, youReceive: toYou, paidToOthers: toOthers, endTime: exp(m.endTime, "order") };
    if (give.length && !toYou.length) warnings.push("ZERO_PAYMENT_ORDER: you give away the offered items and receive NOTHING (classic NFT-drain phishing signature)");
    else if (give.length && toYou.every(c => big(c.amount) === 0n || big(c.amount) === 1n)) warnings.push("NEAR_ZERO_PAYMENT_ORDER: you receive almost nothing for the offered items");
    if (give.length > 3) warnings.push("BULK_LISTING: " + give.length + " items in one signature");
  } else {
    // generic: anything that names a spender/operator, or approves all
    const flat = []; (function walk(o, path) { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, path ? path + "." + k : k); else flat.push([path, o]); })(m, "");
    const sp = flat.filter(([k]) => /(^|\.)(spender|operator|delegate|delegatee|to|recipient)$/i.test(k));
    if (sp.length) { out.kind = "generic_with_counterparty"; out.counterparties = sp.map(([k, v]) => ({ field: k, value: v })); }
    if (flat.some(([k, v]) => /approved|allowed/i.test(k) && (v === true || v === "true"))) warnings.push("APPROVAL_FLAG_TRUE: this signature turns an approval ON");
    if (flat.some(([, v]) => big(v) != null && big(v) >= U160 && typeof v !== "boolean" && !String(v).startsWith("0x"))) warnings.push("HUGE_AMOUNT: a value ≥ 2^160 (usually means unlimited)");
    if (!sp.length && !warnings.length) out.kind = "generic";
  }
  if (grants.length && chainId === 8453) await Promise.all(grants.map(async g => { if (!isAddr(g.spender)) return;
    const code = await rpc("eth_getCode", [g.spender, "latest"]).catch(() => null);
    if (code == null) return; g.spenderIsContract = code !== "0x";
    if (!g.spenderIsContract) warnings.push(`SPENDER_IS_EOA: ${g.spender} is a plain wallet, not a contract (typical of drainer phishing)`); }));
  if (grants.length) out.grants = grants;
  if (vc === PERMIT2 && !/^Permit/.test(pt)) warnings.push("UNUSUAL_PERMIT2_TYPE");
  const high = warnings.some(w => /^(UNLIMITED|ZERO_PAYMENT|NEAR_ZERO|APPROVAL_FLAG_TRUE|HUGE_AMOUNT|SPENDER_IS_EOA)/.test(w));
  out.risk = high ? "high" : (grants.length || out.kind === "seaport_order" || out.kind === "generic_with_counterparty") ? "medium" : (warnings.some(w => w.startsWith("MALFORMED")) ? "unknown" : "low");
  out.summary = out.kind === "seaport_order" ? `Seaport order: you give ${out.seaport.youGive.length} item(s), receive ${out.seaport.youReceive.length} item(s)` :
    grants.length ? grants.map(g => `Lets ${g.spender} ${g.oneTimeTransfer ? "transfer" : "spend"} ${g.amountFormatted ?? g.amount} ${g.symbol || g.token}${g.expiresAt ? " until " + g.expiresAt : ""}`).join("; ") :
    out.note || `${pt} signature (${out.kind})`;
  out.warnings = [...new Set(warnings)];
  out.advice = out.risk === "high" ? "Do NOT sign unless you fully trust the spender/site and intend this exact grant." : out.risk === "medium" ? "Verify the spender/counterparty is the contract you intend to use." : "No approval or transfer pattern detected.";
  return out;
}

// ---- DNS lookup (DoH) ----
const DNS_TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2, CAA: 257, SOA: 6 };
export async function dnsLookup(name, types = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "CAA"]) {
  const res = await Promise.all(types.map(async t => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${t}&do=1`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
    const j = await r.json(); return [t, j];
  }));
  const out = { name, records: {}, dnssecValidated: null, status: null };
  for (const [t, j] of res) {
    out.status ??= ({ 0: "NOERROR", 2: "SERVFAIL", 3: "NXDOMAIN" })[j.Status] ?? String(j.Status);
    if (j.AD === true) out.dnssecValidated = true; else if (out.dnssecValidated === null) out.dnssecValidated = false;
    const ans = (j.Answer || []).filter(a => a.type === DNS_TYPES[t]).map(a => ({ data: a.data, ttl: a.TTL }));
    if (ans.length) out.records[t] = ans;
  }
  const txt = (out.records.TXT || []).map(r => r.data.replace(/^"|"$/g, "").replace(/" "/g, ""));
  out.hints = { hasMx: !!out.records.MX, spf: txt.find(t => /^v=spf1/i.test(t)) || null, caaIssuers: (out.records.CAA || []).map(r => r.data),
    verificationTokens: txt.filter(t => /verification|verify|site-verification/i.test(t)).map(t => t.split("=")[0]).slice(0, 10) };
  return out;
}

// ---- Website security headers audit ----
export async function headersAudit(u) {
  let url = await safeUrl(u), r, hops = [];
  for (let i = 0; i < 5; i++) {
    r = await fetch(url, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; NightshiftLabsBot/1.0; +https://nightshift-x402.nightshift-labs.workers.dev/llms.txt)" }, signal: AbortSignal.timeout(10000) });
    hops.push({ url: url.href, status: r.status });
    const loc = r.headers.get("location"); if (r.status >= 300 && r.status < 400 && loc) { url = await safeUrl(new URL(loc, url).href); continue; } break;
  }
  const h = n => r.headers.get(n), checks = [], add = (header, ok, sev, note, value) => checks.push({ header, present: value != null, value: value ?? null, ok, severity: ok ? "pass" : sev, note });
  const https = url.protocol === "https:";
  const hsts = h("strict-transport-security"), maxAge = +(/max-age=(\d+)/i.exec(hsts || "")?.[1] || 0);
  add("strict-transport-security", https && maxAge >= 15552000, "high", !https ? "page served over plain HTTP" : !hsts ? "missing HSTS" : maxAge < 15552000 ? "max-age below 180 days" : "ok", hsts);
  const csp = h("content-security-policy"), dir = n => (csp || "").split(";").map(x => x.trim()).find(x => x.toLowerCase().startsWith(n + " "));
  const scriptSrc = dir("script-src") || dir("default-src") || "", nonced = /'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(scriptSrc);
  const unsafeScript = (/'unsafe-inline'/.test(scriptSrc) && !nonced) || /'unsafe-eval'/.test(scriptSrc), wildScript = /(^|\s)(\*|https?:|data:)(\s|$)/.test(scriptSrc.replace(/^\S+/, ""));
  add("content-security-policy", !!csp && !!scriptSrc && !unsafeScript && !wildScript, csp ? "medium" : "high", !csp ? "missing CSP (XSS mitigation)" : !scriptSrc ? "CSP has no script-src/default-src (does not restrict scripts)" : unsafeScript ? "script-src allows unsafe-inline/unsafe-eval" : wildScript ? "script-src allows any origin/scheme" : "ok", csp);
  const xfo = h("x-frame-options"), fa = /frame-ancestors/i.test(csp || "");
  add("x-frame-options / frame-ancestors", !!xfo || fa, "medium", xfo || fa ? "ok" : "clickjacking protection missing", xfo ?? (fa ? "(CSP frame-ancestors)" : null));
  const xcto = h("x-content-type-options"); add("x-content-type-options", /nosniff/i.test(xcto || ""), "low", xcto ? "ok" : "missing nosniff", xcto);
  const rp = h("referrer-policy"); add("referrer-policy", !!rp && !/unsafe-url|no-referrer-when-downgrade/i.test(rp), "low", rp ? "ok" : "missing (browser default leaks paths cross-origin on some setups)", rp);
  const pp = h("permissions-policy"); add("permissions-policy", !!pp, "low", pp ? "ok" : "missing", pp);
  const coop = h("cross-origin-opener-policy"); add("cross-origin-opener-policy", !!coop, "info", coop ? "ok" : "missing (optional)", coop);
  const leaks = ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version"].map(n => [n, h(n)]).filter(([, v]) => v && /\d/.test(v));
  for (const [n, v] of leaks) add(n, false, "low", "discloses software version", v);
  const cookies = (r.headers.getSetCookie?.() || []).map(c => ({ name: c.split("=")[0], secure: /;\s*secure/i.test(c), httpOnly: /;\s*httponly/i.test(c), sameSite: /samesite=(\w+)/i.exec(c)?.[1] || null }));
  for (const c of cookies) if (!c.secure || !c.httpOnly) add("set-cookie " + c.name, false, "medium", `cookie missing ${[!c.secure && "Secure", !c.httpOnly && "HttpOnly"].filter(Boolean).join(" + ")}`, null);
  const weights = { high: 25, medium: 12, low: 4, info: 0, pass: 0 };
  const score = Math.max(0, 100 - checks.reduce((s, c) => s + weights[c.severity], 0));
  return { url: u, finalUrl: url.href, status: r.status, redirects: hops, https, score, grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
    failed: checks.filter(c => !c.ok).map(c => `${c.severity.toUpperCase()}: ${c.header} — ${c.note}`), checks, cookies };
}
