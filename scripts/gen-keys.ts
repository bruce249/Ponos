/**
 * Prints an EVM key for feed signatures. Hedera accounts come from create-accounts.ts.
 *   npm run keys
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log(`FEED_SIGNER_KEY=${key}   # address ${privateKeyToAccount(key).address}`);
console.log("# Hedera role accounts are created by: npm run accounts");
