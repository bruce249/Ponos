/**
 * Money units. Every amount that can move is a bigint.
 * bUSD has 6 decimals (1 bUSD = 1_000_000 base units). HBAR moves in tinybars (8 decimals).
 * There is no floating-point money on these paths.
 */

export const BUSD_DECIMALS = 6;
export const HBAR_DECIMALS = 8;
export const TINYBAR = 100_000_000n;

/** 100 bUSD. Direct `claim` is allowed at or below this; above it only `claimFor` after a step-up. */
export const HITL_BASE_UNITS = 100_000_000n;

/** "40" or "40.5" or "40.000001" -> base units. Rejects negatives and more than 6 decimals. */
export function decimalToBase(value: string | number): bigint {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${s}`);
  const [int, frac = ""] = s.split(".");
  if (frac.length > BUSD_DECIMALS) throw new Error(`too many decimals in ${s} (max ${BUSD_DECIMALS})`);
  return BigInt(int!) * 10n ** BigInt(BUSD_DECIMALS) + BigInt(frac.padEnd(BUSD_DECIMALS, "0"));
}

/** 40000000n -> "40". Trailing zeros in the fraction are dropped. */
export function baseToDecimal(base: bigint | number): string {
  const m = BigInt(base);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const unit = 10n ** BigInt(BUSD_DECIMALS);
  const int = abs / unit;
  const frac = (abs % unit).toString().padStart(BUSD_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** "0.001" HBAR -> 100000n tinybars. Rejects more than 8 decimals. */
export function hbarToTinybar(value: string | number): bigint {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid hbar amount: ${s}`);
  const [int, frac = ""] = s.split(".");
  if (frac.length > HBAR_DECIMALS) throw new Error(`too many decimals in ${s} (max ${HBAR_DECIMALS})`);
  return BigInt(int!) * TINYBAR + BigInt(frac.padEnd(Number(HBAR_DECIMALS), "0"));
}

export function tinybarToHbar(tiny: bigint | number): string {
  const m = BigInt(tiny);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const int = abs / TINYBAR;
  const frac = (abs % TINYBAR).toString().padStart(Number(HBAR_DECIMALS), "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** True when a task's pay must go through the relayer and a World ID step-up. */
export function requiresStepUp(payBase: bigint): boolean {
  return payBase > HITL_BASE_UNITS;
}
