// Nightshift Labs x402 API app factory (runtime-agnostic). Config comes from env/bindings only:
//   PAY_TO (receive address), CDP_API_KEY_ID / CDP_API_KEY_SECRET (CDP facilitator), PORT, PUBLIC_URL
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { mountMcp } from "./mcp.mjs";
import { x402Preflight } from "./preflight.mjs";
import { walletScreen } from "./wallet.mjs";
import { brandExtract } from "./brand.mjs";
import { tokenCheck, balance, extract, isAddr, txDecode, isHash, domainCheck, isDomain, decodeCalldata, isHex, gas, resolveName, isEnsName, domainWhois, portfolio, urlCheck, tokenPrice, typedDataCheck, parseTypedData, dnsLookup, headersAudit } from "./lib.mjs";

export function createApp(env) {
const PAY_TO = env.PAY_TO;
if (!isAddr(PAY_TO)) throw new Error("PAY_TO must be set to an EVM address");
const NETWORK = env.NETWORK || "eip155:8453"; // Base mainnet
// CDP facilitator (needed for CDP Bazaar listing) if keys exist; else PayAI (keyless on Base mainnet within its free allowance).
const facilitatorConfig = env.CDP_API_KEY_ID
  ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
  : { url: env.FACILITATOR_URL || (NETWORK === "eip155:84532" ? "https://x402.org/facilitator" : "https://facilitator.payai.network") };
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig))
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

const accepts = price => [{ scheme: "exact", price, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }];
const routes = {
  "GET /v1/base/token-check": {
    accepts: accepts("$0.01"), mimeType: "application/json",
    description: "Base token safety pre-check: name/symbol/decimals/supply, owner and renounce status, proxy implementation, privileged functions found in bytecode (mint, blacklist, pause, fee setters, upgrade) and a heuristic risk level. Call before buying or accepting an unknown token on Base.",
    extensions: declareDiscoveryExtension({
      input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "ERC-20 token contract on Base" } }, required: ["address"] },
      output: { example: { chain: "base", symbol: "USDC", decimals: 6, owner: "0x3abd…", proxyImplementation: "0x2ce6…", flags: ["UPGRADEABLE_PROXY", "HAS_MINT_FUNCTION", "HAS_BLACKLIST", "PAUSABLE", "ACTIVE_OWNER"], heuristicRisk: "elevated" } },
    }),
  },
  "GET /v1/base/token-price": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Live USD price of any ERC-20 token on Base from on-chain DEX quotes (Uniswap v3 0.05/0.3/1% pools and Aerodrome, against USDC and WETH; WETH converted with Chainlink ETH/USD). Returns the best executable route, every route's price, the price impact of selling $1,000, and flags for thin liquidity or disagreeing pools.",
    extensions: declareDiscoveryExtension({
      input: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
      inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "ERC-20 token contract on Base" } }, required: ["address"] },
      output: { example: { chain: "base", symbol: "AERO", decimals: 18, priceUsd: 0.605941, bestRoute: "uniswap-v3 0.05% → USDC", priceImpactSell1kUsd: "0.45%", quotes: [{ route: "uniswap-v3 0.05% → USDC", priceUsd: 0.605941 }], flags: [] } },
    }),
  },
  "GET /v1/base/balance": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Base wallet balances: native ETH and USDC for any address, with the block number they were read at.",
    extensions: declareDiscoveryExtension({
      input: { address: "0x4200000000000000000000000000000000000006" },
      inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }, required: ["address"] },
      output: { example: { chain: "base", address: "0x4200…0006", eth: "283543.09", usdc: "179.137106", block: 53585397 } },
    }),
  },
  "GET /v1/base/tx": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Decode a Base transaction: status, block time, from/to, ETH value, fee, method selector and every ERC-20 transfer with symbol and human amount. Flags fake look-alike tokens (address-poisoning, e.g. a fake USDC with homoglyph characters).",
    extensions: declareDiscoveryExtension({
      input: { hash: "0x0f46ecb16e85da8c24f57749d1b1b71e6904ccb9df741e230070338fe5678e9e" },
      inputSchema: { type: "object", properties: { hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } }, required: ["hash"] },
      output: { example: { status: "success", from: "0x1da8…", feeEth: "0.00000015", erc20Transfers: [{ symbol: "USDC", amount: "200.05", warning: "IMPERSONATES_USDC_WITH_LOOKALIKE_CHARACTERS" }] } },
    }),
  },
  "GET /v1/domain/email-check": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Domain DNS and email-security check: A/AAAA, NS, MX (incl. null MX), SPF, DMARC policy, CAA, plus a list of issues and a 0-100 email security score. Use before sending email to or trusting a domain.",
    extensions: declareDiscoveryExtension({
      input: { domain: "github.com" },
      inputSchema: { type: "object", properties: { domain: { type: "string", description: "domain name, e.g. example.com" } }, required: ["domain"] },
      output: { example: { domain: "github.com", mx: [{ priority: 0, host: "github-com.mail.protection.outlook.com" }], dmarcPolicy: "quarantine", emailSecurityScore: 100, issues: [] } },
    }),
  },
  "GET /v1/evm/decode-calldata": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Decode EVM transaction calldata before signing: finds the function signature (signature DB, verified by re-encoding to reject selector collisions), decodes all arguments, expands multicall batches, and warns about unlimited token approvals, approve-all-NFTs, permits, ownership changes and upgrades. Works for any EVM chain.",
    extensions: declareDiscoveryExtension({
      input: { data: "0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
      inputSchema: { type: "object", properties: { data: { type: "string", pattern: "^0x([0-9a-fA-F]{2})+$", description: "hex calldata (selector + ABI-encoded args), max 16 KB" } }, required: ["data"] },
      output: { example: { selector: "0x095ea7b3", signature: "approve(address,uint256)", args: ["0x000000000022D473030F116dDEE9F6B43aC78BA3", "115792089237316195423570985008687907853269984665640564039457584007913129639935"], warnings: ["UNLIMITED_TOKEN_APPROVAL"] } },
    }),
  },
  "POST /v1/evm/typed-data-check": {
    accepts: accepts("$0.01"), mimeType: "application/json",
    description: "Check an EIP-712 signature request BEFORE signing (the JSON passed to eth_signTypedData_v4): detects ERC-2612 Permit, DAI permit, Uniswap Permit2 (allowance + transfer) and Seaport orders, explains in one line what the signature grants, and flags drainer patterns: unlimited allowances, spender that is a plain wallet (EOA, checked on Base), zero-payment NFT listings, bulk listings, never-expiring grants. Returns risk (low/medium/high), grants, warnings and the EIP-712 digest.",
    extensions: declareDiscoveryExtension({
      method: "POST", bodyType: "json",
      input: { types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, primaryType: "Permit",
        message: { owner: "0x1111111111111111111111111111111111111111", spender: "0x2222222222222222222222222222222222222222", value: "115792089237316195423570985008687907853269984665640564039457584007913129639935", nonce: "0", deadline: "1893456000" } },
      inputSchema: { type: "object", properties: { types: { type: "object", description: "EIP-712 type definitions" }, domain: { type: "object", description: "EIP-712 domain (name, version, chainId, verifyingContract)" },
        primaryType: { type: "string" }, message: { type: "object", description: "the message to be signed" } }, required: ["types", "primaryType", "message"] },
      output: { example: { primaryType: "Permit", kind: "erc2612_permit", risk: "high", summary: "Lets 0x2222…2222 spend unlimited USDC",
        grants: [{ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", amountFormatted: "unlimited", unlimited: true, spender: "0x2222222222222222222222222222222222222222", spenderIsContract: false }],
        warnings: ["UNLIMITED_ALLOWANCE: … could move ALL your USDC", "SPENDER_IS_EOA: … is a plain wallet, not a contract (typical of drainer phishing)"], advice: "Do NOT sign unless you fully trust the spender/site and intend this exact grant.", digest: "0x…" } },
    }),
  },
  "GET /v1/base/gas": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Base gas snapshot: gas price, base fee, priority fee, 10-block base-fee trend, ETH/USD (Chainlink) and estimated USD cost of an ETH transfer, ERC-20 transfer, swap and contract deploy right now.",
    extensions: declareDiscoveryExtension({
      input: { gasLimit: "250000" },
      inputSchema: { type: "object", properties: { gasLimit: { type: "string", pattern: "^[0-9]{1,9}$", description: "optional: gas units of your own transaction; adds estimatedCost.custom (ETH + USD)" } } },
      output: { example: { chain: "base", gasPriceGwei: 0.006, baseFeeGwei: 0.005, ethUsd: 2259.98, estimatedCost: { ethTransfer: { gas: 21000, eth: 1.26e-7, usd: 0.000285 }, erc20Transfer: { gas: 65000, usd: 0.000881 } } } },
    }),
  },
  "GET /v1/ens/resolve": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Resolve ENS and Basenames (name.eth, name.base.eth): name → address, or address → primary name with forward verification, plus text records (avatar, description, url, twitter, github, email).",
    extensions: declareDiscoveryExtension({
      input: { q: "vitalik.eth" },
      inputSchema: { type: "object", properties: { q: { type: "string", description: "ENS/Basename (e.g. vitalik.eth, jesse.base.eth) or a 0x address for reverse lookup" } }, required: ["q"] },
      output: { example: { query: "vitalik.eth", type: "forward", name: "vitalik.eth", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", records: { url: "https://vitalik.ca" } } },
    }),
  },
  "GET /v1/domain/whois": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Domain registration lookup (RDAP, the official WHOIS successor): registration date and age in days, expiry, registrar and its abuse email, EPP status, nameservers, DNSSEC, and flags for brand-new (<30 days) or young domains, punycode/IDN names and expiring domains. Use to vet links, senders and counterparties (phishing domains are usually days old).",
    extensions: declareDiscoveryExtension({
      input: { domain: "github.com" },
      inputSchema: { type: "object", properties: { domain: { type: "string", description: "domain or host name, e.g. github.com or www.github.com" } }, required: ["domain"] },
      output: { example: { domain: "github.com", registered: "2007-10-09T18:20:50Z", ageDays: 6967, expires: "2028-10-09T18:20:50Z", registrar: "MarkMonitor Inc.", registrarAbuseEmail: "abusecomplaints@markmonitor.com", dnssec: false, flags: [] } },
    }),
  },
  "GET /v1/domain/dns": {
    accepts: accepts("$0.003"), mimeType: "application/json",
    description: "DNS lookup in one call: A, AAAA, CNAME, MX, TXT, NS and CAA records with TTLs (or just the types you ask for), NXDOMAIN status, DNSSEC validation, plus parsed hints: SPF record, CAA certificate issuers and which services the domain is verified with (TXT verification tokens). Resolved via DNS-over-HTTPS.",
    extensions: declareDiscoveryExtension({
      input: { name: "github.com", types: "A,MX,TXT" },
      inputSchema: { type: "object", properties: { name: { type: "string", description: "domain or host name" }, types: { type: "string", description: "optional comma list of A,AAAA,CNAME,MX,TXT,NS,CAA,SOA (default: all but SOA)" } }, required: ["name"] },
      output: { example: { name: "github.com", status: "NOERROR", dnssecValidated: false, records: { A: [{ data: "140.82.121.3", ttl: 46 }], MX: [{ data: "0 github-com.mail.protection.outlook.com.", ttl: 300 }] }, hints: { hasMx: true, spf: "v=spf1 ip4:192.30.252.0/22 include:_netblocks.google.com … ~all", caaIssuers: [], verificationTokens: ["adobe-idp-site-verification"] } } },
    }),
  },
  "GET /v1/web/security-headers": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Website security-headers audit: follows redirects (SSRF-guarded) and grades the final page A–F on HSTS, Content-Security-Policy (script-src unsafe-inline/eval/wildcards), clickjacking protection, nosniff, Referrer-Policy, Permissions-Policy, COOP, version-leaking Server/X-Powered-By headers and cookie Secure/HttpOnly/SameSite flags. Returns a score, a list of failed checks with severity, and every header value.",
    extensions: declareDiscoveryExtension({
      input: { url: "https://github.com" },
      inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL of a public site" } }, required: ["url"] },
      output: { example: { url: "https://github.com", finalUrl: "https://github.com/", status: 200, https: true, score: 84, grade: "B", failed: ["LOW: permissions-policy — missing", "MEDIUM: set-cookie _octo — cookie missing HttpOnly"] } },
    }),
  },
  "GET /v1/base/portfolio": {
    accepts: accepts("$0.01"), mimeType: "application/json",
    description: "Base wallet portfolio: ETH plus 12 major Base tokens (USDC, USDbC, DAI, EURC, WETH, cbETH, wstETH, cbBTC, AERO, DEGEN, VIRTUAL, BRETT) with non-zero balances, USD values from Chainlink ETH/USD and BTC/USD feeds, and a total.",
    extensions: declareDiscoveryExtension({
      input: { address: "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A" },
      inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "wallet address on Base" } }, required: ["address"] },
      output: { example: { chain: "base", holdings: [{ symbol: "ETH", amount: "2.9999", usd: 6734.6 }, { symbol: "USDC", amount: "79709.10502", usd: 79709.11 }, { symbol: "AERO", amount: "3.0187", usd: null }], totalUsdPriced: 86463.08, prices: { ETH: 2244.94, BTC: 75826.24 } } },
    }),
  },
  "GET /v1/x402/preflight": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "x402 seller preflight: check a paid endpoint BEFORE paying. Probes it unpaid, parses the 402 (v2 header or v1 body) and checks each option: scheme, network, asset is real USDC on Base, EIP-712 name/version match on-chain, payTo not a burn address, amount, timeout, discovery metadata. Plus on-chain seller reputation: recent USDC payments to payTo (last ~11 h: distinct payers, total, last payment). Returns verdict ok/caution/fail, issues and the recommended option.",
    extensions: declareDiscoveryExtension({
      input: { url: "https://api.agentstools.dev/weather", method: "GET" },
      inputSchema: { type: "object", properties: { url: { type: "string", description: "https URL of the x402-paid endpoint" }, method: { type: "string", enum: ["GET", "POST"], description: "HTTP method to probe (default GET)" }, days: { type: "integer", minimum: 1, maximum: 7, description: "on-chain payer history window in days (default 3; at most ~11 h is scanned per call, see windowHoursCovered)" } }, required: ["url"] },
      output: { example: { status: 402, x402: true, x402Version: 2, transport: "header (x402 v2)", verdict: "ok", recommendedOption: 0, options: [{ scheme: "exact", chain: "base", amountUsd: 0.005, assetIsUsdc: true, assetName: "USD Coin", eip712: { name: "USD Coin", version: "2" }, ok: true, checks: [] }], payToActivity: { windowDays: 3, incomingUsdcTransfers: 50, distinctPayers: 4, totalUsdc: "0.23", transfersAtAdvertisedPrice: 44, topPayerShare: 0.69, lastIncomingHoursAgo: 50.8, partial: false }, issues: [] } },
    }),
  },
  "GET /v1/wallet/screen": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Wallet / counterparty screen before you send funds or accept a payer: OFAC SDN sanctioned-address check (EVM list, refreshed from the 0xB10C OFAC dataset), address type (EOA, EIP-7702 delegated, contract, token contract), Base and Ethereum tx counts, ETH/USDC balances on Base, burn-address detection and an optional address-poisoning look-alike check against the address you expected (same first/last 4 hex). Verdict block/high_risk/caution/no_red_flags.",
    extensions: declareDiscoveryExtension({
      input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", expected: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
      inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "EVM address to screen" }, expected: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "optional: the address you meant to use (detects address-poisoning look-alikes)" } }, required: ["address"] },
      output: { example: { address: "0x0389…7e2c", verdict: "block", flags: ["OFAC_SANCTIONED"], sanctions: { listed: true, listSize: 123 }, kind: "eoa", base: { txCount: 0, eth: "0", usdc: "0" }, ethereum: { txCount: 16, isContract: false }, lookalike: null } },
    }),
  },
  "GET /v1/web/brand": {
    accepts: accepts("$0.01"), mimeType: "application/json",
    description: "Brand kit from a website: site name, logo candidates (JSON-LD logo, header/home-link image, inline SVG logo, apple-touch-icon/favicons, og:image), theme-color, CSS brand variables (--primary/--brand/--accent), dominant colors ranked by CSS frequency (non-neutral first), fonts (Google Fonts + CSS font families, system fonts removed) and social profile links. No rendering; flags bot-protected pages.",
    extensions: declareDiscoveryExtension({
      input: { url: "https://stripe.com" },
      inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL of the site (home page works best)" } }, required: ["url"] },
      output: { example: { name: "Stripe", themeColor: null, logos: [{ url: "https://images.stripeassets.com/…/favicon.svg", source: "json-ld" }], colors: { dominantNonNeutral: ["#635bff", "#32325d", "#533afd"] }, fonts: { googleFonts: [], cssFamilies: ["sohne-var", "SourceCodePro"] }, social: { "github.com": "https://github.com/stripe" } } },
    }),
  },
  "GET /v1/web/link-check": {
    accepts: accepts("$0.01"), mimeType: "application/json",
    description: "Link / URL phishing pre-check before an agent opens, clicks or forwards a link: brand look-alikes (typosquats, homoglyphs, brand in subdomain), punycode and mixed-script hosts, credentials-in-URL tricks, high-abuse TLDs, domain age via RDAP (new domains flagged), DNS resolution and the full redirect chain. Returns a verdict, a 0-100 risk score and the flags.",
    extensions: declareDiscoveryExtension({
      input: { url: "https://login-coinbase.secure-verify.xyz/a" },
      inputSchema: { type: "object", properties: { url: { type: "string", description: "the URL to check (http/https)" } }, required: ["url"] },
      output: { example: { url: "https://xn--pypal-4ve.com/", hostUnicode: "pаypal.com", verdict: "high_risk", riskScore: 80, flags: ["PUNYCODE_IDN", "MIXED_SCRIPT_HOMOGLYPHS", "BRAND_LOOKALIKE"], brandLookalikes: [{ brand: "paypal", how: "homoglyph/look-alike characters" }], domainAgeDays: 7959 } },
    }),
  },
  "GET /v1/web/extract": {
    accepts: accepts("$0.005"), mimeType: "application/json",
    description: "Fetch any public web page and return clean Markdown of the main content plus title, meta description, word count and absolute links. Strips scripts, navigation and boilerplate. Good for feeding pages to an LLM.",
    extensions: declareDiscoveryExtension({
      input: { url: "https://example.com", maxChars: "20000" },
      inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL of a public page" }, maxChars: { type: "string", description: "max markdown characters (default 20000, max 100000)" } }, required: ["url"] },
      output: { example: { url: "https://example.com/", status: 200, title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in…", truncated: false, wordCount: 30, links: [] } },
    }),
  },
};

const app = new Hono();
app.get("/", c => c.json({ service: "Nightshift Labs API", operator: "Nightshift Labs (an autonomous AI-agent-run business)", source: "https://github.com/nightshift-labs-ai/nightshift-x402", payment: "x402, USDC on Base", mcp: new URL(c.req.url).origin + "/mcp",
  endpoints: Object.entries(routes).map(([k, v]) => ({ route: k, price: v.accepts[0].price, description: v.description })) }));
app.get("/health", c => c.json({ ok: true }));
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#141b2d"/><path d="M40 12a20 20 0 1 0 12 34A16 16 0 0 1 40 12z" fill="#ffd166"/><circle cx="20" cy="18" r="2" fill="#fff"/><circle cx="14" cy="34" r="1.5" fill="#fff"/></svg>`;
for (const f of ["/favicon.ico", "/favicon.svg"]) app.get(f, c => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
app.get("/llms.txt", c => { const o = new URL(c.req.url).origin;
  return c.text(`# Nightshift Labs API\n\n> Pay-per-call utilities for AI agents: Base token safety, prices, portfolios, transaction, calldata and EIP-712 signature checks, gas, ENS, domain/link phishing checks, DNS lookup, website security-headers audit, web page extraction. Payment: x402 (USDC on Base), no account or API key.\n\nOperated by Nightshift Labs, an autonomous AI-agent-run business. Contact: nightshiftlabs-api@agentmail.to\n\n## Endpoints (GET = query parameters, POST = JSON body; unpaid requests get HTTP 402 with x402 payment requirements)\n\n` +
    Object.entries(routes).map(([k, v]) => `- ${k.split(" ")[0]} [${k.split(" ")[1]}](${o}${k.split(" ")[1]}) (${v.accepts[0].price}): ${v.description}`).join("\n") +
    `\n\n## Source\n\n- Open source (MIT): https://github.com/nightshift-labs-ai/nightshift-x402\n\n## Free samples\n\n- [All samples](${o}/samples): real output of every endpoint for its example input, e.g. ${o}/sample/v1/web/link-check\n\n## MCP\n\n- Paid MCP server (Streamable HTTP): ${o}/mcp — the same endpoints as MCP tools (e.g. web_link_check, evm_typed_data_check), paid with x402 over MCP (_meta \"x402/payment\", e.g. @x402/mcp client).\n\n## Machine-readable\n\n- [OpenAPI](${o}/openapi.json)\n- [x402 resource list](${o}/.well-known/x402)\n`); });
// Official MCP Registry HTTP domain auth (public key only; private key kept outside the repo).
app.get("/.well-known/mcp-registry-auth", c => c.text("v=MCPv1; k=ed25519; p=56bTKyRgncMFPC4++I9H5Y/MJwWPbB9JOg0oXCwaM04="));
app.get("/.well-known/x402-trust.txt", c => c.text("x402-trust-verification=v1:MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAbE-ML8D3Oq4076OtdCvcu4p7HNfC7yfPbTyFdhHZ8T6NmpGUW-PCRmgEGjA5_lmWPaibCof7sjSi4zyTvaE8A\n"));
app.get("/.well-known/402index-verify.txt", c => c.text("23d7fc95124cc83355a77225cb6ea1b5aa61ce251e0517bda56c20e2a45b9fe5"));
// Discovery documents for crawlers such as x402scan (generated from the route table).
// CDP facilitator rejects payment payloads whose resource.description is too long (730 chars failed, 479 ok) → keep ≤ 480.
for (const [k, r] of Object.entries(routes)) if (r.description.length > 480) throw new Error(`route description too long for CDP facilitator: ${k}`);
const paths = Object.keys(routes).map(k => k.split(" ")[1]);
app.get("/.well-known/x402", c => { const o = new URL(c.req.url).origin; return c.json({ version: 1, resources: paths.map(p => o + p) }); });
// Open 402 directory manifest (agentinternetruntime.com/spec/agent-json), generated from the route table.
app.get("/.well-known/agent.json", c => { const o = new URL(c.req.url).origin;
  return c.json({ version: "1.3", origin: new URL(o).host, display_name: "Nightshift Labs API",
    description: "Pay-per-call security and on-chain utilities for AI agents: check links, domains, Base tokens, transactions, calldata and EIP-712 signatures before acting; prices, gas, portfolio, ENS, DNS, security headers, web page to Markdown. Operated by an autonomous AI agent.",
    contact: "nightshiftlabs-api@agentmail.to", openapi: `${o}/openapi.json`, llms_txt: `${o}/llms.txt`,
    payout_address: PAY_TO,
    payments: { x402: { networks: [{ network: "base", asset: "USDC", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }] } },
    intents: Object.entries(routes).map(([k, v]) => { const [method, p] = k.split(" ");
      return { name: p.replace(/^\/v1\//, "").replace(/[^a-z0-9]+/gi, "_"), description: v.description, endpoint: p, method, sample_url: `${o}/sample${p}`,
        price: { amount: Number(String(v.accepts[0].price).replace("$", "")), currency: "USDC" } }; }) }); });
app.get("/openapi.json", c => {
  const o = new URL(c.req.url).origin, specPaths = {};
  for (const [k, v] of Object.entries(routes)) {
    const [method, p] = k.split(" "), info = v.extensions?.bazaar?.info, schema = info?.input?.queryParams ? v.extensions.bazaar.schema?.properties?.input?.properties?.queryParams : null;
    const props = schema?.properties || {}, req = schema?.required || [];
    const bodySchema = info?.input?.body ? v.extensions.bazaar.schema?.properties?.input?.properties?.body : null;
    specPaths[p] = { [method.toLowerCase()]: { summary: v.description.split(":")[0], description: v.description,
      security: [],
      "x-sample-url": `${o}/sample${p}`,
      "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: String(v.accepts[0].price).replace("$", "") }, protocols: [{ x402: {} }] },
      "x-x402": { price: v.accepts[0].price, network: v.accepts[0].network, asset: "USDC" },
      parameters: Object.entries(props).map(([n, d]) => ({ name: n, in: "query", required: req.includes(n), schema: { type: "string", ...(d.pattern ? { pattern: d.pattern } : {}) }, description: d.description || "" })),
      ...(bodySchema ? { requestBody: { required: true, content: { "application/json": { schema: bodySchema, example: info.input.body } } } } : {}),
      responses: { "200": { description: "OK", content: { "application/json": { example: info?.output?.example ?? {} } } }, "402": { description: "Payment required (x402)" } } } };
  }
  return c.json({ openapi: "3.1.0", info: { title: "Nightshift Labs API", version: "1.0.0", description: "Pay-per-call utilities for AI agents (x402, USDC on Base). Operated by Nightshift Labs, an autonomous AI-agent-run business.",
      contact: { name: "Nightshift Labs", email: "nightshiftlabs-api@agentmail.to", url: `${o}/llms.txt` },
      "x-guidance": "All endpoints return JSON; most are GET with query parameters, /v1/evm/typed-data-check is POST with the EIP-712 JSON as body. Pay per call with x402 (USDC on Base, no account or API key). Typical uses: check a Base token or a link before acting on it (token-check, link-check, whois), decode a transaction, calldata or an EIP-712 signature request before signing (tx, decode-calldata, typed-data-check), get prices/gas/portfolio, audit a site's DNS or security headers (domain/dns, web/security-headers), or turn a web page into Markdown (web/extract). Read /llms.txt for the full list with prices." },
    "x-agentcash-guidance": { llmsTxtUrl: `${o}/llms.txt` },
    servers: [{ url: o }], paths: specPaths });
});
// Test-only bypass: allowed solely on Base Sepolia, never on mainnet.
if (!(env.TEST_NO_PAY === "1" && NETWORK === "eip155:84532")) app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, !env.LAZY_INIT)); // Workers: LAZY_INIT (see worker.mjs)
const api = new Hono();
api.onError((e, c) => { const m = String(e?.message || e); console.error("handler error:", m);
  return /rpc|rate|limit|unavailable|timeout/i.test(m) ? c.json({ error: "upstream Base RPC temporarily unavailable, please retry", detail: m.slice(0, 160) }, 503) : c.json({ error: "internal error" }, 500); });
const bad = (c, m) => c.json({ error: m }, 400);
api.get("/v1/base/token-check", async c => { const a = c.req.query("address"); if (!isAddr(a)) return bad(c, "address must be a 0x… 40-hex address"); return c.json(await tokenCheck(a)); });
api.get("/v1/base/balance", async c => { const a = c.req.query("address"); if (!isAddr(a)) return bad(c, "address must be a 0x… 40-hex address"); return c.json(await balance(a)); });
api.get("/v1/base/tx", async c => { const h = c.req.query("hash"); if (!isHash(h)) return bad(c, "hash must be a 0x… 64-hex transaction hash"); return c.json(await txDecode(h)); });
api.get("/v1/domain/email-check", async c => { const d = (c.req.query("domain") || "").trim().replace(/\.$/, ""); if (!isDomain(d)) return bad(c, "domain must be a valid domain name"); return c.json(await domainCheck(d)); });
api.get("/v1/evm/decode-calldata", async c => { const d = (c.req.query("data") || "").trim(); if (!isHex(d) || d.length > 32770) return bad(c, "data must be 0x-prefixed hex calldata (>= 4 bytes, max 16 KB)"); try { return c.json(await decodeCalldata(d)); } catch (e) { return c.json({ error: "signature lookup failed, retry" }, 502); } });
api.get("/v1/ens/resolve", async c => { const q = (c.req.query("q") || "").trim(); if (!isAddr(q) && !isEnsName(q)) return bad(c, "q must be an ENS name (x.eth, x.base.eth) or a 0x address"); return c.json(await resolveName(q)); });
api.get("/v1/domain/whois", async c => { const d = (c.req.query("domain") || "").trim().replace(/\.$/, ""); if (!isDomain(d)) return bad(c, "domain must be a valid domain name"); return c.json(await domainWhois(d)); });
api.get("/v1/domain/dns", async c => { const d = (c.req.query("name") || "").trim().replace(/\.$/, ""); if (!isDomain(d)) return bad(c, "name must be a valid domain/host name");
  const ALLOWED = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "CAA", "SOA"], t = (c.req.query("types") || "").toUpperCase().split(",").map(x => x.trim()).filter(Boolean);
  if (t.some(x => !ALLOWED.includes(x))) return bad(c, "types must be a comma list of " + ALLOWED.join(","));
  return c.json(await dnsLookup(d, t.length ? [...new Set(t)] : undefined)); });
api.get("/v1/web/security-headers", async c => { const u = (c.req.query("url") || "").trim(); if (!u || u.length > 4000) return bad(c, "url is required (max 4000 chars)");
  try { return c.json(await headersAudit(u)); } catch (e) { return c.json({ error: "could not fetch: " + String(e.message).slice(0, 120) }, 422); } });
api.get("/v1/x402/preflight", async c => { const u = (c.req.query("url") || "").trim(), m = (c.req.query("method") || "GET").toUpperCase(); if (!/^https?:\/\//.test(u) || u.length > 4000) return bad(c, "url must be an http(s) URL (max 4000 chars)"); if (!["GET", "POST"].includes(m)) return bad(c, "method must be GET or POST");
  const d = c.req.query("days") ? Number(c.req.query("days")) : 3; if (!Number.isInteger(d) || d < 1 || d > 7) return bad(c, "days must be an integer 1-7");
  try { return c.json(await x402Preflight(u, m, { days: d })); } catch (e) { return c.json({ url: u, error: String(e.message || e).slice(0, 200), verdict: "fail" }, 200); } });
api.get("/v1/wallet/screen", async c => { const a = c.req.query("address"), e = c.req.query("expected"); if (!isAddr(a)) return bad(c, "address must be a 0x… 40-hex address"); if (e && !isAddr(e)) return bad(c, "expected must be a 0x… 40-hex address"); return c.json(await walletScreen(a, e)); });
api.get("/v1/web/brand", async c => { const u = (c.req.query("url") || "").trim(); if (!/^https?:\/\//.test(u) || u.length > 4000) return bad(c, "url must be an http(s) URL (max 4000 chars)");
  try { return c.json(await brandExtract(u)); } catch (e) { return c.json({ url: u, error: String(e.message || e).slice(0, 200) }, 422); } });
api.get("/v1/base/portfolio", async c => { const a = c.req.query("address"); if (!isAddr(a)) return bad(c, "address must be a 0x… 40-hex address"); return c.json(await portfolio(a)); });
api.get("/v1/web/link-check", async c => { const u = (c.req.query("url") || "").trim(); if (!u || u.length > 4000) return bad(c, "url is required (max 4000 chars)"); return c.json(await urlCheck(u)); });
api.get("/v1/base/token-price", async c => { const a = c.req.query("address"); if (!isAddr(a)) return bad(c, "address must be a 0x… 40-hex address"); return c.json(await tokenPrice(a)); });
api.post("/v1/evm/typed-data-check", async c => {
  const raw = await c.req.text(); if (raw.length > 65536) return bad(c, "body too large (max 64 KB)");
  let td; try { const j = JSON.parse(raw); td = parseTypedData(j && j.typedData ? j.typedData : j); } catch (e) { return bad(c, "body must be EIP-712 JSON {types, domain, primaryType, message} (or {typedData: …}): " + String(e.message).slice(0, 120)); }
  try { return c.json(await typedDataCheck(td)); } catch (e) { return c.json({ error: "check failed: " + String(e.message).slice(0, 120) }, 500); } });
api.get("/v1/base/gas", async c => { const g = c.req.query("gasLimit");
  if (g !== undefined && g !== "" && !/^[0-9]{1,9}$/.test(g)) return bad(c, "gasLimit must be an integer (gas units, max 9 digits)");
  return c.json(await gas(g ? Number(g) : undefined)); });
api.get("/v1/web/extract", async c => {
  const u = c.req.query("url"); if (!u) return bad(c, "url is required");
  const max = Math.min(Math.max(parseInt(c.req.query("maxChars") || "20000") || 20000, 500), 100000);
  try { return c.json(await extract(u, max)); } catch (e) { return bad(c, e.message); }
});
app.route("/", api);
// Paid MCP server (x402 over MCP transport; never an HTTP 402).
mountMcp(app, { routes, api, resourceServer, noPay: env.TEST_NO_PAY === "1" && NETWORK === "eip155:84532" });
// FREE samples: the real handler run on each endpoint's documented example input, cached 15 min per isolate (so it can't be used as a free API).
const sampleCache = new Map();
const sampleReq = (method, p, v) => { const inp = v.extensions?.bazaar?.info?.input || {};
  if (method === "GET") { const q = new URLSearchParams(inp.queryParams || {}).toString(); return [p + (q ? "?" + q : ""), { method }]; }
  return [p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(inp.body || {}) }]; };
app.get("/samples", c => { const o = new URL(c.req.url).origin; return c.json({ note: "Free previews: real output of each paid endpoint for its fixed example input (cached up to 15 min). Pay per call via x402 for your own inputs.",
  samples: Object.entries(routes).map(([k, v]) => { const [m, p] = k.split(" "); return { endpoint: `${m} ${p}`, price: v.accepts[0].price, sample: `${o}/sample${p}`, exampleInput: v.extensions?.bazaar?.info?.input?.queryParams ?? v.extensions?.bazaar?.info?.input?.body ?? {} }; }) }); });
for (const [k, v] of Object.entries(routes)) { const [m, p] = k.split(" ");
  app.get("/sample" + p, async c => {
    const hit = sampleCache.get(p); if (hit && Date.now() - hit.t < 900000) return c.json(hit.body, 200, { "x-sample": "cached", "cache-control": "public, max-age=900" });
    const [url, init] = sampleReq(m, p, v), r = await api.request(url, init), j = await r.json().catch(() => ({ error: "sample failed" }));
    const out = { sample: true, endpoint: `${m} ${p}`, price: v.accepts[0].price, input: v.extensions?.bazaar?.info?.input?.queryParams ?? v.extensions?.bazaar?.info?.input?.body ?? {}, generatedAt: new Date().toISOString(), output: j };
    if (r.ok && !j?.error && !j?.payToActivity?.error && !j?.payToActivity?.partial) sampleCache.set(p, { t: Date.now(), body: out });
    return c.json(out, r.ok ? 200 : 502, { "cache-control": "public, max-age=900" }); }); }
app.onError((e, c) => { const m = String(e?.message || e); console.error("handler error:", m);
  return /rpc|rate|limit|unavailable|timeout/i.test(m) ? c.json({ error: "upstream Base RPC temporarily unavailable, please retry", detail: m.slice(0, 160) }, 503) : c.json({ error: "internal error" }, 500); });
app.resourceServer = resourceServer; app.facilitatorUrl = facilitatorConfig.url; app.network = NETWORK;
return app;
}
