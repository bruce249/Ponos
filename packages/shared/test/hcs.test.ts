import assert from "node:assert/strict";
import { test } from "node:test";
import { HcsSchemaError, messageBytes, parseHcsMessage, receiptMessage, taskMessage } from "../src/hcs";

const batch = `0x${"ab".repeat(32)}`;
const hash = `0x${"cd".repeat(32)}`;

test("a task message stays under 1024 bytes", () => {
  const msg = taskMessage({
    event: "released",
    batchId: batch,
    taskId: 42,
    worker: "0.0.1001",
    client: "0.0.1002",
    amount: "250000000",
    token: "0.0.5000",
    workHash: hash,
    reportHash: hash,
    path: "approved",
    tx: "0.0.9@1700000000.000000001",
    scheduleId: "0.0.777",
    ts: 1_700_000_000,
  });
  assert.ok(messageBytes(msg) < 1024);
  assert.equal(msg.kind, "task");
  assert.equal(msg.v, 3);
});

test("a World sub is rejected on the message and anywhere nested", () => {
  assert.throws(
    () => parseHcsMessage({ v: 3, kind: "task", event: "claimed", worker: "0.0.1", sub: "world-subject", ts: 1 }),
    HcsSchemaError,
  );
  assert.throws(
    () => parseHcsMessage({ v: 3, kind: "feed", feed: "nav", hash, ts: 1, extra: { world_sub: "abc" } }),
    HcsSchemaError,
  );
  assert.throws(
    () => parseHcsMessage({ v: 3, kind: "task", event: "claimed", worker: "not-an-account-and-not-an-address", ts: 1 }),
    HcsSchemaError,
  );
});

test("oversized messages are rejected and a fat receipt falls back to a root", () => {
  const hashes = Array.from({ length: 40 }, () => hash);
  assert.throws(() => parseHcsMessage({ v: 3, kind: "receipt", batchId: batch, taskHashes: hashes, verifiedHumans: 1, totalPaid: "1", termsHash: hash, ts: 1 }));
  const msg = receiptMessage({ batchId: batch, taskHashes: hashes, verifiedHumans: 3, totalPaid: "400000000", termsHash: hash, ts: 1 });
  assert.ok(messageBytes(msg) <= 1024);
  assert.equal("taskHashes" in msg, false);
  assert.match(msg.hashesRoot ?? "", /^0x[0-9a-f]{64}$/);
});
