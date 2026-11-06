// x402 seller preflight: fetch the endpoint unpaid, parse the 402 (v2 header or v1 body) and check the terms before paying.
import { rpc, call, pad, decodeString, fmt, safeUrl, isAddr, USDC } from "./lib.mjs";

const NETS = { "eip155:8453": ["base", false], base: ["base", false], "eip155:84532": ["base-sepolia", true], "base-sepolia": ["base-sepolia", true],
  "eip155:1": ["ethereum", false], "eip155:137": ["polygon", false], "eip155:42161": ["arbitrum", false], "eip155:10": ["optimism", false], "eip155:43114": ["avalanche", false],
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": ["solana", false], solana: ["solana", false], "solana-devnet": ["solana-devnet", true], "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": ["solana-devnet", true] };

// On-chain activity of a seller's payTo: incoming native-USDC transfers on Base over the last `days` days.
// Base blocks are ~0.2 s (measured each call, not assumed). publicnode caps eth_getLogs at 50k blocks (~2.8 h) -> sequential chunks.
// Workers allow 50 subrequests per request, and latency matters, so the scanned window is capped at MAX_CHUNKS chunks (~11 h); the response states the hours covered.
const LOG_RPC = "https://base-rpc.publicnode.com", TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CH = 50000, MAX_CHUNKS = 4, LOG_BUDGET = 12;
async function logRpc(method, params, url = LOG_RPC) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "NightshiftLabs/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
export async function payToActivity(payTo, priceAtomic, days = 3) {
  const head = Number(BigInt(await logRpc("eth_blockNumber", [])));
  let bt = 0.2; // seconds per block, measured below (fallback 0.2)
  try { const ts = async n => Number(BigInt((await logRpc("eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp));
    const m = (await ts(head) - await ts(head - 100000)) / 100000; if (m > 0.05 && m < 5) bt = m; } catch {}
  const wanted = Math.ceil(days * 86400 / bt), span = Math.min(wanted, CH * MAX_CHUNKS), from = head - span + 1, ranges = [];
  for (let b = from; b <= head; b += CH) ranges.push([b, Math.min(b + CH - 1, head)]);
  let failed = 0, lastErr = null, budget = LOG_BUDGET, keyed = globalThis.process?.env?.BASE_RPC_URL;
  const res = [];
  for (const [a, b] of ranges.reverse()) { // newest first; sequential: shared Cloudflare egress IPs hit publicnode's rate limit when parallel
    const q = [{ address: USDC, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [TRANSFER, null, "0x" + pad(payTo)] }];
    let got = null;
    if (keyed && budget > 0) { budget--; try { got = await logRpc("eth_getLogs", q, keyed); } catch (e) { keyed = null; lastErr = "keyed: " + String(e.message || e).slice(0, 80); } }
    if (got == null && budget > 0) { budget--; try { got = await logRpc("eth_getLogs", q); } catch (e) { lastErr = String(e.message || e).slice(0, 120); } }
    // (s30: drpc / Alchemy free tiers no longer accept useful getLogs ranges; publicnode only, paced to avoid its rate limit)
    if (got == null && budget > 0) { await new Promise(r => setTimeout(r, 700)); budget--; try { got = await logRpc("eth_getLogs", q); } catch (e) { lastErr = String(e.message || e).slice(0, 120); } }
    await new Promise(r => setTimeout(r, 200));
    if (got == null) failed++; else res.push(got);
  }
  if (failed === ranges.length) throw new Error(lastErr || "all log queries failed");
  const partial = failed > 0, windowHours = +(span * bt / 3600).toFixed(1);
  const logs = res.flat(), payers = new Map(); let total = 0n, atPrice = 0, last = null;
  for (const l of logs) {
    const v = BigInt(l.data), from = "0x" + l.topics[1].slice(26), bn = Number(BigInt(l.blockNumber));
    total += v; payers.set(from, (payers.get(from) || 0) + 1); if (priceAtomic && v === BigInt(priceAtomic)) atPrice++; if (last == null || bn > last) last = bn;
  }
  const top = [...payers.values()].sort((x, y) => y - x)[0] || 0;
  return { windowDays: days, windowHoursCovered: windowHours, ...(span < wanted ? { windowCapped: true } : {}), incomingUsdcTransfers: logs.length, distinctPayers: payers.size, totalUsdc: fmt(total, 6),
    transfersAtAdvertisedPrice: atPrice, topPayerShare: logs.length ? +(top / logs.length).toFixed(2) : null,
    lastIncomingHoursAgo: last == null ? null : +(((head - last) * bt) / 3600).toFixed(1), partial, ...(partial ? { failedChunks: failed, hoursActuallyScanned: +(((ranges.length - failed) * CH) * bt / 3600).toFixed(1), chunkError: lastErr } : {}),
    note: "Incoming native-USDC transfers to payTo on Base (any sender, not only x402 settlements) over windowHoursCovered hours (max ~11 h per call)." + (span < wanted ? " Requested window was longer than the per-call cap." : "") + " transfersAtAdvertisedPrice counts transfers equal to this endpoint's price." };
}

export async function x402Preflight(u, method = "GET", opts = {}) {
  let url = await safeUrl(u), r;
  const hops = [], t0 = Date.now();
  for (let i = 0; i < 4; i++) {
    r = await fetch(url, { method, redirect: "manual", body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(12000),
      headers: { "user-agent": "NightshiftLabs-x402-preflight/1.0", accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) } });
    hops.push({ url: url.href, status: r.status });
    const loc = r.headers.get("location"); if (r.status >= 300 && r.status < 400 && loc) { url = await safeUrl(new URL(loc, url).href); continue; } break;
  }
  const latencyMs = Date.now() - t0, issues = [], warn = (severity, code, detail) => issues.push({ severity, code, detail });
  const text = await r.text().catch(() => ""); let body = null; try { body = JSON.parse(text); } catch {}
  let pr = null, transport = null;
  const hdr = r.headers.get("payment-required");
  if (hdr) { try { pr = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); transport = "header (x402 v2)"; } catch { warn("high", "BAD_PAYMENT_REQUIRED_HEADER", "payment-required header is not base64 JSON"); } }
  if (!pr && body && Array.isArray(body.accepts)) { pr = body; transport = "body (x402 v1 style)"; }
  if (r.status !== 402) warn("high", "NOT_402", `unpaid ${method} returned HTTP ${r.status}, not 402` + (r.status === 405 ? " (try the other method)" : ""));
  if (!pr) {
    if (r.status === 402) warn("high", "NO_READABLE_TERMS", "402 without readable x402 payment requirements (no payment-required header, no accepts[] in body)");
    return { url: u, finalUrl: url.href, status: r.status, redirects: hops, latencyMs, x402: false, verdict: "fail", issues };
  }
  const accepts = Array.isArray(pr.accepts) ? pr.accepts : [];
  if (!accepts.length) warn("high", "EMPTY_ACCEPTS", "accepts[] is empty");
  const options = [];
  for (const a of accepts.slice(0, 6)) {
    const [chain, testnet] = NETS[a.network] || [String(a.network), null];
    const o = { scheme: a.scheme, network: a.network, chain, testnet, asset: a.asset, payTo: a.payTo, amountAtomic: String(a.amount ?? a.maxAmountRequired ?? ""), amountUsd: null,
      maxTimeoutSeconds: a.maxTimeoutSeconds ?? null, eip712: a.extra ? { name: a.extra.name ?? null, version: a.extra.version ?? null } : null, checks: [] };
    const c = (ok, code, detail) => o.checks.push({ ok, code, detail });
    if (a.scheme !== "exact") c(false, "UNCOMMON_SCHEME", `scheme ${a.scheme}: most clients only implement "exact"`);
    if (testnet) c(false, "TESTNET", "testnet payment option (no real value)");
    if (testnet == null) c(false, "UNKNOWN_NETWORK", `network ${a.network} not recognised`);
    if (!/^\d+$/.test(o.amountAtomic)) c(false, "BAD_AMOUNT", "amount missing or not an integer string");
    if (!o.maxTimeoutSeconds) c(false, "NO_MAX_TIMEOUT", "maxTimeoutSeconds missing");
    if (chain === "base") {
      if (!isAddr(a.asset) || !isAddr(a.payTo)) c(false, "BAD_ADDRESS", "asset or payTo is not an EVM address");
      else {
        const [code, nm, ver, payCode, nonce, bal] = await Promise.all([rpc("eth_getCode", [a.asset, "latest"]).catch(() => null), call(a.asset, "0x06fdde03"), call(a.asset, "0x54fd4d50"),
          rpc("eth_getCode", [a.payTo, "latest"]).catch(() => null), rpc("eth_getTransactionCount", [a.payTo, "latest"]).catch(() => null), call(USDC, "0x70a08231" + pad(a.payTo))]);
        const name = decodeString(nm), version = decodeString(ver);
        o.assetName = name; o.assetIsUsdc = a.asset.toLowerCase() === USDC.toLowerCase();
        if (code == null) c(true, "RPC_UNAVAILABLE", "could not read the asset contract on Base right now (RPC error): on-chain checks skipped, retry later");
        else if (code === "0x") c(false, "ASSET_NOT_A_CONTRACT", "asset has no code on Base: payment cannot settle");
        if (!o.assetIsUsdc) c(false, "ASSET_NOT_NATIVE_USDC", "asset is not native USDC on Base (0x8335…2913): check what token you are paying");
        if (o.eip712?.name && name && o.eip712.name !== name) c(false, "EIP712_NAME_MISMATCH", `extra.name "${o.eip712.name}" != token name() "${name}": signatures will fail (invalid_exact_evm_token_name_mismatch)`);
        if (o.eip712?.version && version && o.eip712.version !== version) c(false, "EIP712_VERSION_MISMATCH", `extra.version "${o.eip712.version}" != token version() "${version}"`);
        if (o.assetIsUsdc && /^\d+$/.test(o.amountAtomic)) { o.amountUsd = Number(o.amountAtomic) / 1e6; if (o.amountUsd > 1) c(false, "HIGH_PRICE", `asks $${o.amountUsd} per call`); }
        if (/^0x0{40}$/i.test(a.payTo) || /^0x0{36}dead$/i.test(a.payTo)) c(false, "PAYTO_BURN_ADDRESS", "payTo is a zero/burn address: money would be lost");
        o.payToIsContract = !!(payCode && payCode !== "0x"); o.payToTxCount = nonce ? Number(BigInt(nonce)) : null; o.payToUsdcBalance = bal ? fmt(BigInt(bal), 6) : null;
        if (o.payToIsContract) c(true, "PAYTO_IS_CONTRACT", "payTo is a contract (smart wallet or splitter): usually fine");
      }
    }
    o.ok = o.checks.every(x => x.ok); options.push(o);
  }
  const ext = pr.extensions || {}, resource = pr.resource || null;
  if (!ext.bazaar && !accepts.some(a => a.outputSchema)) warn("low", "NO_DISCOVERY_METADATA", "no bazaar extension / output schema: buyers can't see the input/output format before paying");
  if (!resource?.description && !accepts.some(a => a.description)) warn("low", "NO_DESCRIPTION", "no resource description in the 402");
  const best = options.find(o => o.ok && !o.testnet && o.chain === "base") || options.find(o => o.ok);
  if (!best) warn("high", "NO_SAFE_OPTION", "no payment option passed all checks");
  let activity = null;
  if (best && best.chain === "base" && isAddr(best.payTo) && opts.activity !== false) {
    const pt = best.payTo;
    activity = await payToActivity(pt, best.amountAtomic, opts.days || 3).catch(e => ({ error: "on-chain payer history unavailable right now (public RPC limits), retry later", detail: String(e.message || e).slice(0, 300) }));
    if (activity && !activity.error && activity.distinctPayers === 0 && !activity.partial)
      warn("low", "NO_RECENT_PAYERS", `payTo received no USDC in the last ${activity.windowHoursCovered} h: new or unused seller (not a fault by itself)`);
  }
  const sev = issues.map(i => i.severity);
  return { url: u, finalUrl: url.href, status: r.status, redirects: hops, latencyMs, x402: true, x402Version: pr.x402Version ?? null, transport, resource, options, payToActivity: activity, issues,
    verdict: sev.includes("high") ? "fail" : options.some(o => !o.ok) || sev.includes("medium") ? "caution" : "ok",
    recommendedOption: best ? options.indexOf(best) : null,
    note: "Unpaid preflight: checks the advertised terms only. It does not pay, so it cannot prove the seller delivers after payment." };
}
