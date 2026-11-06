/**
 * Mirror-node indexer. Polls contract logs, upserts by (txHash, logIndex),
 * and writes one HCS task message per transition. Restart-safe: a row that
 * already exists is not applied twice, and a missing HCS sequence is retried.
 */
import { decodeEventLog, keccak256, stringToBytes, type Hex } from "viem";
import {
  bytes32ToAscii,
  escrowAbi,
  hashscanContract,
  receiptMessage,
  taskMessage,
  type TaskEventName,
} from "@byline-work/shared";
import { config } from "./config";
import { accountInfo, knownAccountByEvm, mirrorBase, NotConfigured } from "./chain";
import { all, get, metaGet, metaSet, run, type Db } from "./db";
import { submitHcs } from "./hcs";
import { scheduleRelease } from "./schedule";

const ZERO = "0x0000000000000000000000000000000000000000";

type RawLog = {
  data?: string;
  topics?: string[];
  index?: number;
  timestamp?: string;
  transaction_hash?: string;
  transaction_id?: string;
};

function asHex(value: string | undefined): Hex {
  if (!value) return "0x";
  if (value.startsWith("0x")) return value as Hex;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) return `0x${value}` as Hex;
  return `0x${Buffer.from(value, "base64").toString("hex")}` as Hex;
}

function accountOf(db: Db, evm: string | undefined): string | undefined {
  if (!evm || evm.toLowerCase() === ZERO) return undefined;
  const known = knownAccountByEvm(evm);
  if (known) return known;
  const row = get<{ account_id: string | null }>(db, "SELECT account_id FROM workers WHERE lower(COALESCE(chain_evm, evm_address)) = ?", evm.toLowerCase());
  return row?.account_id || evm;
}

function num(v: bigint | number | undefined): number {
  return Number(v ?? 0);
}

function str(v: bigint | number | undefined): string {
  return (v ?? 0n).toString();
}

export async function indexerTick(db: Db): Promise<number> {
  if (!config.escrow.contractId) return 0;
  const from = metaGet(db, "indexer_ts") ?? "0.0";
  let url: string | null = `${mirrorBase()}/api/v1/contracts/${config.escrow.contractId}/results/logs?order=asc&limit=100&timestamp=gt:${encodeURIComponent(from)}`;
  let applied = 0;
  let lastTs = from;
  while (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`mirror logs ${res.status}`);
    const data = (await res.json()) as { logs?: RawLog[]; links?: { next?: string | null } };
    for (const log of data.logs ?? []) {
      const ts = log.timestamp ?? lastTs;
      if (ts > lastTs) lastTs = ts;
      if (await applyLog(db, log)) applied += 1;
    }
    url = data.links?.next ? `${mirrorBase()}${data.links.next}` : null;
    if ((data.logs?.length ?? 0) === 0) break;
  }
  if (lastTs !== from) metaSet(db, "indexer_ts", lastTs);
  await retryHcs(db);
  return applied;
}

async function applyLog(db: Db, log: RawLog): Promise<boolean> {
  const txHash = (log.transaction_hash ?? "").toLowerCase();
  const logIndex = log.index ?? 0;
  if (!txHash) return false;
  const seen = get(db, "SELECT tx_hash FROM task_events WHERE tx_hash = ? AND log_index = ?", txHash, logIndex);
  if (seen) return false;
  const topics = (log.topics ?? []).map(asHex) as [Hex, ...Hex[]];
  const data = asHex(log.data);
  if (topics.length === 0 || topics[0] === "0x") return false;
  let decoded: ReturnType<typeof decodeEventLog<typeof escrowAbi>>;
  try {
    decoded = decodeEventLog({ abi: escrowAbi, data, topics });
  } catch {
    return false;
  }
  const name = decoded.eventName;
  const args = decoded.args as Record<string, unknown>;
  const hcsEvent = HCS_NAME[name];
  const payload = jsonSafe(args);
  run(
    db,
    `INSERT INTO task_events (tx_hash, log_index, name, task_id, batch_id, payload, hcs_attempts, consensus_ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    txHash,
    logIndex,
    name,
    args.taskId !== undefined ? num(args.taskId as bigint) : null,
    typeof args.batchId === "string" ? args.batchId : null,
    JSON.stringify(payload),
    log.timestamp ?? null,
    Date.now(),
  );
  project(db, name, args, log.transaction_id ?? txHash);
  if (name === "TaskSubmitted") await maybeSchedule(db, args);
  if (hcsEvent) await publishEvent(db, txHash, logIndex, hcsEvent, args, log.transaction_id ?? "");
  const batchId = typeof args.batchId === "string" ? args.batchId : undefined;
  if (batchId) await maybeReceipt(db, batchId);
  return true;
}

const HCS_NAME: Record<string, TaskEventName | undefined> = {
  BatchFunded: "funded",
  TaskClaimed: "claimed",
  ClaimExpired: "expired",
  TaskSubmitted: "submitted",
  QaPassed: "qa_pass",
  QaFailed: "qa_fail",
  TaskApproved: "approved",
  TaskHeld: "held",
  TaskDisputed: "disputed",
  TaskReleased: "released",
  TaskRefunded: "refunded",
  TaskResolved: "resolved",
  UnclaimedWithdrawn: "withdrawn",
};

export function project(db: Db, name: string, args: Record<string, unknown>, txId: string) {
  const now = Date.now();
  const taskId = args.taskId !== undefined ? num(args.taskId as bigint) : null;
  const batchId = typeof args.batchId === "string" ? (args.batchId as Hex) : null;
  if (name === "BatchFunded" && batchId) {
    const count = num(args.taskCount as bigint);
    const exists = get(db, "SELECT id FROM batches WHERE id = ?", batchId);
    if (exists) {
      const taken = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE batch_id = ? AND state != 'Expired'", batchId);
      run(
        db,
        "UPDATE batches SET task_count = ?, pay_per_task = ?, client_evm = ?, funded_tx = COALESCE(funded_tx, ?), review_window = ?, work_window = ?, revision_window = ?, unclaimed = CASE WHEN ? = 0 THEN ? ELSE unclaimed END WHERE id = ?",
        count, str(args.payPerTask as bigint), String(args.client), txId, num(args.reviewWindow as bigint), num(args.workWindow as bigint), num(args.revisionWindow as bigint), Number(taken?.n ?? 0), count, batchId,
      );
    } else {
      run(
        db,
        `INSERT INTO batches (id, title, rubric, qa_mode, client_evm, pay_per_task, task_count, unclaimed, review_window, work_window, revision_window, funded_tx, created_at)
         VALUES (?, 'funded on-chain', '[]', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        batchId, String(args.client), str(args.payPerTask as bigint), count, count, num(args.reviewWindow as bigint), num(args.workWindow as bigint), num(args.revisionWindow as bigint), txId, now,
      );
    }
    return;
  }
  if (name === "TaskClaimed" && taskId && batchId) {
    const exists = get(db, "SELECT task_id FROM tasks WHERE task_id = ?", taskId);
    if (!exists) {
      run(
        db,
        `INSERT INTO tasks (task_id, batch_id, state, worker_evm, payout, work_deadline, pay_base, fail_count, updated_at)
         VALUES (?, ?, 'Claimed', ?, ?, ?, ?, 0, ?)`,
        taskId, batchId, String(args.worker), String(args.payout), num(args.workDeadline as bigint), str(args.pay as bigint), now,
      );
      run(db, "UPDATE batches SET unclaimed = CASE WHEN unclaimed > 0 THEN unclaimed - 1 ELSE 0 END WHERE id = ?", batchId);
      const worker = get<{ id: string }>(db, "SELECT id FROM workers WHERE lower(COALESCE(chain_evm, evm_address)) = ?", String(args.worker).toLowerCase());
      if (worker) run(db, "UPDATE tasks SET worker_id = ? WHERE task_id = ?", worker.id, taskId);
      const item = get<{ idx: number }>(db, "SELECT idx FROM batch_items WHERE batch_id = ? AND task_id IS NULL ORDER BY idx LIMIT 1", batchId);
      if (item) run(db, "UPDATE batch_items SET task_id = ? WHERE batch_id = ? AND idx = ?", taskId, batchId, item.idx);
    } else {
      run(
        db,
        "UPDATE tasks SET work_deadline = ?, payout = ?, pay_base = ?, worker_evm = COALESCE(worker_evm, ?) WHERE task_id = ?",
        num(args.workDeadline as bigint), String(args.payout), str(args.pay as bigint), String(args.worker), taskId,
      );
    }
    return;
  }
  if (!taskId) {
    if (name === "UnclaimedWithdrawn" && batchId) {
      run(db, "UPDATE batches SET unclaimed = CASE WHEN unclaimed >= ? THEN unclaimed - ? ELSE 0 END WHERE id = ?", num(args.count as bigint), num(args.count as bigint), batchId);
    }
    return;
  }
  const patch = (sql: string, ...params: unknown[]) => run(db, `UPDATE tasks SET ${sql}, updated_at = ? WHERE task_id = ?`, ...params, now, taskId);
  if (name === "ClaimExpired") {
    const row = get<{ state: string }>(db, "SELECT state FROM tasks WHERE task_id = ?", taskId);
    if (row && row.state !== "Expired") {
      patch("state = 'Expired'");
      if (batchId) run(db, "UPDATE batches SET unclaimed = unclaimed + 1 WHERE id = ?", batchId);
    }
  } else if (name === "TaskSubmitted") {
    const schedule = String(args.schedule ?? "");
    patch(
      "state = 'Submitted', work_hash = ?, review_deadline = ?, schedule_address = ?",
      String(args.workHash), num(args.reviewDeadline as bigint), schedule.toLowerCase() === ZERO ? null : schedule,
    );
  } else if (name === "QaPassed") {
    if (args.awaitingApproval) patch("state = 'AwaitingApproval', report_hash = ?", String(args.reportHash));
    else patch("report_hash = ?", String(args.reportHash));
  } else if (name === "QaFailed") {
    const fails = num(args.failCount as bigint);
    patch("state = ?, reason_hash = ?, fail_count = ?, action_deadline = ?", fails <= 1 ? "Revising" : "Failed", String(args.reasonHash), fails, num(args.actionDeadline as bigint));
  } else if (name === "TaskHeld" || name === "TaskDisputed") {
    patch("state = 'Disputed', reason_hash = ?, dispute_deadline = ?", String(args.reasonHash), num(args.disputeDeadline as bigint));
  } else if (name === "TaskReleased") {
    const paid = str(args.pay as bigint);
    patch("state = 'Released', payout = ?, pay_base = ?, path = ?, worker_amount = ?", String(args.payout), paid, bytes32ToAscii(String(args.path ?? "0x")), paid);
  } else if (name === "TaskRefunded") {
    patch("state = 'Refunded'");
  } else if (name === "TaskResolved") {
    patch("state = 'Resolved', worker_amount = ?, path = 'resolved'", str(args.workerAmount as bigint));
  }
}

function releasePath(event: TaskEventName, args: Record<string, unknown>): "instant" | "approved" | "timeout" | "dispute_timeout" | undefined {
  if (event !== "released") return undefined;
  const raw = bytes32ToAscii(String(args.path ?? "0x"));
  if (raw === "instant" || raw === "approved" || raw === "timeout" || raw === "dispute_timeout") return raw;
  return undefined;
}

async function publishEvent(db: Db, txHash: string, logIndex: number, event: TaskEventName, args: Record<string, unknown>, txId: string) {
  let workerEvm = typeof args.worker === "string" ? args.worker : typeof args.payout === "string" ? args.payout : undefined;
  if (!workerEvm && args.taskId !== undefined) {
    workerEvm = get<{ worker_evm: string | null }>(db, "SELECT worker_evm FROM tasks WHERE task_id = ?", num(args.taskId as bigint))?.worker_evm ?? undefined;
  }
  const worker = accountOf(db, workerEvm);
  let clientEvm = typeof args.client === "string" ? args.client : undefined;
  const batchForClient = typeof args.batchId === "string" ? args.batchId : get<{ batch_id: string }>(db, "SELECT batch_id FROM tasks WHERE task_id = ?", num(args.taskId as bigint))?.batch_id;
  if (!clientEvm && batchForClient) {
    const batch = get<{ client_account_id: string | null; client_evm: string | null }>(db, "SELECT client_account_id, client_evm FROM batches WHERE id = ?", batchForClient);
    clientEvm = batch?.client_account_id ?? batch?.client_evm ?? undefined;
  }
  const client = clientEvm && clientEvm.startsWith("0x") ? accountOf(db, clientEvm) : clientEvm;
  const schedule = scheduleRef(db, args);
  const amount = args.pay ?? args.amount ?? args.total ?? args.workerAmount;
  try {
    const msg = taskMessage({
      event,
      batchId: typeof args.batchId === "string" ? (args.batchId as Hex) : undefined,
      taskId: args.taskId !== undefined ? num(args.taskId as bigint) : undefined,
      worker,
      client,
      amount: amount !== undefined ? str(amount as bigint) : undefined,
      token: config.token.id || undefined,
      workHash: typeof args.workHash === "string" ? (args.workHash as Hex) : undefined,
      reportHash: typeof args.reportHash === "string" ? (args.reportHash as Hex) : undefined,
      reasonHash: typeof args.reasonHash === "string" ? (args.reasonHash as Hex) : undefined,
      path: releasePath(event, args),
      tx: txId || undefined,
      scheduleId: schedule,
      workerBps: args.workerBps !== undefined ? num(args.workerBps as bigint) : undefined,
      ts: Math.floor(Date.now() / 1000),
    });
    if (event === "resolved" && num(args.workerBps as bigint) === 0) {
      /* dispute lost is derived by the score reader from workerBps 0; the field is already on the message */
    }
    const sent = await submitHcs(msg);
    run(db, "UPDATE task_events SET hcs_sequence = ?, hcs_topic = ?, hcs_error = NULL WHERE tx_hash = ? AND log_index = ?", sent.sequence, sent.topicId, txHash, logIndex);
  } catch (e: unknown) {
    const message = e instanceof NotConfigured ? e.message : e instanceof Error ? e.message : String(e);
    run(db, "UPDATE task_events SET hcs_error = ?, hcs_attempts = hcs_attempts + 1 WHERE tx_hash = ? AND log_index = ?", message.slice(0, 400), txHash, logIndex);
  }
}

function scheduleRef(db: Db, args: Record<string, unknown>): string | undefined {
  if (args.taskId === undefined) return undefined;
  const row = get<{ schedule_id: string | null }>(db, "SELECT schedule_id FROM tasks WHERE task_id = ?", num(args.taskId as bigint));
  if (row?.schedule_id) return row.schedule_id;
  const addr = typeof args.schedule === "string" ? args.schedule : "";
  if (addr && addr.toLowerCase() !== ZERO) return addr;
  return undefined;
}

async function maybeSchedule(db: Db, args: Record<string, unknown>) {
  if (config.escrow.scheduling !== "sdk") return;
  const addr = String(args.schedule ?? "");
  if (addr && addr.toLowerCase() !== ZERO) return;
  if (args.taskId === undefined) return;
  try {
    await scheduleRelease(db, BigInt(num(args.taskId as bigint)), num(args.reviewDeadline as bigint));
  } catch (e: unknown) {
    console.error("[schedule]", e instanceof Error ? e.message : e);
  }
}

async function maybeReceipt(db: Db, batchId: string) {
  const batch = get<{ receipt_sequence: number | null; title: string; rubric: string; unclaimed: number }>(db, "SELECT receipt_sequence, title, rubric, unclaimed FROM batches WHERE id = ?", batchId);
  if (!batch || batch.receipt_sequence || batch.unclaimed > 0) return;
  const open = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM tasks WHERE batch_id = ? AND state NOT IN ('Released', 'Refunded', 'Resolved', 'Expired')`,
    batchId,
  );
  if ((open?.n ?? 1) > 0) return;
  const tasks = all<{ work_hash: string | null; worker_id: string | null; worker_amount: string | null; pay_base: string | null; state: string }>(
    db,
    "SELECT work_hash, worker_id, worker_amount, pay_base, state FROM tasks WHERE batch_id = ?",
    batchId,
  );
  const hashes = tasks.map((t) => t.work_hash).filter((h): h is string => !!h && h !== `0x${"0".repeat(64)}`);
  let paid = 0n;
  const humans = new Set<string>();
  for (const t of tasks) {
    if (t.state === "Released" || t.state === "Resolved") {
      paid += BigInt(t.worker_amount || t.pay_base || "0");
      if (t.worker_id) {
        const w = get<{ kind: string }>(db, "SELECT kind FROM workers WHERE id = ?", t.worker_id);
        if (w?.kind === "world") humans.add(t.worker_id);
      }
    }
  }
  const termsHash = keccak256(stringToBytes(`${batch.title}\n${batch.rubric}`));
  try {
    const msg = receiptMessage({
      batchId: batchId as Hex,
      taskHashes: hashes as Hex[],
      verifiedHumans: humans.size,
      totalPaid: paid.toString(),
      termsHash,
      ts: Math.floor(Date.now() / 1000),
    });
    const sent = await submitHcs(msg);
    run(db, "UPDATE batches SET receipt_sequence = ? WHERE id = ?", sent.sequence, batchId);
  } catch (e: unknown) {
    console.error("[receipt]", e instanceof Error ? e.message : e);
  }
}

async function retryHcs(db: Db) {
  const rows = all<{ tx_hash: string; log_index: number; name: string; payload: string }>(
    db,
    "SELECT tx_hash, log_index, name, payload FROM task_events WHERE hcs_sequence IS NULL AND hcs_attempts < 8 AND name IN ('BatchFunded','TaskClaimed','ClaimExpired','TaskSubmitted','QaPassed','QaFailed','TaskApproved','TaskHeld','TaskDisputed','TaskReleased','TaskRefunded','TaskResolved','UnclaimedWithdrawn') LIMIT 20",
  );
  for (const row of rows) {
    const event = HCS_NAME[row.name];
    if (!event) continue;
    const args = JSON.parse(row.payload) as Record<string, unknown>;
    await publishEvent(db, row.tx_hash, row.log_index, event, revive(args), "");
  }
}

function jsonSafe(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

function revive(args: Record<string, unknown>): Record<string, unknown> {
  const numeric = new Set(["taskId", "pay", "fee", "total", "amount", "workerAmount", "clientAmount", "feeAmount", "payPerTask", "taskCount", "workDeadline", "reviewDeadline", "actionDeadline", "disputeDeadline", "failCount", "workerBps", "count", "reviewWindow", "workWindow", "revisionWindow"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (numeric.has(k) && typeof v === "string" && /^\d+$/.test(v)) out[k] = BigInt(v);
    else out[k] = v;
  }
  return out;
}

export function scheduleLink(scheduleId: string | null, scheduleAddress: string | null): string | undefined {
  if (scheduleId && /^0\.0\.\d+$/.test(scheduleId)) return `https://hashscan.io/${config.hedera.network === "hedera:mainnet" ? "mainnet" : "testnet"}/schedule/${scheduleId}`;
  if (scheduleAddress && scheduleAddress.toLowerCase() !== ZERO) return hashscanContract(scheduleAddress, config.hedera.network);
  return undefined;
}
