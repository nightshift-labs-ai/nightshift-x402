// Paid MCP server (Streamable HTTP, stateless, JSON responses) at /mcp.
// Every paid HTTP route becomes one MCP tool. Payment is x402 over the MCP transport (@x402/mcp):
// an unpaid tools/call returns the x402 payment requirements inside the tool result; the client retries with _meta["x402/payment"].
// /mcp itself never answers HTTP 402.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPaymentWrapper } from "@x402/mcp";

export const toolName = p => p.replace(/^\/v1\//, "").replace(/[\/-]/g, "_");

export function mountMcp(app, { routes, api, resourceServer, noPay = false }) {
  const tools = Object.entries(routes).map(([k, v]) => {
    const [method, path] = k.split(" ");
    const info = v.extensions?.bazaar?.info?.input || {};
    const schema = v.extensions?.bazaar?.schema?.properties?.input?.properties?.[method === "GET" ? "queryParams" : "body"]
      || { type: "object", properties: {} };
    return { method, path, name: toolName(path), price: v.accepts[0].price, accepts: v.accepts, description: `${v.description} Price: ${v.accepts[0].price} USDC on Base per call (x402).`,
      inputSchema: { type: "object", ...schema }, example: info.queryParams ?? info.body ?? {} };
  });
  const byName = new Map(tools.map(t => [t.name, t]));
  const wrappers = new Map(); // tool name -> paid wrapper (plain data only, safe to share across requests on workerd)

  async function paidWrapper(t) {
    if (wrappers.has(t.name)) return wrappers.get(t.name);
    const a = t.accepts[0];
    const accepts = await resourceServer.buildPaymentRequirements({ scheme: a.scheme, network: a.network, payTo: a.payTo, price: a.price, maxTimeoutSeconds: a.maxTimeoutSeconds });
    const w = createPaymentWrapper(resourceServer, { accepts, resource: { url: `mcp://tool/${t.name}`, description: t.description, mimeType: "application/json", serviceName: "Nightshift Labs" } });
    wrappers.set(t.name, w); return w;
  }

  async function run(t, args) {
    let url = t.path, init = { method: t.method };
    if (t.method === "GET") { const q = new URLSearchParams(Object.entries(args || {}).filter(([, x]) => x != null).map(([k, x]) => [k, String(x)])).toString(); if (q) url += "?" + q; }
    else init = { method: t.method, headers: { "content-type": "application/json" }, body: JSON.stringify(args || {}) };
    const r = await api.request(url, init); const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(text), { userError: true });
    return { content: [{ type: "text", text }] };
  }

  function newServer(only) {
    const list = only ? tools.filter(t => t.name === only) : tools;
    const s = new Server({ name: "nightshift-labs", version: "1.0.0" }, { capabilities: { tools: {} },
      instructions: "Pay-per-call security and on-chain utilities (check links, domains, Base tokens, transactions, calldata and EIP-712 signatures before acting; prices, gas, portfolio, ENS, DNS, security headers, web page to Markdown). Each tool costs a fixed USDC amount on Base, paid with x402 over MCP (_meta \"x402/payment\"). Free previews: GET /samples. Operated by Nightshift Labs, an autonomous AI-agent-run business." });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }, _meta: { "x402/price": t.price, "x402/network": t.accepts[0].network } })) }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const t = byName.get(req.params.name); if (only && t?.name !== only) return { content: [{ type: "text", text: `this endpoint only serves ${only}; all tools: /mcp` }], isError: true };
      if (!t) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
      const handler = async (args) => { try { return await run(t, args); } catch (e) { if (e.userError) return { content: [{ type: "text", text: e.message }], isError: true }; throw e; } };
      if (noPay) return handler(req.params.arguments);
      const w = await paidWrapper(t);
      return w(handler)(req.params.arguments || {}, { _meta: req.params._meta });
    });
    return s;
  }

  const handle = async c => {
    const only = c.req.param("tool"); if (only && !byName.has(only)) return c.json({ error: "unknown tool", tools: tools.map(t => t.name) }, 404);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = newServer(only); await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  app.post("/mcp", handle);
  app.get("/mcp", c => c.json({ mcp: "Streamable HTTP (stateless). POST JSON-RPC here.", tools: tools.map(t => ({ name: t.name, price: t.price })), payment: "x402 over MCP (_meta x402/payment), USDC on Base" }));
  app.delete("/mcp", c => c.body(null, 405));
  // Single-tool MCP endpoints (smaller tool list for agents that need one capability): /mcp/<tool_name>
  app.post("/mcp/:tool", handle);
  app.get("/mcp/:tool", c => { const t = byName.get(c.req.param("tool")); return t ? c.json({ mcp: "Streamable HTTP (stateless), single tool. POST JSON-RPC here.", tool: t.name, price: t.price, description: t.description, allTools: "/mcp" }) : c.json({ error: "unknown tool" }, 404); });
  return tools;
}
