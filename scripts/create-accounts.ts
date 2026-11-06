/**
 * ECDSA accounts with an EVM alias (setECDSAKeyWithAlias) and unlimited auto-association,
 * so each one can hold bUSD. The operator pays. Prints .env lines. Does not write .env.
 *   npm run accounts
 */
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { operatorClient } from "./lib";

// Starting HBAR, sized from real testnet costs (not guesses). Token operations are priced in USD, so gas is high:
// an ERC-20 approve on the bUSD facade used ~727k gas (~0.7 HBAR), submitFor ~1.5M gas, and deploying the escrow costs
// ~50 HBAR in file-upload fees plus its 20 HBAR starting balance. The first plan (LAB 10, ESCROW_ADMIN 50) ran dry.
// Total about 580 HBAR, so fund the operator from the portal faucet first.
const plan = [
  { name: "SCS_ADMIN", hbar: 200 },
  { name: "CASHIN", hbar: 10 },
  { name: "BURN", hbar: 5 },
  { name: "COMPLIANCE", hbar: 15 },
  { name: "TREASURY", hbar: 10 },
  { name: "QA_POOL", hbar: 2 },
  { name: "ESCROW_ADMIN", hbar: 150 },
  { name: "BACKEND", hbar: 60 },
  { name: "QA_ORACLE", hbar: 15 },
  { name: "REVIEWER", hbar: 15 },
  { name: "REVIEWER2", hbar: 15 },
  { name: "LAB", hbar: 60 },
  { name: "WORKER_A", hbar: 5 },
  { name: "WORKER_B", hbar: 5 },
  { name: "WORKER_RENTED", hbar: 5 },
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
