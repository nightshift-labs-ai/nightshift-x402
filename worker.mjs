// Cloudflare Workers entry. Set PAY_TO (and optionally CDP_API_KEY_ID/SECRET) as vars/secrets.
// workerd forbids awaiting a promise created in ANOTHER request (it hangs forever). The x402 middleware normally starts its facilitator
// /supported fetch when the app is created (inside whichever request came first) and later requests await that promise -> paid routes hung.
// So: middleware auto-init is off (LAZY_INIT) and we initialize inside the current request until one succeeds; only the boolean is shared.
import { createApp } from "./app.mjs";
import { DurableObject } from "cloudflare:workers";
// Demand log: one row per /v1/ request (time, method, path, status, paid header present, short user agent). No IPs, no query values.
export class ReqLog extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS r (ts INTEGER, m TEXT, p TEXT, st INTEGER, paid INTEGER, ua TEXT)"); }
  add(row) { this.sql.exec("INSERT INTO r VALUES (?,?,?,?,?,?)", row.ts, row.m, row.p, row.st, row.paid, row.ua);
    this.sql.exec("DELETE FROM r WHERE ts < ?", Date.now() - 45 * 864e5); }
  stats(hours) { const since = Date.now() - hours * 36e5;
    return { byRoute: this.sql.exec("SELECT p, st, paid, COUNT(*) n FROM r WHERE ts>=? GROUP BY p, st, paid ORDER BY n DESC", since).toArray(),
      byUa: this.sql.exec("SELECT ua, COUNT(*) n FROM r WHERE ts>=? GROUP BY ua ORDER BY n DESC LIMIT 30", since).toArray(),
      last: this.sql.exec("SELECT ts, m, p, st, paid, ua FROM r ORDER BY ts DESC LIMIT 40").toArray() }; }
}
const logStub = env => env.REQLOG?.get(env.REQLOG.idFromName("main"));
let app, ready = false;
export default {
  async fetch(req, env, ctx) {
    if (env.BASE_RPC_URL && globalThis.process?.env && !process.env.BASE_RPC_URL) process.env.BASE_RPC_URL = env.BASE_RPC_URL; // keyed RPC (secret) for lib.mjs
    app ??= createApp({ ...env, LAZY_INIT: "1" });
    if (!ready) {
      try { await app.resourceServer.initialize(); ready = true; }
      catch (e) { console.error("facilitator init failed:", String(e?.message || e).slice(0, 200)); const p = new URL(req.url).pathname; if (p.startsWith("/v1/")) return new Response(JSON.stringify({ error: "payment facilitator unavailable, retry shortly" }), { status: 503, headers: { "content-type": "application/json" } }); }
    }
    const u = new URL(req.url);
    if (u.pathname === "/_stats") {
      if (!env.STATS_KEY || u.searchParams.get("k") !== env.STATS_KEY) return new Response("not found", { status: 404 });
      return Response.json(await logStub(env).stats(Number(u.searchParams.get("h")) || 24));
    }
    const res = await app.fetch(req, env, ctx);
    if (u.pathname.startsWith("/v1/") && env.REQLOG) {
      const row = { ts: Date.now(), m: req.method, p: u.pathname.slice(0, 80), st: res.status,
        paid: req.headers.has("payment-signature") || req.headers.has("x-payment") ? 1 : 0, ua: (req.headers.get("user-agent") || "-").slice(0, 60) };
      ctx.waitUntil(logStub(env).add(row).catch(() => {}));
    }
    return res;
  },
};
