/**
 * Fraud scene. After the rented account is frozen, try to move its bUSD. HTS must refuse.
 * Prints the failure so it can be shown next to the freeze tx on HashScan.
 *   npm run demo:frozen-transfer
 */
import { decimalToBase, hashscanTx } from "@byline-work/shared";
import { evmAddressFromKey, EscrowCallError } from "../apps/api/src/chain";
import { transferBusd } from "../apps/api/src/escrow";
import { die, missing, need } from "./lib";

const absent = missing(["WORKER_RENTED_ACCOUNT_ID", "WORKER_RENTED_PRIVATE_KEY", "TREASURY_PRIVATE_KEY", "BUSD_TOKEN_ID"]);
if (absent.length) die(`frozen-transfer is not configured. Missing: ${absent.join(", ")}`);

const owner = { accountId: need("WORKER_RENTED_ACCOUNT_ID"), privateKey: need("WORKER_RENTED_PRIVATE_KEY") };
const to = evmAddressFromKey(need("TREASURY_PRIVATE_KEY"));
try {
  const sent = await transferBusd(owner, to, decimalToBase("1"));
  die(`The transfer SUCCEEDED (${sent.txId}). The account is not frozen.`);
} catch (e: unknown) {
  if (e instanceof EscrowCallError) {
    console.log(`transfer refused: ${e.errorMessage}`);
    console.log(hashscanTx(e.txId, (process.env.HEDERA_NETWORK as "hedera:testnet") || "hedera:testnet"));
  } else {
    console.log(`transfer refused: ${e instanceof Error ? e.message : e}`);
  }
}
