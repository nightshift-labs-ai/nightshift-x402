// Pays an x402 route from a THROWAWAY, UNFUNDED key (generated each run, never stored). Expected: server forwards the signed payment to the
// facilitator, facilitator rejects (insufficient funds) and the server answers 402 with an error — proves the verify path works end to end.
// usage: node test/paytest.mjs <url>
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const url = process.argv[2];
const account = privateKeyToAccount(generatePrivateKey());
const client = new x402Client(); registerExactEvmScheme(client, { signer: account });
const http = new x402HTTPClient(client);
const r1 = await fetch(url); console.log("1st:", r1.status);
const body1 = await r1.json().catch(() => null);
const pr = http.getPaymentRequiredResponse(n => r1.headers.get(n), body1);
console.log("requirements:", pr.accepts.map(a => `${a.scheme} ${a.network} ${a.amount} ${a.asset.slice(0, 10)} payTo ${a.payTo.slice(0, 8)}…`));
const payload = await http.createPaymentPayload(pr);
const headers = http.encodePaymentSignatureHeader(payload);
const t = Date.now(); const r2 = await fetch(url, { headers }); const txt = await r2.text();
console.log("2nd (paid, unfunded):", r2.status, `${Date.now() - t}ms`, txt.slice(0, 200));
for (const [k, v] of r2.headers) if (/payment/i.test(k)) { let d = v; try { d = JSON.stringify(JSON.parse(Buffer.from(v, "base64").toString())).slice(0, 300); } catch {} console.log("hdr", k, d); }
