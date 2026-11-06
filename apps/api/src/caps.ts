/**
 * Per World ID limits. One person, one subject, one daily claim budget.
 * A ban sticks to the subject, so a new Hedera account does not clear it.
 */
import { config } from "./config";
import { get, run, type Db, type WorkerRow } from "./db";

const DAY_MS = 86_400_000;
const nowSec = () => Math.floor(Date.now() / 1000);

export type Gate = { ok: true } | { ok: false; reason: "cap_reached" | "banned"; detail: string };

export function banGate(w: WorkerRow): Gate {
  if (!w.banned_at) return { ok: true };
  return { ok: false, reason: "banned", detail: "This World ID is banned." };
}

export function claimsToday(db: Db, workerId: string): number {
  const row = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claims WHERE worker_id = ? AND created_at > ?", workerId, Date.now() - DAY_MS);
  return Number(row?.n ?? 0);
}

export function claimCapGate(db: Db, workerId: string): Gate {
  const n = claimsToday(db, workerId);
  if (n >= config.caps.dailyClaims) {
    return { ok: false, reason: "cap_reached", detail: `${n} of ${config.caps.dailyClaims} claims used in the last 24 hours` };
  }
  return { ok: true };
}

export function recordClaim(db: Db, workerId: string, batchId: string, taskId: number | null) {
  run(db, "INSERT INTO claims (worker_id, batch_id, task_id, created_at) VALUES (?, ?, ?, ?)", workerId, batchId, taskId, Date.now());
}

export function recordDenial(db: Db, workerId: string | null, action: string, target: string, reason: string, detail: string) {
  run(db, "INSERT INTO denials (worker_id, action, target, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)", workerId, action, target, reason, detail, nowSec());
}

export function banWorker(db: Db, workerId: string) {
  run(db, "UPDATE workers SET banned_at = ? WHERE id = ?", Date.now(), workerId);
}
