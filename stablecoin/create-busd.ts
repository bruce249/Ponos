/**
 * Creates bUSD with Stablecoin Studio: 6 decimals, supply 0, KYC, freeze, wipe, pause,
 * a demo reserve, and a 1-tinybar HBAR custom fee. Prints the token id the SDK returns.
 * This script never invents a token id.
 *
 *   npm run busd
 */
import { decimalToBase } from "@byline-work/shared";
import { addTinyHbarFee, createCoin, missing } from "./client";

const required = [
  "SCS_ADMIN_ACCOUNT_ID",
  "SCS_ADMIN_PRIVATE_KEY",
  "CASHIN_ACCOUNT_ID",
  "BURN_ACCOUNT_ID",
  "COMPLIANCE_ACCOUNT_ID",
  "TREASURY_ACCOUNT_ID",
  "SCS_FACTORY_ADDRESS",
  "SCS_RESOLVER_ADDRESS",
];

const absent = missing(required);
if (absent.length) {
  console.error(`Cannot create bUSD. Missing: ${absent.join(", ")}`);
  console.error("Factory and resolver come from the Stablecoin Studio testnet deployment. This script will not invent a token id.");
  process.exit(1);
}

const created = await createCoin();
const tokenId = created.coin.tokenId?.toString() ?? "";
if (!tokenId || tokenId === "0.0.0") {
  console.error("Stablecoin Studio returned no token id. Nothing was printed as BUSD_TOKEN_ID.");
  process.exit(1);
}
const proxy = created.coin.evmProxyAddress?.toString() || created.coin.proxyAddress?.toString() || "";
const reserve = created.reserve?.proxyAddress?.toString() || created.coin.reserveAddress?.toString() || "";
let feeTx = "";
try {
  feeTx = await addTinyHbarFee(tokenId);
} catch (e: unknown) {
  console.error(`Token ${tokenId} exists, but the HBAR custom fee was not set: ${e instanceof Error ? e.message : e}`);
  console.error("The fee is 1 tinybar of HBAR, collected by the treasury, so it cannot skim bUSD out of the escrow.");
}

console.log(`BUSD_TOKEN_ID=${tokenId}`);
if (proxy) console.log(`BUSD_SCS_PROXY=${proxy}`);
if (reserve) console.log(`BUSD_RESERVE_ADDRESS=${reserve}`);
console.log(`# reserve initial amount base units: ${decimalToBase("0")}`);
if (feeTx) console.log(`# custom fee tx (1 tinybar HBAR, treasury exempt): ${feeTx}`);
console.log(`# https://hashscan.io/testnet/token/${tokenId}`);
