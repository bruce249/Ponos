/** Shared script helpers. Keys come from the environment. Nothing here is a secret. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { parseHederaKey } from "@byline-work/shared";

export const ENV_PATH = ".env";

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

export function networkSlug(): "testnet" | "mainnet" {
  return process.env.HEDERA_NETWORK === "hedera:mainnet" ? "mainnet" : "testnet";
}

export function operatorClient(): Client {
  const client = networkSlug() === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(need("OPERATOR_ACCOUNT_ID")), parseHederaKey(need("OPERATOR_PRIVATE_KEY")) as unknown as PrivateKey);
  return client;
}

/** The value of NAME in .env, or "" when the file or the line is missing. */
export function envFileValue(name: string, path = ENV_PATH): string {
  if (!existsSync(path)) return "";
  const m = readFileSync(path, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return (m?.[1] ?? "").trim();
}

/**
 * Writes NAME=value lines into .env, replacing an existing line or appending a new one,
 * and mirrors them into process.env. Prints only the names, so private keys never reach
 * the terminal. Without a .env file it prints the lines for the user to paste instead.
 */
export function writeEnv(values: Record<string, string>, opts: { secret?: boolean; path?: string } = {}): void {
  const path = opts.path ?? ENV_PATH;
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  if (!existsSync(path)) {
    console.log(`# No ${path} found. Add these lines to it:`);
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${opts.secret ? "<hidden: rerun after cp .env.example .env>" : v}`);
    return;
  }
  let text = readFileSync(path, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(path, text);
  console.log(`# wrote ${Object.keys(values).join(", ")} to ${path}`);
}
