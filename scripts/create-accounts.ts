/**
 * ECDSA accounts with an EVM alias (setECDSAKeyWithAlias) and unlimited auto-association,
 * so each one can hold bUSD. The operator pays. Prints .env lines. Does not write .env.
 *   npm run accounts
 */
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { operatorClient } from "./lib";

const plan = [
  { name: "SCS_ADMIN", hbar: 50 },
  { name: "CASHIN", hbar: 5 },
  { name: "BURN", hbar: 5 },
  { name: "COMPLIANCE", hbar: 5 },
  { name: "TREASURY", hbar: 2 },
  { name: "QA_POOL", hbar: 1 },
  { name: "ESCROW_ADMIN", hbar: 50 },
  { name: "BACKEND", hbar: 30 },
  { name: "QA_ORACLE", hbar: 10 },
  { name: "REVIEWER", hbar: 5 },
  { name: "REVIEWER2", hbar: 5 },
  { name: "LAB", hbar: 10 },
  { name: "WORKER_A", hbar: 1 },
  { name: "WORKER_B", hbar: 1 },
  { name: "WORKER_RENTED", hbar: 1 },
  { name: "AGENT", hbar: 20 },
];

const client = operatorClient();
for (const p of plan) {
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key.publicKey)
    .setInitialBalance(new Hbar(p.hbar))
    .setMaxAutomaticTokenAssociations(-1)
    .setAccountMemo(`byline-work ${p.name.toLowerCase()}`)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const id = receipt.accountId!.toString();
  console.log(`${p.name}_ACCOUNT_ID=${id}`);
  console.log(`${p.name}_PRIVATE_KEY=${key.toStringDer()}`);
  console.log(`# https://hashscan.io/testnet/account/${id}`);
}
client.close();
