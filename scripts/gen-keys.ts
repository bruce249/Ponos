/**
 * Fills every empty key slot in .env: FEED_SIGNER_KEY (EIP-191 feed signatures) and one
 * ECDSA <ROLE>_PRIVATE_KEY per role account. Never overwrites a key that is already set,
 * and never prints a private key. Run `npm run accounts` next to create the accounts.
 *   npm run keys
 */
import { existsSync } from "node:fs";
import { PrivateKey } from "@hiero-ledger/sdk";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { die, ENV_PATH, envFileValue, writeEnv } from "./lib";
import { ROLE_PLAN } from "./roles";

if (!existsSync(ENV_PATH)) die(`No ${ENV_PATH}. Run: cp .env.example .env`);

const fresh: Record<string, string> = {};
let feed: PrivateKeyAccount | null = null;
if (!envFileValue("FEED_SIGNER_KEY")) {
  const key = generatePrivateKey();
  fresh.FEED_SIGNER_KEY = key;
  feed = privateKeyToAccount(key);
}
for (const role of ROLE_PLAN) {
  const name = `${role.name}_PRIVATE_KEY`;
  if (!envFileValue(name)) fresh[name] = PrivateKey.generateECDSA().toStringDer();
}

if (!Object.keys(fresh).length) {
  console.log("Every key slot in .env is already filled. Nothing changed.");
} else {
  writeEnv(fresh, { secret: true });
  if (feed) console.log(`# feed signer address ${feed.address}`);
  console.log("# Next: npm run accounts");
}
