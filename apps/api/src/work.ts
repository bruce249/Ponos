/**
 * Batch, claim, submit, and payout binding. Work bodies and gold answers stay in SQLite.
 * The relayer sends claimFor / submitFor / resubmitFor / disputeFor. Pay above 100 bUSD
 * also consumes a single-use claim_high approval. The payout address is whatever is
 * registered at claim time; a later wallet change does not move an existing task.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { keccak256, stringToBytes, type Hex } from "viem";
import {
  baseToDecimal,
  decimalToBase,
  hashscanAccount,
  hashscanContract,
  hashscanToken,
  hashscanTx,
  requiresStepUp,
  type BatchCreateRequest,
  type BatchCreateResponse,
  type ClaimResponse,
  type HashScanLinks,
  type QaMode,
  type SubmitResponse,
  type TaskFeedItem,
  type TaskView,
  type WorkSubmission,
} from "@byline-work/shared";
import { banGate, claimCapGate, recordClaim, recordDenial } from "./caps";
import { config, labAllowlist } from "./config";
import { accountInfo, EscrowCallError, evmAddressFromKey, NotConfigured } from "./chain";
import { all, chainEvm, get, run, type BatchRow, type Db, type TaskRow, type WorkerRow } from "./db";
import { claimFor, disputeFor, fundBatch, registerWorker, resubmitFor, setWorkerPayout, submitFor } from "./escrow";
import { scheduleLink } from "./indexer";
import { gradeTask } from "./qa/loop";
import { consumeApproval } from "./world";

const CUSTODY = "Server-held lab key (demo custody).";

export function links(extra: Partial<HashScanLinks> = {}): HashScanLinks {
  return {
    contract: config.escrow.contractId ? hashscanContract(config.escrow.contractId, config.hedera.network) : undefined,
    token: config.token.id ? hashscanToken(config.token.id, config.hedera.network) : undefined,
    ...extra,
  };
}

function windowOk(name: string, value: number) {
  if (!Number.isInteger(value) || value < config.escrow.minWindow || value > config.escrow.maxWindow) {
    throw new Error(`${name} must be between ${config.escrow.minWindow} and ${config.escrow.maxWindow} seconds`);
  }
}

export async function createBatch(db: Db, input: BatchCreateRequest): Promise<BatchCreateResponse> {
  if (!labAllowlist().includes(input.labAccountId)) throw new Error("This account is not on the lab allowlist.");
  if (input.qaMode !== "auto" && input.qaMode !== "manual") throw new Error("qaMode must be auto or manual");
  if (!Number.isInteger(input.taskCount) || input.taskCount < 1) throw new Error("taskCount must be a positive integer");
  if (input.tasks.length !== input.taskCount) throw new Error("tasks must contain one private prompt per task");
  windowOk("reviewWindow", input.reviewWindow);
  windowOk("workWindow", input.workWindow);
  windowOk("revisionWindow", input.revisionWindow);
  const pay = decimalToBase(input.payPerTask);
  const batchId = `0x${randomBytes(32).toString("hex")}` as Hex;
  const now = Date.now();
  run(
    db,
    `INSERT INTO batches (id, title, rubric, qa_mode, client_account_id, pay_per_task, task_count, unclaimed, review_window, work_window, revision_window, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batchId, input.title, JSON.stringify(input.rubric), input.qaMode, input.labAccountId, pay.toString(), input.taskCount, input.taskCount,
    input.reviewWindow, input.workWindow, input.revisionWindow, now,
  );
  const insert = db.prepare("INSERT INTO batch_items (batch_id, idx, prompt, gold_json, checklist_json) VALUES (?, ?, ?, ?, ?)");
  input.tasks.forEach((task, idx) => insert.run(batchId, idx, task.prompt, JSON.stringify(task.gold), JSON.stringify(task.checklist)));
  const funded = await fundBatch({
    batchId,
    taskCount: input.taskCount,
    payPerTask: pay,
    reviewWindow: input.reviewWindow,
    workWindow: input.workWindow,
    revisionWindow: input.revisionWindow,
  });
  run(db, "UPDATE batches SET funded_tx = ?, client_evm = ? WHERE id = ?", funded.txId, evmAddressFromKey(config.roles.lab.privateKey), batchId);
  return {
    batchId,
    txId: funded.txId,
    totalBase: funded.total.toString(),
    totalDecimal: baseToDecimal(funded.total),
    custody: "demo",
    custodyNote: CUSTODY,
    hashscan: links({ tx: hashscanTx(funded.txId, config.hedera.network) }),
  };
}

export function feed(db: Db): TaskFeedItem[] {
  return all<BatchRow>(db, "SELECT * FROM batches WHERE unclaimed > 0 AND funded_tx IS NOT NULL ORDER BY created_at DESC").map((b) => ({
    batchId: b.id,
    title: b.title,
    qaMode: b.qa_mode,
    unclaimed: b.unclaimed,
    payBase: b.pay_per_task,
    payDecimal: baseToDecimal(BigInt(b.pay_per_task)),
    requiresStepUp: requiresStepUp(BigInt(b.pay_per_task)),
    workWindow: b.work_window,
    reviewWindow: b.review_window,
  }));
}

export async function claim(db: Db, worker: WorkerRow, batchId: string, approvalId?: string): Promise<ClaimResponse> {
  const banned = banGate(worker);
  if (!banned.ok) {
    recordDenial(db, worker.id, "claim", batchId, banned.reason, banned.detail);
    throw Object.assign(new Error(banned.detail), { status: 403, reason: banned.reason });
  }
  const cap = claimCapGate(db, worker.id);
  if (!cap.ok) {
    recordDenial(db, worker.id, "claim", batchId, cap.reason, cap.detail);
    throw Object.assign(new Error(cap.detail), { status: 429, reason: cap.reason });
  }
  const batch = get<BatchRow>(db, "SELECT * FROM batches WHERE id = ?", batchId);
  if (!batch?.funded_tx) throw Object.assign(new Error("Unknown or unfunded batch"), { status: 404 });
  const onChain = chainEvm(worker);
  if (!worker.evm_address || !onChain) throw Object.assign(new Error("Bind a payout account before claiming."), { status: 400 });
  const pay = BigInt(batch.pay_per_task);
  if (requiresStepUp(pay)) {
    if (worker.kind !== "world") throw Object.assign(new Error("Tasks over 100 bUSD need a World ID step-up. A demo human cannot claim them."), { status: 403 });
    if (!approvalId) throw Object.assign(new Error("This task pays more than 100 bUSD. Complete a claim_high step-up for this batch."), { status: 403, reason: "wrong_action" });
    const used = consumeApproval(db, approvalId, worker.id, "claim_high", batchId);
    if (!used.ok) throw Object.assign(new Error(used.detail), { status: 403, reason: used.reason });
  }
  const sent = await claimFor(batchId as Hex, onChain as Hex);
  const taskId = Number(sent.taskId);
  const now = Date.now();
  const deadline = Math.floor(now / 1000) + batch.work_window;
  run(
    db,
    `INSERT INTO tasks (task_id, batch_id, state, worker_id, worker_evm, payout, work_deadline, pay_base, fail_count, updated_at)
     VALUES (?, ?, 'Claimed', ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(task_id) DO UPDATE SET worker_id = excluded.worker_id, worker_evm = excluded.worker_evm, payout = excluded.payout, state = 'Claimed'`,
    taskId, batchId, worker.id, onChain, worker.evm_address, deadline, pay.toString(), now,
  );
  run(db, "UPDATE batches SET unclaimed = CASE WHEN unclaimed > 0 THEN unclaimed - 1 ELSE 0 END WHERE id = ?", batchId);
  const item = get<{ idx: number }>(db, "SELECT idx FROM batch_items WHERE batch_id = ? AND task_id IS NULL ORDER BY idx LIMIT 1", batchId);
  if (item) run(db, "UPDATE batch_items SET task_id = ? WHERE batch_id = ? AND idx = ?", taskId, batchId, item.idx);
  recordClaim(db, worker.id, batchId, taskId);
  return { taskId: String(taskId), txId: sent.txId, workDeadline: deadline, hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network) }) };
}

function hashBody(body: string): Hex {
  return `0x${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export async function submit(db: Db, worker: WorkerRow, taskId: number, submission: WorkSubmission, resubmit: boolean): Promise<SubmitResponse> {
  const task = get<TaskRow>(db, "SELECT * FROM tasks WHERE task_id = ?", taskId);
  if (!task || task.worker_id !== worker.id) throw Object.assign(new Error("This task is not yours."), { status: 404 });
  const body = JSON.stringify(submission);
  const workHash = hashBody(body);
  run(db, "INSERT INTO work (id, task_id, worker_id, body, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), taskId, worker.id, body, workHash, Date.now());
  const sent = resubmit ? await resubmitFor(BigInt(taskId), workHash) : await submitFor(BigInt(taskId), workHash);
  // The chain call succeeded, so the escrow is in Submitted. Record that now: the indexer only learns it from the
  // mirror node seconds later, and gradeTask refuses tasks that are not Submitted, so auto QA would otherwise
  // wait for the 10 s QA loop. The indexer applies the same fields (plus the deadline and schedule) idempotently.
  run(db, "UPDATE tasks SET state = 'Submitted', work_hash = ?, updated_at = ? WHERE task_id = ?", workHash, Date.now(), taskId);
  const batch = get<BatchRow>(db, "SELECT * FROM batches WHERE id = ?", task.batch_id);
  let qa: SubmitResponse["qa"];
  if (batch?.qa_mode === "auto") {
    const graded = await gradeTask(db, taskId);
    if (graded) qa = { pass: graded.pass, reportHash: graded.reportHash };
  }
  return {
    taskId: String(taskId),
    workHash,
    txId: sent.txId,
    reviewDeadline: null,
    scheduleId: null,
    qa,
    hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network) }),
  };
}

export async function dispute(db: Db, worker: WorkerRow, taskId: number, reason: string) {
  const task = get<TaskRow>(db, "SELECT * FROM tasks WHERE task_id = ?", taskId);
  if (!task || task.worker_id !== worker.id) throw Object.assign(new Error("This task is not yours."), { status: 404 });
  const reasonHash = keccak256(stringToBytes(reason));
  run(db, "UPDATE tasks SET reason_text = ? WHERE task_id = ?", reason, taskId);
  const sent = await disputeFor(BigInt(taskId), reasonHash);
  return { txId: sent.txId, reasonHash, hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network) }) };
}

export async function bindPayout(db: Db, worker: WorkerRow, accountId: string, approvalId: string | null) {
  if (worker.kind === "world") {
    if (!approvalId) throw Object.assign(new Error("Changing or setting a payout wallet needs a payout_wallet step-up."), { status: 403 });
    const used = consumeApproval(db, approvalId, worker.id, "payout_wallet", accountId);
    if (!used.ok) throw Object.assign(new Error(used.detail), { status: 403, reason: used.reason });
  }
  const info = await accountInfo(accountId);
  if (!info) throw Object.assign(new Error("That Hedera account does not exist on the mirror node."), { status: 400 });
  if (info.maxAutoAssoc === 0) throw Object.assign(new Error("That account cannot receive bUSD. It needs automatic token association or an existing association."), { status: 400 });
  const { kyc: grantKyc } = await import("../../../stablecoin/lifecycle");
  const kycTx = await grantKyc(accountId);
  const evm = info.evmAddress;
  const already = chainEvm(worker);
  const sent = already
    ? await setWorkerPayout(already as Hex, evm)
    : await registerWorker(evm, evm, config.caps.inFlightNew);
  run(db, "UPDATE workers SET account_id = ?, evm_address = ?, chain_evm = COALESCE(chain_evm, ?) WHERE id = ?", accountId, evm, already ?? evm, worker.id);
  return {
    txId: sent.txId,
    kycTx,
    evmAddress: evm,
    custody: worker.kind === "demo" ? "demo" : undefined,
    label: worker.label,
    note: "The payout address is fixed when a task is claimed. This change applies to claims made after it.",
    hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network), account: hashscanAccount(accountId, config.hedera.network) }),
  };
}

function countdown(task: TaskRow, now: number): { secondsRemaining: number | null; countdownTarget: TaskView["countdownTarget"] } {
  const left = (deadline: number | null) => (deadline ? deadline - now : null);
  if (task.state === "Claimed") return { secondsRemaining: left(task.work_deadline), countdownTarget: "work" };
  if (task.state === "Submitted" || task.state === "AwaitingApproval") return { secondsRemaining: left(task.review_deadline), countdownTarget: "review" };
  if (task.state === "Revising" || task.state === "Failed") return { secondsRemaining: left(task.action_deadline), countdownTarget: "revision" };
  if (task.state === "Disputed") return { secondsRemaining: left(task.dispute_deadline), countdownTarget: "dispute" };
  return { secondsRemaining: null, countdownTarget: null };
}

export function taskView(db: Db, taskId: number, viewer: WorkerRow | null): (TaskView & { prompt?: string }) | null {
  const task = get<TaskRow>(db, "SELECT * FROM tasks WHERE task_id = ?", taskId);
  if (!task) return null;
  const batch = get<BatchRow>(db, "SELECT * FROM batches WHERE id = ?", task.batch_id);
  const now = Math.floor(Date.now() / 1000);
  const clock = countdown(task, now);
  const workerAccount = task.worker_id ? get<{ account_id: string | null }>(db, "SELECT account_id FROM workers WHERE id = ?", task.worker_id)?.account_id ?? null : null;
  const view: TaskView & { prompt?: string } = {
    taskId: String(task.task_id),
    batchId: task.batch_id,
    title: batch?.title ?? "",
    state: task.state,
    qaMode: (batch?.qa_mode ?? "manual") as QaMode,
    payBase: task.pay_base ?? batch?.pay_per_task ?? "0",
    payDecimal: baseToDecimal(BigInt(task.pay_base ?? batch?.pay_per_task ?? "0")),
    workerAccount,
    payout: task.payout,
    workDeadline: task.work_deadline,
    reviewDeadline: task.review_deadline,
    actionDeadline: task.action_deadline,
    disputeDeadline: task.dispute_deadline,
    serverNow: now,
    secondsRemaining: clock.secondsRemaining,
    countdownTarget: clock.countdownTarget,
    workHash: task.work_hash,
    scheduleId: task.schedule_id ?? task.schedule_address,
    failCount: task.fail_count,
    hashscan: links({
      schedule: scheduleLink(task.schedule_id, task.schedule_address),
      account: workerAccount ? hashscanAccount(workerAccount, config.hedera.network) : undefined,
    }),
  };
  if (viewer && viewer.id === task.worker_id) {
    const item = get<{ prompt: string }>(db, "SELECT prompt FROM batch_items WHERE task_id = ?", taskId);
    if (item) view.prompt = item.prompt;
  }
  return view;
}

export function queue(db: Db): Array<TaskView & { reasonText: string | null; approvals: number; approvalsRequired: number }> {
  const rows = all<TaskRow>(db, "SELECT * FROM tasks WHERE state IN ('AwaitingApproval', 'Disputed') ORDER BY updated_at ASC");
  return rows.map((t) => {
    const view = taskView(db, t.task_id, null)!;
    const approvals = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM task_events WHERE name = 'ApprovalRecorded' AND task_id = ?", t.task_id)?.n ?? 0;
    const dual = config.escrow.dualReviewBase > 0n && BigInt(view.payBase) > config.escrow.dualReviewBase;
    return { ...view, reasonText: t.reason_text, approvals, approvalsRequired: dual ? 2 : 1 };
  });
}

export function httpError(e: unknown): { status: number; body: { error: string; reason?: string; txId?: string; missing?: string[]; hashscan?: string } } {
  if (e instanceof NotConfigured) return { status: 503, body: { error: e.message, missing: e.missing } };
  if (e instanceof EscrowCallError) return { status: 400, body: { error: e.errorMessage, txId: e.txId, hashscan: hashscanTx(e.txId, config.hedera.network) } };
  const err = e as { status?: number; message?: string; reason?: string };
  return { status: err.status ?? 400, body: { error: err.message ?? "request failed", reason: err.reason } };
}
