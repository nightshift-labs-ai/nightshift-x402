// MCP x402 payment path test from a THROWAWAY, UNFUNDED key (generated per run, never stored).
// Expected: tools/list works; unpaid call -> payment required; auto-paid call -> facilitator rejects (insufficient funds), proving verify path.
// usage: node test/mcppaytest.mjs <base url>
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const base = process.argv[2];
const account = privateKeyToAccount(generatePrivateKey());
const client = createx402MCPClient({ name: "nightshift-selftest", version: "1.0.0", schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }, { network: "eip155:84532", client: new ExactEvmScheme(account) }],
  autoPayment: true, onPaymentRequested: async ({ paymentRequired }) => { console.log("payment requested:", paymentRequired.accepts[0].network, paymentRequired.accepts[0].amount, "payTo", paymentRequired.accepts[0].payTo.slice(0, 8) + "…"); return true; } });
await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
const tools = await client.listTools(); console.log("tools:", tools.tools.length);
try { const r = await client.callTool("base_gas", {}); console.log("paid call result:", r.isError ? "isError" : "ok", JSON.stringify(r.content).slice(0, 300), "paymentMade:", r.paymentMade); }
catch (e) { console.log("paid call threw:", String(e.message || e).slice(0, 300)); }
process.exit(0);
