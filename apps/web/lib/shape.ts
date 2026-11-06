import { formatMicro, parseMicro, tidyDecimal } from "@/lib/format";
import type { ChainRefs } from "@/lib/links";

/**
 * Request bodies this app posts. The API can read these names directly.
 *
 * POST /api/lab/batches
 *   { title, pay, count, qaMode, reviewWindow, workWindow, revisionWindow, rubric, goldQuestion, goldAnswer, prompt }
 *   Windows are seconds. pay is a dollar string ("40", "250.00").
 *
 * POST /api/work/payout    { approvalId, accountId }
 * POST /api/work/claim     { batchId, approvalId? }   approvalId set for claim_high
 * POST /api/work/submit    { taskId, body }
 * POST /api/review/:id/approve
 * POST /api/review/:id/hold     { reason }
 * POST /api/review/:id/resolve  { workerBps }   integer 0..10000
 * POST /api/compliance/freeze   { accountId }
 * POST /api/redeem              { amount }
 */

export type CreateBatchBody = {
  title: string;
  pay: string;
  count: number;
  qaMode: "auto" | "manual";
  reviewWindow: number;
  workWindow: number;
  revisionWindow: number;
  rubric: string;
  goldQuestion: string;
  goldAnswer: string;
  prompt: string;
};

export type Batch = {
  id: string;
  title: string;
  pay: string;
  count: number | null;
  claimed: number | null;
  unclaimed: number | null;
  qaMode: string;
  status: string;
  locked: string | null;
  refs: ChainRefs;
};

export type FeedItem = {
  batchId: string;
  title: string;
  prompt: string;
  pay: string;
  qaMode: string;
  unclaimed: number | null;
  count: number | null;
  refs: ChainRefs;
};

export type LogLine = {
  title: string;
  detail: string | null;
  at: number | null;
  amount: string | null;
  refs: ChainRefs;
};

export type WorkTask = {
  taskId: string;
  batchId: string;
  title: string;
  prompt: string;
  pay: string;
  state: string;
  reviewDeadline: number | null;
  workDeadline: number | null;
  timeline: LogLine[];
  refs: ChainRefs;
};

export type Me = {
  signedIn: boolean;
  accountId: string | null;
  verified: boolean;
  banned: boolean;
  busd: string | null;
  inr: string | null;
  fx: string | null;
  refs: ChainRefs;
};

export type ReviewItem = {
  taskId: string;
  batchId: string;
  title: string;
  pay: string;
  state: string;
  worker: string | null;
  prompt: string;
  reason: string | null;
  reviewDeadline: number | null;
  refs: ChainRefs;
};

export type Fig = { label: string; amount: string; unit: string; refs: ChainRefs };

export type TransparencyView = {
  reserve: Fig | null;
  nav: Fig | null;
  supply: Fig | null;
  valueLocked: Fig | null;
  log: LogLine[];
  leaderboard: { accountId: string; name: string | null; score: string; paid: string | null; refs: ChainRefs }[];
};

export const LOGGED_OUT: Me = {
  signedIn: false,
  accountId: null,
  verified: false,
  banned: false,
  busd: null,
  inr: null,
  fx: null,
  refs: {},
};

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function listAt(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const o = rec(v);
  if (!o) return [];
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function pickNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function entityId(v: string | null): string | null {
  if (!v) return null;
  if (/^0\.0\.\d+$/.test(v)) return v;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return v;
  return null;
}

function txId(v: string | null): string | null {
  if (!v) return null;
  if (v.startsWith("https://hashscan.io/")) return v;
  if (/^0\.0\.\d+@\d+\.\d+$/.test(v)) return v;
  if (/^0\.0\.\d+-\d+-\d+$/.test(v)) return v;
  return null;
}

/** Integers with 7+ digits are 6-decimal atomic bUSD. Shorter integers and any decimal are dollars. */
export function asMoney(v: unknown): string | null {
  if (typeof v === "bigint") return tidyDecimal(formatMicro(v));
  if (typeof v === "number" && Number.isFinite(v)) {
    if (Number.isInteger(v) && Math.abs(v) >= 1_000_000) return tidyDecimal(formatMicro(BigInt(v)));
    return tidyDecimal(String(v));
  }
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!s) return null;
  if (/^\d+$/.test(s) && s.length >= 7) {
    try {
      return tidyDecimal(formatMicro(BigInt(s)));
    } catch {
      return s;
    }
  }
  return s;
}

export function asTimeMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e12) return v;
    if (v > 1e9) return Math.round(v * 1000);
    return null;
  }
  if (typeof v === "string" && v.trim()) {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return asTimeMs(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function chainRefs(v: unknown, inherited?: ChainRefs): ChainRefs {
  const o = rec(v);
  const base: ChainRefs = { ...(inherited ?? {}) };
  if (!o) return base;
  const tx = txId(pickStr(o, ["txId", "tx", "transactionId", "fundTx", "payoutTx", "burnTx", "transaction"]));
  const schedule = entityId(pickStr(o, ["scheduleId", "schedule"]));
  const topic = entityId(pickStr(o, ["topicId", "hcsTopic", "topic", "topic_id"]));
  const sequence = pickNum(o, ["sequence", "hcsSequence", "seq", "sequence_number", "sequenceNumber"]);
  const token = entityId(pickStr(o, ["tokenId", "token"]));
  const contract = entityId(pickStr(o, ["contractId", "contract", "escrowId", "escrow"]));
  const workerRec = rec(o.worker);
  const account =
    entityId(pickStr(o, ["accountId", "account", "payTo", "client"])) ??
    (typeof o.worker === "string" ? entityId(o.worker) : null) ??
    (workerRec ? entityId(pickStr(workerRec, ["accountId", "account", "payTo"])) : null);
  return {
    txId: tx ?? base.txId ?? null,
    scheduleId: schedule ?? base.scheduleId ?? null,
    topicId: topic ?? base.topicId ?? null,
    sequence: sequence != null && sequence > 0 ? Math.floor(sequence) : (base.sequence ?? null),
    tokenId: token ?? base.tokenId ?? null,
    contractId: contract ?? base.contractId ?? null,
    accountId: account ?? base.accountId ?? null,
  };
}

function normalizeLog(v: unknown, inherited?: ChainRefs): LogLine | null {
  const o = rec(v);
  if (!o) return null;
  const inner = rec(o.message) ?? rec(o.payload) ?? rec(o.body);
  const flat: Record<string, unknown> = { ...(inner ?? {}), ...o };
  if (inner) {
    delete flat.message;
    delete flat.payload;
    delete flat.body;
  }
  const title = pickStr(flat, ["event", "type", "kind", "name", "status"]) ?? "event";
  const amount = asMoney(flat.amount ?? flat.pay ?? flat.value ?? flat.locked);
  const detail = typeof o.message === "string" ? o.message : pickStr(flat, ["detail", "note", "path", "memo", "reason"]);
  return {
    title,
    detail,
    at: asTimeMs(flat.ts ?? flat.at ?? flat.time ?? flat.consensusTimestamp ?? flat.consensus_timestamp ?? flat.createdAt ?? flat.timestamp),
    amount,
    refs: chainRefs(flat, inherited),
  };
}

export function normalizeBatch(v: unknown, inherited?: ChainRefs): Batch | null {
  const o = rec(v);
  if (!o) return null;
  const id = pickStr(o, ["id", "batchId"]) ?? "";
  const title = pickStr(o, ["title", "name"]) ?? "";
  if (!id && !title) return null;
  const count = pickNum(o, ["count", "taskCount"]);
  const claimed = pickNum(o, ["claimed", "claimedCount"]);
  const unclaimed = pickNum(o, ["unclaimed", "remaining", "open"]);
  return {
    id: id || title,
    title: title || "Batch",
    pay: asMoney(o.pay ?? o.payUsd ?? o.payPerTask) ?? "",
    count,
    claimed,
    unclaimed: unclaimed ?? (count != null && claimed != null ? Math.max(0, count - claimed) : null),
    qaMode: (pickStr(o, ["qaMode", "qa"]) ?? "").toLowerCase(),
    status: pickStr(o, ["status", "state"]) ?? "funded",
    locked: asMoney(o.locked ?? o.lockedUsd ?? o.totalLocked ?? o.totalUsd ?? o.total),
    refs: chainRefs(o, inherited),
  };
}

export function normalizeBatches(body: unknown): Batch[] {
  const rows = listAt(body, ["batches", "items", "rows"]);
  return rows.map((row) => normalizeBatch(row)).filter((b): b is Batch => b != null);
}

export function fundedAmount(body: unknown, fallback: { pay: string; count: number }): { amount: string; refs: ChainRefs; batch: Batch | null } {
  const o = rec(body) ?? {};
  const nested = rec(o.batch) ?? o;
  let amount =
    asMoney(nested.locked ?? nested.lockedUsd ?? nested.totalLocked ?? nested.totalUsd ?? o.locked ?? o.lockedUsd ?? o.totalLocked ?? o.total) ??
    null;
  if (!amount) {
    const message = pickStr(o, ["message", "funded", "label", "notice"]);
    const m = message ? /\$([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(message) : null;
    if (m) amount = m[1].replace(/,/g, "");
  }
  if (!amount) {
    const micro = parseMicro(fallback.pay);
    amount = micro != null ? tidyDecimal(formatMicro(micro * BigInt(fallback.count))) : fallback.pay;
  }
  return { amount: tidyDecimal(amount), refs: chainRefs(nested), batch: normalizeBatch(nested) };
}

function normalizeFeed(v: unknown, inherited?: ChainRefs): FeedItem | null {
  const o = rec(v);
  if (!o) return null;
  const batchId = pickStr(o, ["batchId", "id"]) ?? "";
  if (!batchId) return null;
  const countRaw = o.count ?? o.taskCount;
  const count = typeof countRaw === "number" ? countRaw : typeof countRaw === "string" && /^\d+$/.test(countRaw) ? Number(countRaw) : null;
  return {
    batchId,
    title: pickStr(o, ["title", "name"]) ?? "Batch",
    prompt: pickStr(o, ["prompt", "instructions"]) ?? "",
    pay: asMoney(o.pay ?? o.payUsd ?? o.payPerTask ?? o.amount) ?? "0",
    qaMode: (pickStr(o, ["qaMode", "qa"]) ?? "auto").toLowerCase(),
    unclaimed: pickNum(o, ["unclaimed", "remaining", "open"]),
    count,
    refs: chainRefs(o, inherited),
  };
}

function normalizeTask(v: unknown, inherited?: ChainRefs): WorkTask | null {
  const o = rec(v);
  if (!o) return null;
  const taskId = pickStr(o, ["taskId", "id"]);
  if (!taskId) return null;
  const refs = chainRefs(o, inherited);
  const timeline = listAt(o.timeline ?? o.events ?? o.log ?? o.history, ["items", "events"]).map((row) => normalizeLog(row, refs)).filter((x): x is LogLine => x != null);
  return {
    taskId,
    batchId: pickStr(o, ["batchId", "batch"]) ?? "",
    title: pickStr(o, ["title", "name"]) ?? `Task ${taskId}`,
    prompt: pickStr(o, ["prompt", "instructions"]) ?? "",
    pay: asMoney(o.pay ?? o.payUsd ?? o.amount) ?? "",
    state: pickStr(o, ["state", "status"]) ?? "open",
    reviewDeadline: asTimeMs(o.reviewDeadline ?? o.review_deadline ?? o.deadline),
    workDeadline: asTimeMs(o.workDeadline ?? o.work_deadline),
    timeline,
    refs,
  };
}

export function normalizeWork(body: unknown): { feed: FeedItem[]; tasks: WorkTask[] } {
  const o = rec(body) ?? {};
  const root = chainRefs(o);
  const feedSrc = listAt(o.feed ?? o.open ?? o.available ?? o.batches, ["batches", "items", "tasks"]);
  const taskSrc = listAt(o.tasks ?? o.mine ?? o.myTasks ?? o.claimed, ["items", "tasks"]);
  return {
    feed: feedSrc
      .map((row) => normalizeFeed(row, root))
      .filter((x): x is FeedItem => x != null && x.unclaimed !== 0),
    tasks: taskSrc.map((row) => normalizeTask(row, root)).filter((x): x is WorkTask => x != null),
  };
}

export function normalizeMe(body: unknown): Me {
  const o = rec(body);
  if (!o) return LOGGED_OUT;
  const worker = rec(o.worker) ?? rec(o.user) ?? rec(o.me);
  const wallet = rec(o.wallet) ?? rec(o.balance) ?? rec(o.balances) ?? o;
  if (!worker && o.worker === null) return LOGGED_OUT;
  const accountId = entityId(worker ? pickStr(worker, ["accountId", "payTo", "account"]) : null) ?? entityId(pickStr(wallet, ["accountId", "account", "payTo"]));
  const signedIn = worker != null || o.signedIn === true || o.authenticated === true;
  if (!signedIn && !accountId) return LOGGED_OUT;
  const fxPair = pickStr(wallet, ["fxPair", "pair"]) ?? pickStr(o, ["fxPair", "pair"]);
  const fxSource = pickStr(wallet, ["fxSource", "source"]) ?? pickStr(o, ["fxSource", "source"]);
  const fxRate = asMoney(wallet.fxRate ?? wallet.rate ?? o.fxRate);
  const fx = [fxPair, fxRate ? `rate ${fxRate}` : null, fxSource].filter(Boolean).join(" · ") || null;
  return {
    signedIn: true,
    accountId,
    verified: Boolean(worker?.verifiedHuman ?? worker?.verified ?? o.verifiedHuman ?? true),
    banned: Boolean(worker?.banned ?? o.banned),
    busd: asMoney(wallet.busd ?? wallet.balanceBusd ?? wallet.busdBalance ?? wallet.balance ?? o.busd),
    inr: asMoney(wallet.inr ?? wallet.rupees ?? wallet.inrValue ?? o.inr ?? o.rupees),
    fx,
    refs: chainRefs(wallet, chainRefs(worker ?? {}, chainRefs(o))),
  };
}

function normalizeReviewItem(v: unknown, inherited?: ChainRefs): ReviewItem | null {
  const o = rec(v);
  if (!o) return null;
  const task = rec(o.task) ?? o;
  const taskId = pickStr(task, ["taskId", "id"]) ?? pickStr(o, ["taskId", "id"]);
  if (!taskId) return null;
  return {
    taskId,
    batchId: pickStr(task, ["batchId", "batch"]) ?? pickStr(o, ["batchId"]) ?? "",
    title: pickStr(task, ["title", "name"]) ?? pickStr(o, ["title"]) ?? `Task ${taskId}`,
    pay: asMoney(task.pay ?? task.payUsd ?? o.pay ?? o.payUsd) ?? "",
    state: pickStr(task, ["state", "status"]) ?? pickStr(o, ["state", "status"]) ?? "AwaitingApproval",
    worker: entityId(pickStr(task, ["worker", "accountId", "payTo"])) ?? entityId(pickStr(o, ["worker", "accountId"])),
    prompt: pickStr(task, ["prompt", "instructions"]) ?? "",
    reason: pickStr(o, ["reason", "holdReason"]) ?? pickStr(task, ["reason"]),
    reviewDeadline: asTimeMs(task.reviewDeadline ?? task.deadline ?? o.reviewDeadline ?? o.deadline),
    refs: chainRefs(task, chainRefs(o, inherited)),
  };
}

export function normalizeQueue(body: unknown): { reviewer: string | null; items: ReviewItem[] } {
  const o = rec(body);
  const rows = listAt(body, ["queue", "items", "tasks", "reviews"]);
  const reviewerRec = o ? rec(o.reviewer) : null;
  const reviewer = reviewerRec ? pickStr(reviewerRec, ["accountId", "account", "label", "id"]) : o ? pickStr(o, ["reviewerAccount", "reviewerId"]) : null;
  const inherited = chainRefs(o ?? {});
  return {
    reviewer,
    items: rows.map((row) => normalizeReviewItem(row, inherited)).filter((x): x is ReviewItem => x != null),
  };
}

function fig(o: Record<string, unknown>, label: string, unit: string, valueKeys: string[], txKeys: string[], inherited: ChainRefs): Fig | null {
  const direct = o[valueKeys[0] ?? ""];
  const nested = rec(direct);
  const amount = nested
    ? asMoney(nested.amount ?? nested.value ?? nested.usd ?? nested.busd ?? nested.nav ?? nested.ratio ?? nested.total ?? nested.locked)
    : asMoney(valueKeys.map((k) => o[k]).find((v) => v != null && v !== ""));
  if (amount == null) return null;
  const refs = chainRefs(nested ?? {}, inherited);
  if (!nested) {
    const tx = txId(pickStr(o, txKeys));
    if (tx) refs.txId = tx;
  }
  return { label, amount, unit, refs };
}

export function normalizeTransparency(body: unknown): TransparencyView {
  const o = rec(body) ?? {};
  const root = chainRefs(o);
  const logSrc = listAt(o.log ?? o.hcs ?? o.messages ?? o.events, ["items", "messages", "log"]);
  const boardSrc = listAt(o.leaderboard ?? o.scores ?? o.contributors, ["rows", "items"]);
  return {
    reserve: fig(o, "Reserve", "bUSD", ["reserve", "reserveUsd", "reserveAmount"], ["reserveTx", "reserveTxId"], root),
    nav: fig(o, "NAV", "", ["nav", "navValue"], ["navTx", "navTxId"], root),
    supply: fig(o, "Supply", "bUSD", ["supply", "totalSupply"], ["supplyTx"], root),
    valueLocked: fig(o, "Value locked", "bUSD", ["valueLocked", "locked", "escrowLocked"], ["lockedTx", "valueLockedTx"], root),
    log: logSrc.map((row) => normalizeLog(row, root)).filter((x): x is LogLine => x != null),
    leaderboard: boardSrc
      .map((row) => {
        const r = rec(row);
        if (!r) return null;
        const refs = chainRefs(r, root);
        const accountId = entityId(pickStr(r, ["accountId", "account", "payTo"])) ?? (typeof r.worker === "string" ? entityId(r.worker) : null) ?? refs.accountId ?? "";
        const score = pickStr(r, ["score", "points"]) ?? "0";
        if (!accountId && score === "0") return null;
        return {
          accountId,
          name: pickStr(r, ["name", "label"]),
          score,
          paid: asMoney(r.paid ?? r.paidUsd ?? r.earned ?? r.amount),
          refs,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null),
  };
}
