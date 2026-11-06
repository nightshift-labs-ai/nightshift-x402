import { typedDataCheck, parseTypedData } from "../lib.mjs";
const now = Math.floor(Date.now()/1000), MAX = (2n**256n-1n).toString();
const D = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const permitTypes = { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],
  Permit: [{name:"owner",type:"address"},{name:"spender",type:"address"},{name:"value",type:"uint256"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint256"}] };
const cases = {
  permitUnlimited: { types: permitTypes, domain: D, primaryType: "Permit", message: { owner: "0x1111111111111111111111111111111111111111", spender: "0x2222222222222222222222222222222222222222", value: MAX, nonce: "0", deadline: MAX } },
  permit5usdc: { types: permitTypes, domain: D, primaryType: "Permit", message: { owner: "0x1111111111111111111111111111111111111111", spender: "0x2222222222222222222222222222222222222222", value: "5000000", nonce: "0", deadline: String(now + 3600) } },
  permit2Single: { domain: { name: "Permit2", chainId: 8453, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }, primaryType: "PermitSingle",
    types: { PermitSingle: [{name:"details",type:"PermitDetails"},{name:"spender",type:"address"},{name:"sigDeadline",type:"uint256"}],
      PermitDetails: [{name:"token",type:"address"},{name:"amount",type:"uint160"},{name:"expiration",type:"uint48"},{name:"nonce",type:"uint48"}] },
    message: { details: { token: "0x4200000000000000000000000000000000000006", amount: ((1n<<160n)-1n).toString(), expiration: String(now + 30*86400), nonce: "0" }, spender: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", sigDeadline: String(now + 1800) } },
  seaportDrain: { domain: { name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395" }, primaryType: "OrderComponents",
    types: { OrderComponents: [{name:"offerer",type:"address"},{name:"zone",type:"address"},{name:"offer",type:"OfferItem[]"},{name:"consideration",type:"ConsiderationItem[]"},{name:"orderType",type:"uint8"},{name:"startTime",type:"uint256"},{name:"endTime",type:"uint256"},{name:"zoneHash",type:"bytes32"},{name:"salt",type:"uint256"},{name:"conduitKey",type:"bytes32"},{name:"counter",type:"uint256"}],
      OfferItem: [{name:"itemType",type:"uint8"},{name:"token",type:"address"},{name:"identifierOrCriteria",type:"uint256"},{name:"startAmount",type:"uint256"},{name:"endAmount",type:"uint256"}],
      ConsiderationItem: [{name:"itemType",type:"uint8"},{name:"token",type:"address"},{name:"identifierOrCriteria",type:"uint256"},{name:"startAmount",type:"uint256"},{name:"endAmount",type:"uint256"},{name:"recipient",type:"address"}] },
    message: { offerer: "0x1111111111111111111111111111111111111111", zone: "0x0000000000000000000000000000000000000000",
      offer: [{ itemType: 2, token: "0x5555555555555555555555555555555555555555", identifierOrCriteria: "42", startAmount: "1", endAmount: "1" }],
      consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: "0x9999999999999999999999999999999999999999" }],
      orderType: 0, startTime: String(now), endTime: MAX, zoneHash: "0x" + "00".repeat(32), salt: "1", conduitKey: "0x" + "00".repeat(32), counter: "0" } },
  mailLogin: { domain: { name: "Example", version: "1", chainId: 1 }, primaryType: "Login", types: { Login: [{name:"wallet",type:"address"},{name:"nonce",type:"string"}] }, message: { wallet: "0x1111111111111111111111111111111111111111", nonce: "abc" } },
  broken: { domain: {}, primaryType: "X", types: { X: [{name:"a",type:"uint256"}] }, message: { a: "notanumber" } },
};
for (const [k, v] of Object.entries(cases)) { const r = await typedDataCheck(parseTypedData(JSON.stringify(v))); console.log("==", k, r.kind, r.risk, "|", r.summary, "|", r.warnings.join(" ; "), r.digest ? "" : "NO DIGEST"); }
