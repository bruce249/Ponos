/** Shared script helpers. Keys come from the environment. Nothing here is a secret. */
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { parseHederaKey } from "@byline-work/shared";

export function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing ${name}. See .env.example. This script stops rather than guessing.`);
    process.exit(1);
  }
  return v;
}

export function missing(names: string[]): string[] {
  return names.filter((n) => !(process.env[n] ?? "").trim());
}

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}

export function operatorClient(): Client {
  const network = process.env.HEDERA_NETWORK || "hedera:testnet";
  const client = network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(need("OPERATOR_ACCOUNT_ID")), parseHederaKey(need("OPERATOR_PRIVATE_KEY")) as unknown as PrivateKey);
  return client;
}
