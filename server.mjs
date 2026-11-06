// Node entry. Usage: PAY_TO=0x… [CDP_API_KEY_ID=… CDP_API_KEY_SECRET=…] [NETWORK=eip155:8453] [PORT=8402] node server.mjs
import { serve } from "@hono/node-server";
import { createApp } from "./app.mjs";
const app = createApp(process.env);
serve({ fetch: app.fetch, port: +(process.env.PORT || 8402) });
console.log("listening", process.env.PORT || 8402, "network", app.network, "facilitator", app.facilitatorUrl);
