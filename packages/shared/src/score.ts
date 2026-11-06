/**
 * Contributor Score. A pure function of public task events.
 *
 *   pass rate = (passes + α · p0) / (submissions + α)     α = 5, p0 = global pass rate
 *   on time   = submits before the work deadline / claims
 *   volume V  = Σ task value (bUSD) × 0.5 ^ (ageDays / 30)
 *   score     = 100 × pass rate × on time × V / (V + k) − 10 per dispute lost
 *
 * k = 200 bUSD. Floor is 0. The decay uses a number because it is a score, not a payment.
 * Callers convert base units with `baseToDecimal` inputs already expressed as bUSD numbers
 * via `busdFromBase`, which only crosses into number at this boundary.
 */

import { baseToDecimal } from "./units";

export const SCORE_K_BUSD = 200;
export const SCORE_ALPHA = 5;
export const SCORE_DISPUTE_PENALTY = 10;
export const SCORE_FLOOR = 0;

/** Base units → bUSD as a number, for the volume term only. */
export function busdFromBase(base: bigint): number {
  return Number(baseToDecimal(base));
}

export function passRate(passes: number, submissions: number, globalPassRate: number, alpha = SCORE_ALPHA): number {
  return (passes + alpha * globalPassRate) / (submissions + alpha);
}

export function onTimeRate(onTimeSubmits: number, claimed: number): number {
  if (claimed <= 0) return 0;
  // A resubmit after a revision is a second `submitted` event for the same claim. Cap at 1.
  return Math.min(1, onTimeSubmits / claimed);
}

export function volumeBusd(items: { valueBusd: number; ageDays: number }[]): number {
  let v = 0;
  for (const it of items) v += it.valueBusd * Math.pow(0.5, it.ageDays / 30);
  return v;
}

export type ScoreInput = {
  passes: number;
  submissions: number;
  onTimeSubmits: number;
  claimed: number;
  /** Already-decayed volume, in bUSD. */
  volume: number;
  disputesLost: number;
  /** passes / submissions across every worker. 0 when nobody has submitted. */
  globalPassRate: number;
};

export function contributorScore(input: ScoreInput): number {
  const pr = passRate(input.passes, input.submissions, input.globalPassRate);
  const ot = onTimeRate(input.onTimeSubmits, input.claimed);
  const v = input.volume;
  const raw = 100 * pr * ot * (v / (v + SCORE_K_BUSD)) - SCORE_DISPUTE_PENALTY * input.disputesLost;
  if (!Number.isFinite(raw)) return SCORE_FLOOR;
  return Math.max(SCORE_FLOOR, raw);
}

export type PublicTaskEvent = {
  worker: string;
  event: string;
  /** Worker-received pay in bUSD (released amount, or the resolved worker share). */
  valueBusd?: number;
  ageDays?: number;
  /** A resolved dispute the worker lost (worker share of pay is zero). */
  disputeLost?: boolean;
};

export type WorkerScore = {
  worker: string;
  score: number;
  passes: number;
  submissions: number;
  claimed: number;
  onTimeSubmits: number;
  disputesLost: number;
  volume: number;
};

/**
 * Group public task events into per-worker scores.
 * A submit counts as on time: the contract rejects a late submit, so a `submitted`
 * event is itself the proof. Claims that expire stay in the denominator.
 */
export function scoresFromEvents(events: PublicTaskEvent[], global?: { passes: number; submissions: number }): WorkerScore[] {
  const byWorker = new Map<string, PublicTaskEvent[]>();
  let passes = 0;
  let submissions = 0;
  for (const e of events) {
    if (e.event === "qa_pass") passes += 1;
    if (e.event === "submitted") submissions += 1;
    const list = byWorker.get(e.worker) ?? [];
    list.push(e);
    byWorker.set(e.worker, list);
  }
  const p0 = global ? (global.submissions === 0 ? 0 : global.passes / global.submissions) : submissions === 0 ? 0 : passes / submissions;
  const out: WorkerScore[] = [];
  for (const [worker, list] of byWorker) {
    const row = {
      worker,
      passes: list.filter((e) => e.event === "qa_pass").length,
      submissions: list.filter((e) => e.event === "submitted").length,
      claimed: list.filter((e) => e.event === "claimed").length,
      onTimeSubmits: list.filter((e) => e.event === "submitted").length,
      disputesLost: list.filter((e) => e.disputeLost).length,
      volume: volumeBusd(list.filter((e) => (e.event === "released" || e.event === "resolved") && e.valueBusd).map((e) => ({ valueBusd: e.valueBusd!, ageDays: e.ageDays ?? 0 }))),
    };
    out.push({ ...row, score: contributorScore({ ...row, globalPassRate: p0 }) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
