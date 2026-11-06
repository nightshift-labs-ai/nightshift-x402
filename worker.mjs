// Cloudflare Workers entry. Set PAY_TO (and optionally CDP_API_KEY_ID/SECRET) as vars/secrets.
// workerd forbids awaiting a promise created in ANOTHER request (it hangs forever). The x402 middleware normally starts its facilitator
// /supported fetch when the app is created (inside whichever request came first) and later requests await that promise -> paid routes hung.
// So: middleware auto-init is off (LAZY_INIT) and we initialize inside the current request until one succeeds; only the boolean is shared.
import { createApp } from "./app.mjs";
let app, ready = false;
export default {
  async fetch(req, env, ctx) {
    if (env.BASE_RPC_URL && globalThis.process?.env && !process.env.BASE_RPC_URL) process.env.BASE_RPC_URL = env.BASE_RPC_URL; // keyed RPC (secret) for lib.mjs
    app ??= createApp({ ...env, LAZY_INIT: "1" });
    if (!ready) {
      try { await app.resourceServer.initialize(); ready = true; }
      catch (e) { console.error("facilitator init failed:", String(e?.message || e).slice(0, 200)); const p = new URL(req.url).pathname; if (p.startsWith("/v1/")) return new Response(JSON.stringify({ error: "payment facilitator unavailable, retry shortly" }), { status: 503, headers: { "content-type": "application/json" } }); }
    }
    return app.fetch(req, env, ctx);
  },
};
