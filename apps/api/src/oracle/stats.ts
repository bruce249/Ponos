/**
 * Escrow and client statistics for the x402 data service. Pure reads of the indexer's tables.
 * Money stays bigint until it is serialised as a base-unit string (NFR-03).
 */
import { all, get, type Db } from "../db";

const OPEN_FILTER = "state NOT IN ('Released','Refunded','Resolved','Expired')";

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Mirror-node consensus timestamp "seconds.nanos" when the indexer stored one, else the index time. */
function seconds(consensusTs: string | null, createdAtMs: number): number {
  const parsed = consensusTs ? Number.parseFloat(consensusTs) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : createdAtMs / 1000;
}

type EventRow = { task_id: number; name: string; consensus_ts: string | null; created_at: number };

/** Seconds from TaskSubmitted to the payout (TaskReleased or TaskResolved), per paid task. Resubmits restart nothing: the first submit counts. */
export function secondsToPay(db: Db, clientId?: string): number[] {
  const scope = clientId
    ? "AND task_id IN (SELECT t.task_id FROM tasks t JOIN batches b ON b.id = t.batch_id WHERE b.client_account_id = ?)"
    : "";
  const rows = all<EventRow>(
    db,
    `SELECT task_id, name, consensus_ts, created_at FROM task_events
     WHERE name IN ('TaskSubmitted','TaskReleased','TaskResolved') AND task_id IS NOT NULL ${scope}
     ORDER BY created_at ASC`,
    ...(clientId ? [clientId] : []),
  );
  const submitted = new Map<number, number>();
  const durations: number[] = [];
  const paid = new Set<number>();
  for (const r of rows) {
    const at = seconds(r.consensus_ts, r.created_at);
    if (r.name === "TaskSubmitted") {
      if (!submitted.has(r.task_id)) submitted.set(r.task_id, at);
    } else if (!paid.has(r.task_id)) {
      const start = submitted.get(r.task_id);
      if (start !== undefined) {
        paid.add(r.task_id);
        durations.push(Math.max(0, at - start));
      }
    }
  }
  return durations;
}

export function escrowStats(db: Db) {
  const byState = all<{ state: string; n: number }>(db, "SELECT state, COUNT(*) AS n FROM tasks GROUP BY state");
  const batches = all<{ pay_per_task: string; unclaimed: number }>(db, "SELECT pay_per_task, unclaimed FROM batches");
  let value = 0n;
  for (const b of batches) value += BigInt(b.pay_per_task) * BigInt(b.unclaimed);
  for (const t of all<{ pay_base: string | null }>(db, `SELECT pay_base FROM tasks WHERE ${OPEN_FILTER}`)) {
    if (t.pay_base) value += BigInt(t.pay_base);
  }
  const released = all<{ path: string | null }>(db, "SELECT path FROM tasks WHERE state = 'Released'");
  const auto = released.filter((t) => t.path === "timeout" || t.path === "instant" || t.path === "dispute_timeout").length;
  const submitted = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM task_events WHERE name = 'TaskSubmitted'")?.n ?? 0;
  const disputed = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM task_events WHERE name IN ('TaskHeld','TaskDisputed')")?.n ?? 0;
  return {
    feed: "stats" as const,
    valueLocked: value.toString(),
    tasksByState: Object.fromEntries(byState.map((r) => [r.state, r.n])),
    medianSecondsToPay: median(secondsToPay(db)),
    autoReleaseShare: released.length ? auto / released.length : 0,
    disputeRate: submitted ? disputed / submitted : 0,
    ts: Math.floor(Date.now() / 1000),
  };
}

/** X4-06. What a freelancer wants to know before taking a lab's work: does it fund, does it pay on time, does it hold payouts. */
export function clientStats(db: Db, clientId: string) {
  const batches = all<{ id: string; pay_per_task: string; task_count: number; unclaimed: number; created_at: number }>(
    db,
    "SELECT id, pay_per_task, task_count, unclaimed, created_at FROM batches WHERE client_account_id = ? ORDER BY created_at ASC",
    clientId,
  );
  let funded = 0n;
  for (const b of batches) funded += BigInt(b.pay_per_task) * BigInt(b.task_count);
  const tasks = all<{ state: string; path: string | null; pay_base: string | null }>(
    db,
    "SELECT t.state, t.path, t.pay_base FROM tasks t JOIN batches b ON b.id = t.batch_id WHERE b.client_account_id = ?",
    clientId,
  );
  let paid = 0n;
  const byState: Record<string, number> = {};
  for (const t of tasks) {
    byState[t.state] = (byState[t.state] ?? 0) + 1;
    if (t.state === "Released" && t.pay_base) paid += BigInt(t.pay_base);
  }
  const submitted = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM task_events WHERE name = 'TaskSubmitted'
     AND task_id IN (SELECT t.task_id FROM tasks t JOIN batches b ON b.id = t.batch_id WHERE b.client_account_id = ?)`,
    clientId,
  )?.n ?? 0;
  const holds = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM task_events WHERE name IN ('TaskHeld','TaskDisputed')
     AND task_id IN (SELECT t.task_id FROM tasks t JOIN batches b ON b.id = t.batch_id WHERE b.client_account_id = ?)`,
    clientId,
  )?.n ?? 0;
  const released = tasks.filter((t) => t.state === "Released").length;
  const settled = tasks.filter((t) => t.state === "Released" || t.state === "Resolved" || t.state === "Refunded").length;
  return {
    feed: "client" as const,
    client: clientId,
    known: batches.length > 0,
    batches: batches.length,
    firstFundedAt: batches[0] ? Math.floor(batches[0].created_at / 1000) : null,
    fundedTotal: funded.toString(),
    paidToWorkers: paid.toString(),
    tasksByState: byState,
    medianSecondsToPay: median(secondsToPay(db, clientId)),
    paidShare: settled ? released / settled : 0,
    holdRate: submitted ? holds / submitted : 0,
    ts: Math.floor(Date.now() / 1000),
  };
}
