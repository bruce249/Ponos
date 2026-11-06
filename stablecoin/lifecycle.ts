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
import { burn, cashIn, freezeAccount, grantKyc, missing, pauseToken, reserveAmount, setReserve, unfreezeAccount, unpauseToken, wipe } from "./client";

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
  return grantKyc(targetId, token());
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

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "deposit") {
      const r = await deposit(a ?? "", b ?? "");
      console.log(`reserve tx: ${r.reserveTx}`);
      console.log(`cash-in tx: ${r.cashInTx}`);
    } else if (cmd === "kyc") console.log(await kyc(a ?? ""));
    else if (cmd === "freeze") console.log(await freeze(a ?? ""));
    else if (cmd === "unfreeze") console.log(await unfreeze(a ?? ""));
    else if (cmd === "pause") console.log(await pause());
    else if (cmd === "unpause") console.log(await unpause());
    else if (cmd === "redeem") {
      const key = process.env.REDEEM_PRIVATE_KEY || process.env.WORKER_A_PRIVATE_KEY || "";
      if (!key) throw new Error("Set REDEEM_PRIVATE_KEY or WORKER_A_PRIVATE_KEY for the holder.");
      const r = await redeem(a ?? "", key, b ?? "");
      console.log(r.path.join(" -> "));
      console.log(`transfer: ${r.transferTx}`);
      console.log(`${r.wiped ? "wipe" : "burn"}: ${r.burnTx}`);
      console.log(`reserve: ${r.reserveTx}`);
    } else {
      console.error("usage: lifecycle.ts deposit|kyc|freeze|unfreeze|pause|unpause|redeem");
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
}
