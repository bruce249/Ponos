/**
 * Issuer lifecycle. Each call is signed by its own role account.
 * Redeem transfers bUSD to the treasury and burns it. Wipe is only used when burn throws.
 *
 *   npm run lifecycle -- deposit 0.0.lab 1000
 *   npm run lifecycle -- kyc 0.0.worker
 *   npm run lifecycle -- freeze 0.0.worker
 *   npm run lifecycle -- unfreeze 0.0.worker
 *   npm run lifecycle -- pause
 *   npm run lifecycle -- unpause
 *   npm run lifecycle -- redeem 0.0.worker 20
 */
import { baseToDecimal, decimalToBase } from "@byline-work/shared";
import { evmAddressFromKey, requireRole } from "../apps/api/src/chain";
import { metaSet, openDb } from "../apps/api/src/db";
import { transferBusd } from "../apps/api/src/escrow";
import { associateAccount, burn, cashIn, ensureKyc, freezeAccount, missing, pauseToken, reserveAmount, setReserve, unfreezeAccount, unpauseToken, wipe } from "./client";

function token(): string {
  return (process.env.BUSD_TOKEN_ID ?? "").trim();
}

function reserveAddress(): string {
  return (process.env.BUSD_RESERVE_ADDRESS ?? "").trim();
}

/** The SDK prints a decimal. Keep at most 6 places so it round-trips through base units. */
function sdkDecimal(value: string): string {
  const s = value.trim();
  const [i, f = ""] = s.split(".");
  const whole = (i ?? "0").replace(/\D/g, "") || "0";
  const frac = f.replace(/\D/g, "").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function remember(amountDecimal: string, tx: string) {
  try {
    const db = openDb(process.env.DB_PATH?.trim() || "data/byline-work.db");
    metaSet(db, "busd_reserve", decimalToBase(amountDecimal).toString());
    metaSet(db, "busd_reserve_tx", tx);
  } catch (e: unknown) {
    console.error(`reserve recorded on chain (${tx}) but the local meta write failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function deposit(targetId: string, amountDecimal: string): Promise<{ reserveTx: string; cashInTx: string }> {
  const absent = missing(["BUSD_TOKEN_ID", "BUSD_RESERVE_ADDRESS", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY", "CASHIN_ACCOUNT_ID", "CASHIN_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`deposit is not configured: ${absent.join(", ")}`);
  const current = decimalToBase(sdkDecimal(await reserveAmount(token())));
  const next = baseToDecimal(current + decimalToBase(amountDecimal));
  const reserveTx = await setReserve(reserveAddress(), next);
  const cashInTx = await cashIn(targetId, amountDecimal, token());
  remember(next, reserveTx);
  return { reserveTx, cashInTx };
}

export async function kyc(targetId: string): Promise<string> {
  const absent = missing(["BUSD_TOKEN_ID", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`kyc is not configured: ${absent.join(", ")}`);
  // KYC can only be granted to an associated account. Associating needs that account's own key,
  // so it is done here only for accounts whose key is in .env (role accounts). A worker account
  // that is not in .env has to associate itself first.
  const key = keyForAccount(targetId);
  if (key) await associateAccount(targetId, key, token());
  return ensureKyc(targetId, token());
}

/** The private key in .env for a Hedera account id, if it is one of our role accounts. */
export function keyForAccount(accountId: string): string | null {
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.endsWith("_ACCOUNT_ID") || (value ?? "").trim() !== accountId) continue;
    const key = (process.env[name.replace(/_ACCOUNT_ID$/, "_PRIVATE_KEY")] ?? "").trim();
    if (key) return key;
  }
  return null;
}

/** `LAB` and `0.0.123` both work on the command line. */
export function resolveAccount(input: string | undefined, what: string): string {
  const v = (input ?? "").trim();
  if (!v) throw new Error(`${what} is required (a 0.0.x account id or a role name such as LAB).`);
  if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  const id = (process.env[`${v.toUpperCase()}_ACCOUNT_ID`] ?? "").trim();
  if (!id) throw new Error(`${what} "${v}" is neither an account id nor a role in .env (${v.toUpperCase()}_ACCOUNT_ID).`);
  return id;
}

/**
 * TOK-02. Mint without raising the reserve first. Stablecoin Studio must refuse once supply would
 * exceed the reserve. Returns the refusal, or throws if the mint went through (that would be a
 * stablecoin with unbacked supply, so it is reported loudly).
 */
export async function overmint(targetId: string, amountDecimal: string): Promise<{ refused: true; reason: string }> {
  const absent = missing(["BUSD_TOKEN_ID", "CASHIN_ACCOUNT_ID", "CASHIN_PRIVATE_KEY", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`overmint is not configured: ${absent.join(", ")}`);
  const supplyBefore = await supplyOf(token());
  try {
    const tx = await cashIn(targetId, amountDecimal, token());
    throw new Error(`UNBACKED MINT SUCCEEDED (${tx}). Supply now exceeds the reserve: the reserve check is not enforced. Supply was ${supplyBefore}.`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("UNBACKED MINT SUCCEEDED")) throw e;
    return { refused: true, reason: message };
  }
}

async function supplyOf(tokenId: string): Promise<string> {
  const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/tokens/${tokenId}`);
  const d = (await r.json()) as { total_supply?: string };
  return d.total_supply ?? "?";
}

export async function freeze(targetId: string): Promise<string> {
  const absent = missing(["BUSD_TOKEN_ID", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`freeze is not configured: ${absent.join(", ")}`);
  return freezeAccount(targetId, token());
}

export async function unfreeze(targetId: string): Promise<string> {
  const absent = missing(["BUSD_TOKEN_ID", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`unfreeze is not configured: ${absent.join(", ")}`);
  return unfreezeAccount(targetId, token());
}

export async function pause(): Promise<string> {
  const absent = missing(["BUSD_TOKEN_ID", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`pause is not configured: ${absent.join(", ")}`);
  return pauseToken(token());
}

export async function unpause(): Promise<string> {
  const absent = missing(["BUSD_TOKEN_ID", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`unpause is not configured: ${absent.join(", ")}`);
  return unpauseToken(token());
}

export type RedeemPath = {
  path: string[];
  transferTx: string;
  burnTx: string;
  reserveTx: string;
  wiped: boolean;
};

/**
 * Transfer the holder's bUSD to the treasury, then burn. If burn throws, wipe the treasury
 * balance that the transfer just created. The reserve drops by the same amount.
 */
export async function redeem(holderAccountId: string, holderPrivateKey: string, amountDecimal: string): Promise<RedeemPath> {
  const absent = missing(["BUSD_TOKEN_ID", "BUSD_RESERVE_ADDRESS", "TREASURY_ACCOUNT_ID", "TREASURY_PRIVATE_KEY", "BURN_ACCOUNT_ID", "BURN_PRIVATE_KEY", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY"]);
  if (absent.length) throw new Error(`redeem is not configured: ${absent.join(", ")}`);
  const treasury = requireRole("treasury");
  const to = evmAddressFromKey(treasury.privateKey);
  const amountBase = decimalToBase(amountDecimal);
  const sent = await transferBusd({ accountId: holderAccountId, privateKey: holderPrivateKey }, to, amountBase);
  let burnTx = "";
  let wiped = false;
  try {
    burnTx = await burn(amountDecimal, token());
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`burn failed (${why}). Wiping the treasury balance instead.`);
    burnTx = await wipe(treasury.accountId, amountDecimal, token());
    wiped = true;
  }
  const current = decimalToBase(sdkDecimal(await reserveAmount(token())));
  const spend = decimalToBase(amountDecimal);
  const next = baseToDecimal(current > spend ? current - spend : 0n);
  const reserveTx = await setReserve(reserveAddress(), next);
  remember(next, reserveTx);
  return {
    path: wiped ? ["transfer to treasury", "wipe", "reserve decrease"] : ["transfer to treasury", "burn", "reserve decrease"],
    transferTx: sent.txId,
    burnTx,
    reserveTx,
    wiped,
  };
}

function amountArg(v: string | undefined): string {
  const s = (v ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s) || Number(s) <= 0) throw new Error(`amount must be a positive bUSD amount with at most 6 decimals, got "${v ?? ""}".`);
  return s;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "deposit") {
      const r = await deposit(resolveAccount(a, "account"), amountArg(b));
      console.log(`reserve tx: ${r.reserveTx}`);
      console.log(`cash-in tx: ${r.cashInTx}`);
    } else if (cmd === "overmint") {
      const r = await overmint(resolveAccount(a, "account"), amountArg(b));
      console.log(`refused, as it should be: ${r.reason}`);
    } else if (cmd === "kyc") console.log(await kyc(resolveAccount(a, "account")));
    else if (cmd === "freeze") console.log(await freeze(resolveAccount(a, "account")));
    else if (cmd === "unfreeze") console.log(await unfreeze(resolveAccount(a, "account")));
    else if (cmd === "pause") console.log(await pause());
    else if (cmd === "unpause") console.log(await unpause());
    else if (cmd === "redeem") {
      const key = process.env.REDEEM_PRIVATE_KEY || process.env.WORKER_A_PRIVATE_KEY || "";
      if (!key) throw new Error("Set REDEEM_PRIVATE_KEY or WORKER_A_PRIVATE_KEY for the holder.");
      const r = await redeem(resolveAccount(a, "account"), key, amountArg(b));
      console.log(r.path.join(" -> "));
      console.log(`transfer: ${r.transferTx}`);
      console.log(`${r.wiped ? "wipe" : "burn"}: ${r.burnTx}`);
      console.log(`reserve: ${r.reserveTx}`);
    } else {
      console.error("usage: lifecycle.ts deposit <account> <bUSD> | overmint <account> <bUSD> | kyc|freeze|unfreeze <account> | pause | unpause | redeem <account> <bUSD>  (account: 0.0.x or a role such as LAB)");
      process.exit(1);
    }
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

const invoked = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invoked.endsWith("lifecycle.ts") || invoked.endsWith("lifecycle.js")) {
  await main();
  process.exit(0); // the SDK keeps handles open; do not hang after the command is done
}
