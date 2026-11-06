/**
 * Fee math, identical to EscrowVault.
 *
 *   fee        = pay * feeBps / 10000
 *   qa         = fee * qaBps / 10000
 *   treasury   = fee - qa          (rounding dust stays with the treasury)
 *
 * On resolve, the fee is charged only on the worker's share of pay (D9).
 * Refunds return pay + fee. The three resolve transfers sum to pay + fee.
 */

export const BPS = 10_000n;

export function platformFee(pay: bigint, feeBps: bigint): bigint {
  return (pay * feeBps) / BPS;
}

export function splitFee(fee: bigint, qaBps: bigint): { treasury: bigint; qa: bigint } {
  const qa = (fee * qaBps) / BPS;
  return { treasury: fee - qa, qa };
}

/** What a full release pays. Worker receives `pay`. Fee is split, dust to treasury. */
export function releaseSplit(pay: bigint, feeBps: bigint, qaBps: bigint): {
  pay: bigint;
  fee: bigint;
  treasury: bigint;
  qa: bigint;
  unit: bigint;
} {
  const fee = platformFee(pay, feeBps);
  const { treasury, qa } = splitFee(fee, qaBps);
  return { pay, fee, treasury, qa, unit: pay + fee };
}

/**
 * Dispute resolution. `workerBps` is the worker's share of `pay`, not of the fee.
 * client receives the rest of `pay + fee` after the worker amount and the charged fee.
 */
export function resolveSplit(pay: bigint, feeBps: bigint, qaBps: bigint, workerBps: bigint): {
  worker: bigint;
  client: bigint;
  fee: bigint;
  treasury: bigint;
  qa: bigint;
  unit: bigint;
} {
  if (workerBps < 0n || workerBps > BPS) throw new Error(`workerBps out of range: ${workerBps}`);
  const fullFee = platformFee(pay, feeBps);
  const unit = pay + fullFee;
  const worker = (pay * workerBps) / BPS;
  const fee = (fullFee * workerBps) / BPS;
  const client = unit - worker - fee;
  const { treasury, qa } = splitFee(fee, qaBps);
  return { worker, client, fee, treasury, qa, unit };
}

/** worker + client + fee === pay + fullFee, and treasury + qa === fee. */
export function resolutionConserves(pay: bigint, feeBps: bigint, qaBps: bigint, workerBps: bigint): boolean {
  const s = resolveSplit(pay, feeBps, qaBps, workerBps);
  const fullFee = platformFee(pay, feeBps);
  return s.worker + s.client + s.fee === pay + fullFee && s.treasury + s.qa === s.fee;
}
