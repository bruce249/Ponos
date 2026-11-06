/**
 * Finish a bUSD that was created without its custom fee: associate the treasury, grant it KYC, then add the
 * 1-tinybar HBAR fee. Run once after `npm run busd` if it reported the fee was not set.
 *   npm run busd:fee
 */
import { addTinyHbarFee, associateAccount, ensureKyc, missing, need } from "./client";

const absent = missing(["BUSD_TOKEN_ID", "TREASURY_ACCOUNT_ID", "TREASURY_PRIVATE_KEY", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY"]);
if (absent.length) {
  console.error(`Cannot add the fee. Missing: ${absent.join(", ")}`);
  process.exit(1);
}
const tokenId = need("BUSD_TOKEN_ID");
try {
  console.log(`treasury association: ${await associateAccount(need("TREASURY_ACCOUNT_ID"), need("TREASURY_PRIVATE_KEY"), tokenId)}`);
  console.log(`treasury KYC: ${await ensureKyc(need("TREASURY_ACCOUNT_ID"), tokenId)}`);
  const tx = await addTinyHbarFee(tokenId);
  console.log(`custom fee tx (1 tinybar HBAR, treasury exempt): ${tx}`);
  console.log(`https://hashscan.io/testnet/token/${tokenId}`);
} catch (e: unknown) {
  console.error(`fee not set: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
