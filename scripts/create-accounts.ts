/**
 * Creates the role accounts from the ECDSA keys already in .env (run `npm run keys` first).
 * Each account gets an EVM alias and unlimited auto-association, so it can hold bUSD.
 * Writes each <ROLE>_ACCOUNT_ID back into .env. Prints ids and HashScan links, never private keys.
 * Skips a role that already has an account id, so it is safe to rerun.
 *   npm run accounts
 */
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { MIRROR_NODE, parseHederaKey } from "@byline-work/shared";
import { die, envFileValue, need, networkSlug, operatorClient, writeEnv } from "./lib";
import { ROLE_PLAN } from "./roles";

const pending = ROLE_PLAN.filter((p) => !envFileValue(`${p.name}_ACCOUNT_ID`) && !(process.env[`${p.name}_ACCOUNT_ID`] ?? "").trim());
if (pending.length === 0) {
  console.log("Every role account id is already set.");
  process.exit(0);
}
for (const p of pending) need(`${p.name}_PRIVATE_KEY`);

const operatorId = need("OPERATOR_ACCOUNT_ID");
const network = networkSlug();
const mirror = MIRROR_NODE[network === "mainnet" ? "hedera:mainnet" : "hedera:testnet"];
const balanceRes = await fetch(`${mirror}/api/v1/accounts/${operatorId}`, { signal: AbortSignal.timeout(15_000) });
if (!balanceRes.ok) die(`mirror node ${balanceRes.status} for ${operatorId}`);
const account = (await balanceRes.json()) as { balance?: { balance?: number | string } };
const balanceHbar = Number(BigInt(account.balance?.balance ?? 0)) / 1e8;
const hbarNeeded = pending.reduce((sum, p) => sum + p.hbar, 0);
const reserve = hbarNeeded + 5;
if (balanceHbar < reserve) {
  console.error(`Operator ${operatorId} has ${balanceHbar.toFixed(2)} HBAR. Creating ${pending.length} accounts needs about ${reserve} HBAR including fees.`);
  die("Fund it at https://portal.hedera.com, then run npm run accounts again.");
}

const client = operatorClient();
const created: Record<string, string> = {};
for (const p of pending) {
  const key = parseHederaKey(need(`${p.name}_PRIVATE_KEY`)) as unknown as PrivateKey;
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key.publicKey)
    .setInitialBalance(new Hbar(p.hbar))
    .setMaxAutomaticTokenAssociations(-1)
    .setAccountMemo(`byline-work ${p.name.toLowerCase()}`)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const id = receipt.accountId?.toString();
  if (!id) die(`${p.name} receipt had no account id`);
  // Write after every account, so a failure halfway keeps the ones already paid for.
  writeEnv({ [`${p.name}_ACCOUNT_ID`]: id });
  created[p.name] = id;
  console.log(`${p.name}_ACCOUNT_ID=${id}  https://hashscan.io/${network}/account/${id}`);
}

if (!envFileValue("LAB_ALLOWLIST") && created.LAB) writeEnv({ LAB_ALLOWLIST: created.LAB });
const reviewers = envFileValue("REVIEWER_ALLOWLIST").split(",").map((s) => s.trim()).filter(Boolean);
for (const r of [created.REVIEWER, created.REVIEWER_B]) if (r && !reviewers.includes(r)) reviewers.push(r);
if (reviewers.join(",") !== envFileValue("REVIEWER_ALLOWLIST")) writeEnv({ REVIEWER_ALLOWLIST: reviewers.join(",") });
client.close();
console.log(`Created ${Object.keys(created).length} accounts.`);
