import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { get, openDb, run, type BatchRow, type Db, type TaskRow } from "../src/db";
import { project } from "../src/indexer";

const B = `0x${"ab".repeat(32)}`;
const HASH = `0x${"cd".repeat(32)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const WORKER = "0x1111111111111111111111111111111111111111";
const PAYOUT = "0x2222222222222222222222222222222222222222";

function fresh(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "byline-idx-")), "t.db"));
  return db;
}

function funded(db: Db, count = 2) {
  project(db, "BatchFunded", { batchId: B, client: "0xc1", taskCount: BigInt(count), payPerTask: 40_000_000n, reviewWindow: 3600n, workWindow: 3600n, revisionWindow: 3600n }, "tx-fund");
}

function claimed(db: Db, taskId: bigint) {
  project(db, "TaskClaimed", { taskId, batchId: B, worker: WORKER, payout: PAYOUT, workDeadline: 1000n, pay: 40_000_000n }, "tx-claim");
}

const task = (db: Db, id: number) => get<TaskRow>(db, "SELECT * FROM tasks WHERE task_id = ?", id)!;
const batch = (db: Db) => get<BatchRow>(db, "SELECT * FROM batches WHERE id = ?", B)!;

test("a funded batch with no local row is created from the event", () => {
  const db = fresh();
  funded(db, 3);
  assert.equal(batch(db).unclaimed, 3);
  assert.equal(batch(db).pay_per_task, "40000000");
});

test("a claim takes a task from the pool, an expired claim gives it back once", () => {
  const db = fresh();
  funded(db);
  claimed(db, 1n);
  assert.equal(task(db, 1).state, "Claimed");
  assert.equal(batch(db).unclaimed, 1);
  project(db, "ClaimExpired", { taskId: 1n, batchId: B, worker: WORKER }, "tx-exp");
  project(db, "ClaimExpired", { taskId: 1n, batchId: B, worker: WORKER }, "tx-exp2");
  assert.equal(task(db, 1).state, "Expired");
  assert.equal(batch(db).unclaimed, 2);
});

test("submit, then a QA pass over the threshold waits for approval, then release is final", () => {
  const db = fresh();
  funded(db, 1);
  claimed(db, 1n);
  project(db, "TaskSubmitted", { taskId: 1n, batchId: B, workHash: HASH, reviewDeadline: 5000n, schedule: ZERO, resubmitted: false }, "tx-sub");
  assert.equal(task(db, 1).state, "Submitted");
  assert.equal(task(db, 1).review_deadline, 5000);
  assert.equal(task(db, 1).schedule_address, null, "a zero schedule address means no schedule");
  project(db, "QaPassed", { taskId: 1n, batchId: B, reportHash: HASH, awaitingApproval: true, pay: 250_000_000n }, "tx-qa");
  assert.equal(task(db, 1).state, "AwaitingApproval");
  project(db, "TaskReleased", { taskId: 1n, batchId: B, payout: PAYOUT, pay: 250_000_000n, fee: 7_500_000n, path: `0x${Buffer.from("approved").toString("hex").padEnd(64, "0")}` }, "tx-rel");
  assert.equal(task(db, 1).state, "Released");
  assert.equal(task(db, 1).path, "approved");
});

test("an instant pass stays Submitted until the release event in the same transaction", () => {
  const db = fresh();
  funded(db, 1);
  claimed(db, 1n);
  project(db, "TaskSubmitted", { taskId: 1n, batchId: B, workHash: HASH, reviewDeadline: 5000n, schedule: "0x00000000000000000000000000000000000000aa", resubmitted: false }, "tx-sub");
  project(db, "QaPassed", { taskId: 1n, batchId: B, reportHash: HASH, awaitingApproval: false, pay: 40_000_000n }, "tx-qa");
  assert.equal(task(db, 1).state, "Submitted");
  assert.equal(task(db, 1).schedule_address, "0x00000000000000000000000000000000000000aa");
});

test("the first QA failure opens a revision, the second closes the task as Failed", () => {
  const db = fresh();
  funded(db, 1);
  claimed(db, 1n);
  project(db, "QaFailed", { taskId: 1n, batchId: B, reasonHash: HASH, failCount: 1, actionDeadline: 9000n }, "tx-f1");
  assert.equal(task(db, 1).state, "Revising");
  project(db, "QaFailed", { taskId: 1n, batchId: B, reasonHash: HASH, failCount: 2, actionDeadline: 9500n }, "tx-f2");
  assert.equal(task(db, 1).state, "Failed");
  assert.equal(task(db, 1).action_deadline, 9500);
});

test("a hold moves a task to Disputed with its dispute deadline", () => {
  const db = fresh();
  funded(db, 1);
  claimed(db, 1n);
  project(db, "TaskHeld", { taskId: 1n, batchId: B, reasonHash: HASH, disputeDeadline: 7000n }, "tx-held");
  assert.equal(task(db, 1).state, "Disputed");
  assert.equal(task(db, 1).dispute_deadline, 7000);
});

test("ESC-22: a recorded first approval does not change the task state", () => {
  const db = fresh();
  funded(db, 1);
  claimed(db, 1n);
  project(db, "QaPassed", { taskId: 1n, batchId: B, reportHash: HASH, awaitingApproval: true, pay: 2_000_000_000n }, "tx-qa");
  project(db, "ApprovalRecorded", { taskId: 1n, batchId: B, reviewer: WORKER }, "tx-appr");
  assert.equal(task(db, 1).state, "AwaitingApproval");
});

test("a worker is matched by the on-chain identity even after a payout change", () => {
  const db = fresh();
  run(db, "INSERT INTO workers (id, kind, label, evm_address, chain_evm, created_at) VALUES ('w1', 'demo', 'demo human', ?, ?, 1)", PAYOUT, WORKER);
  funded(db, 1);
  claimed(db, 1n);
  assert.equal(task(db, 1).worker_id, "w1");
});
