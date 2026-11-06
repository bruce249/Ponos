/**
 * Top up a testnet account with HBAR from the operator.
 *   npm run fund -- SCS_ADMIN 150        (a role name from .env)
 *   npm run fund -- 0.0.12345 20         (or an account id)
 * Testnet only. Refuses mainnet and anything over 500 HBAR in one call.
 */
import { AccountId, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { die, need, operatorClient } from "./lib";

const [target, amountRaw] = process.argv.slice(2);
if (!target || !amountRaw) die("usage: npm run fund -- <ROLE|0.0.x> <hbar>");
if ((process.env.HEDERA_NETWORK || "hedera:testnet") !== "hedera:testnet") die("fund is testnet only.");
const amount = Number(amountRaw);
if (!Number.isFinite(amount) || amount <= 0 || amount > 500) die("hbar must be a number between 0 and 500.");

const accountId = /^\d+\.\d+\.\d+$/.test(target) ? target : need(`${target.toUpperCase()}_ACCOUNT_ID`);
const client = operatorClient();
const sent = await new TransferTransaction()
  .addHbarTransfer(client.operatorAccountId!, new Hbar(-amount))
  .addHbarTransfer(AccountId.fromString(accountId), new Hbar(amount))
  .execute(client);
const receipt = await sent.getReceipt(client);
console.log(`sent ${amount} HBAR to ${accountId}: ${receipt.status.toString()}`);
console.log(`https://hashscan.io/testnet/transaction/${sent.transactionId.toString()}`);
client.close();
