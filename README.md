# Nightshift x402 API: paid pre-checks for AI agents (USDC on Base)

Pay-per-call HTTP API and remote MCP server for agents. No account or API key: each call is paid with an
[x402](https://x402.org) micropayment ($0.003–$0.01 in USDC on Base). Run by Nightshift Labs, an autonomous
AI-agent-run business (the code and docs were written by an AI agent).

- **Base URL:** https://nightshift-x402.nightshift-labs.workers.dev (free index at `/`, `/openapi.json`, `/.well-known/x402`, `/llms.txt`)
- **Remote MCP server (streamable HTTP):** `https://nightshift-x402.nightshift-labs.workers.dev/mcp` — tools are paid per call via x402 (`@x402/mcp`)
- **Free samples:** `/samples` shows real example responses for every endpoint

## Endpoints

| Route | Price | What it does |
|---|---|---|
| `GET /v1/base/token-check` | $0.01 | Base token safety pre-check: name/symbol/decimals/supply, owner and renounce status, proxy implementation, privileged functions found in bytecode (mint, blackli |
| `GET /v1/base/token-price` | $0.005 | Live USD price of any ERC-20 token on Base from on-chain DEX quotes (Uniswap v3 0.05/0.3/1% pools and Aerodrome, against USDC and WETH; WETH converted with Chai |
| `GET /v1/base/balance` | $0.005 | Base wallet balances: native ETH and USDC for any address, with the block number they were read at. |
| `GET /v1/base/tx` | $0.005 | Decode a Base transaction: status, block time, from/to, ETH value, fee, method selector and every ERC-20 transfer with symbol and human amount |
| `GET /v1/domain/email-check` | $0.005 | Domain DNS and email-security check: A/AAAA, NS, MX (incl |
| `GET /v1/evm/decode-calldata` | $0.005 | Decode EVM transaction calldata before signing: finds the function signature (signature DB, verified by re-encoding to reject selector collisions), decodes all  |
| `POST /v1/evm/typed-data-check` | $0.01 | Check an EIP-712 signature request BEFORE signing (the JSON passed to eth_signTypedData_v4): detects ERC-2612 Permit, DAI permit, Uniswap Permit2 (allowance + t |
| `GET /v1/base/gas` | $0.005 | Base gas snapshot: gas price, base fee, priority fee, 10-block base-fee trend, ETH/USD (Chainlink) and estimated USD cost of an ETH transfer, ERC-20 transfer, s |
| `GET /v1/ens/resolve` | $0.005 | Resolve ENS and Basenames (name.eth, name.base.eth): name → address, or address → primary name with forward verification, plus text records (avatar, description |
| `GET /v1/domain/whois` | $0.005 | Domain registration lookup (RDAP, the official WHOIS successor): registration date and age in days, expiry, registrar and its abuse email, EPP status, nameserve |
| `GET /v1/domain/dns` | $0.003 | DNS lookup in one call: A, AAAA, CNAME, MX, TXT, NS and CAA records with TTLs (or just the types you ask for), NXDOMAIN status, DNSSEC validation, plus parsed h |
| `GET /v1/web/security-headers` | $0.005 | Website security-headers audit: follows redirects (SSRF-guarded) and grades the final page A–F on HSTS, Content-Security-Policy (script-src unsafe-inline/eval/w |
| `GET /v1/base/portfolio` | $0.01 | Base wallet portfolio: ETH plus 12 major Base tokens (USDC, USDbC, DAI, EURC, WETH, cbETH, wstETH, cbBTC, AERO, DEGEN, VIRTUAL, BRETT) with non-zero balances, U |
| `GET /v1/x402/preflight` | $0.005 | x402 seller preflight: check a paid endpoint BEFORE paying it |
| `GET /v1/wallet/screen` | $0.005 | Wallet / counterparty screen before you send funds or accept a payer: OFAC SDN sanctioned-address check (EVM list, refreshed from the 0xB10C OFAC dataset), addr |
| `GET /v1/web/brand` | $0.01 | Brand kit from a website: site name, logo candidates (JSON-LD logo, header/home-link image, inline SVG logo, apple-touch-icon/favicons, og:image), theme-color,  |
| `GET /v1/web/link-check` | $0.01 | Link / URL phishing pre-check before an agent opens, clicks or forwards a link: brand look-alikes (typosquats, homoglyphs, brand in subdomain), punycode and mix |
| `GET /v1/web/extract` | $0.005 | Fetch any public web page and return clean Markdown of the main content plus title, meta description, word count and absolute links |

## Use it

Any x402 client works. TypeScript with the official SDK:

```js
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const http = new x402HTTPClient(client);

const url = "https://nightshift-x402.nightshift-labs.workers.dev/v1/base/gas";
const r1 = await fetch(url);                                   // 402 + payment requirements
const req = http.getPaymentRequiredResponse(n => r1.headers.get(n), await r1.json());
const headers = http.encodePaymentSignatureHeader(await http.createPaymentPayload(req));
console.log(await (await fetch(url, { headers })).json());       // paid response
```

The payer only needs USDC on Base (EIP-3009 authorization; the facilitator pays gas).

MCP clients: add the remote server URL above. It is listed in the official MCP Registry as
`dev.workers.nightshift-labs.nightshift-x402/agent-safety` (see `mcp-registry/server.json`).

## Self-host

```bash
npm ci
PAY_TO=0xYourAddress PORT=8402 node server.mjs          # Node (PayAI facilitator by default)
# or Cloudflare Workers: wrangler secret put PAY_TO ; npx wrangler deploy
```

Optional: `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` (Coinbase CDP facilitator), `BASE_RPC_URL` (keyed RPC; free public RPCs are used as fallback).
Local testing without payments works only on testnet: `NETWORK=eip155:84532 TEST_NO_PAY=1`.

Code layout: `app.mjs` (Hono app + route table + x402 middleware), `lib.mjs` (chain/DNS/web logic, SSRF guard), `mcp.mjs` (MCP server),
`preflight.mjs`, `wallet.mjs`, `brand.mjs`, `server.mjs` (Node), `worker.mjs` (Workers).

## Limits

Heuristic checks (token risk, phishing, wallet screen) reduce risk but are not guarantees; responses state what was checked.
Licence: MIT.
