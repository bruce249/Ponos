import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gradeSubmission } from "../src/qa/grade";
import { clientStatsView, median, navRatio, statsView } from "../src/oracle/x402";
import { openDb, run } from "../src/db";

test("auto QA passes only an exact gold answer with every checklist item ticked", () => {
  const gold = { answer: "42" };
  assert.equal(gradeSubmission({ answers: { answer: " 42 " }, checklist: { tests: true } }, gold, ["tests"]).pass, true);
  const wrong = gradeSubmission({ answers: { answer: "41" }, checklist: { tests: true } }, gold, ["tests"]);
  assert.equal(wrong.pass, false);
  assert.deepEqual(wrong.reasons, ["gold mismatch: answer"]);
  const unticked = gradeSubmission({ answers: { answer: "42" }, checklist: {} }, gold, ["tests"]);
  assert.deepEqual(unticked.reasons, ["checklist missing: tests"]);
});

test("the QA report hash is deterministic, so anyone can recompute it from the stored report", () => {
  const a = gradeSubmission({ answers: { answer: "x" }, checklist: {} }, { answer: "y" }, []);
  const b = gradeSubmission({ answers: { answer: "x" }, checklist: {} }, { answer: "y" }, []);
  assert.equal(a.reportHash, b.reportHash);
  assert.match(a.reportHash, /^0x[0-9a-f]{64}$/);
});

test("NAV is reserve / supply with six places and no float drift", () => {
  assert.equal(navRatio(1_000_000_000n, 1_000_000_000n), "1");
  assert.equal(navRatio(999_999_999n, 1_000_000_000n), "0.999999");
  assert.equal(navRatio(1n, 3n), "0.333333");
  assert.equal(navRatio(5n, 0n), null);
});

test("median is the lower middle and null when empty", () => {
  assert.equal(median([]), null);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2);
});

test("escrow stats report seconds from first submit to release, and client stats stay per lab", () => {
  const dir = mkdtempSync(join(tmpdir(), "byline-stats-"));
  const db = openDb(join(dir, "s.db"));
  try {
    const batch = (id: string, client: string) =>
      run(db, "INSERT INTO batches (id, title, rubric, qa_mode, client_account_id, pay_per_task, task_count, unclaimed, review_window, work_window, revision_window, funded_tx, created_at) VALUES (?, 't', '[]', 'auto', ?, '40000000', 2, 0, 120, 120, 120, 'tx', 1700000000000)", id, client);
    batch("0xa", "0.0.100");
    batch("0xb", "0.0.200");
    const ev = (tx: string, name: string, taskId: number, batchId: string, ts: string, payload = "{}") =>
      run(db, "INSERT INTO task_events (tx_hash, log_index, name, task_id, batch_id, payload, consensus_ts, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, 0)", tx, name, taskId, batchId, payload, ts);
    ev("t1", "TaskSubmitted", 1, "0xa", "1700000000.000000001");
    ev("t2", "TaskReleased", 1, "0xa", "1700000030.000000001");
    ev("t3", "TaskSubmitted", 2, "0xa", "1700000100.000000001");
    ev("t4", "TaskSubmitted", 2, "0xa", "1700000150.000000001"); // a resubmit does not reset the clock
    ev("t5", "TaskReleased", 2, "0xa", "1700000190.000000001");
    ev("t6", "TaskSubmitted", 3, "0xb", "1700000000.000000001");
    ev("t7", "TaskHeld", 3, "0xb", "1700000010.000000001");
    ev("t8", "TaskResolved", 3, "0xb", "1700000020.000000001", JSON.stringify({ workerBps: "0" }));

    assert.equal(statsView(db).medianSecondsToPay, 30);
    const a = clientStatsView(db, "0.0.100");
    assert.equal(a.batches, 1);
    assert.equal(a.medianSecondsToPay, 30);
    assert.equal(a.holdRate, 0);
    const b = clientStatsView(db, "0.0.200");
    assert.equal(b.holdRate, 1);
    assert.equal(b.disputesWorkerLost, 1);
    assert.equal(b.medianSecondsToPay, null);
    assert.equal(clientStatsView(db, "0.0.999").batches, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
