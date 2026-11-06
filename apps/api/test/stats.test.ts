import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb, run, type Db } from "../src/db";
import { clientStats, escrowStats, median, secondsToPay } from "../src/oracle/stats";

function freshDb(): Db {
  return openDb(join(mkdtempSync(join(tmpdir(), "byline-stats-")), "t.db"));
}

function batch(db: Db, id: string, client: string, pay: string, count: number, unclaimed: number) {
  run(
    db,
    `INSERT INTO batches (id, title, rubric, qa_mode, client_account_id, pay_per_task, task_count, unclaimed, review_window, work_window, revision_window, created_at)
     VALUES (?, 't', '[]', 'auto', ?, ?, ?, ?, 3600, 3600, 3600, ?)`,
    id, client, pay, count, unclaimed, 1_700_000_000_000,
  );
}

function task(db: Db, id: number, batchId: string, state: string, pay: string, path: string | null = null) {
  run(db, "INSERT INTO tasks (task_id, batch_id, state, pay_base, path, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, batchId, state, pay, path, 1);
}

function event(db: Db, hash: string, name: string, taskId: number, ts: string) {
  run(
    db,
    "INSERT INTO task_events (tx_hash, log_index, name, task_id, batch_id, payload, hcs_attempts, consensus_ts, created_at) VALUES (?, 0, ?, ?, NULL, '{}', 0, ?, 0)",
    hash, name, taskId, ts,
  );
}

test("median handles empty, odd and even inputs", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test("seconds to pay is a duration from the first submit to the payout, not a timestamp", () => {
  const db = freshDb();
  batch(db, "b1", "0.0.10", "40000000", 2, 0);
  task(db, 1, "b1", "Released", "40000000", "instant");
  task(db, 2, "b1", "Released", "40000000", "timeout");
  event(db, "a", "TaskSubmitted", 1, "1700000000.000000000");
  event(db, "b", "TaskReleased", 1, "1700000030.000000000");
  event(db, "c", "TaskSubmitted", 2, "1700000100.000000000");
  event(db, "d", "TaskSubmitted", 2, "1700000200.000000000"); // a resubmit does not restart the clock
  event(db, "e", "TaskReleased", 2, "1700000220.000000000");
  assert.deepEqual(secondsToPay(db).sort((x, y) => x - y), [30, 120]);
  assert.equal(escrowStats(db).medianSecondsToPay, 75);
});

test("client stats count only that client and keep money as base-unit strings", () => {
  const db = freshDb();
  batch(db, "mine", "0.0.10", "250000000", 2, 0);
  batch(db, "other", "0.0.99", "40000000", 1, 0);
  task(db, 1, "mine", "Released", "250000000", "approved");
  task(db, 2, "mine", "Disputed", "250000000");
  task(db, 3, "other", "Released", "40000000", "instant");
  event(db, "a", "TaskSubmitted", 1, "1700000000.0");
  event(db, "b", "TaskReleased", 1, "1700000060.0");
  event(db, "c", "TaskSubmitted", 2, "1700000000.0");
  event(db, "d", "TaskHeld", 2, "1700000010.0");
  event(db, "e", "TaskSubmitted", 3, "1700000000.0");
  event(db, "f", "TaskReleased", 3, "1700000005.0");

  const s = clientStats(db, "0.0.10");
  assert.equal(s.known, true);
  assert.equal(s.batches, 1);
  assert.equal(s.fundedTotal, "500000000");
  assert.equal(s.paidToWorkers, "250000000");
  assert.equal(s.medianSecondsToPay, 60);
  assert.equal(s.holdRate, 0.5);
  assert.equal(s.paidShare, 1);
  assert.deepEqual(s.tasksByState, { Released: 1, Disputed: 1 });
});

test("an unknown client is reported as unknown, not as a clean record", () => {
  const s = clientStats(freshDb(), "0.0.12345");
  assert.equal(s.known, false);
  assert.equal(s.batches, 0);
  assert.equal(s.fundedTotal, "0");
  assert.equal(s.medianSecondsToPay, null);
});
