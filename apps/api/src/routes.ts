/**
 * HTTP surface. Missing keys answer 503. World `sub` is never serialised.
 */
import { randomUUID } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  baseToDecimal,
  busdFromBase,
  decimalToBase,
  hashscanTopic,
  hashscanTopicMessage,
  hashscanTx,
  scoresFromEvents,
  type BatchCreateRequest,
  type ConfigResponse,
  type QaMode,
  type RedeemRequest,
  type WorkSubmission,
} from "@byline-work/shared";
import { banWorker } from "./caps";
import { config, labAllowlist, ready, reviewerAllowlist } from "./config";
import { evmAddressFromKey, tokenBalance } from "./chain";
import { all, chainEvm, get, run, type BatchRow, type Db, type TaskRow, type WorkerRow } from "./db";
import { approveTask, holdTask, resolveTask, setWorkerStatus } from "./escrow";
import { submitHcs } from "./hcs";
import { readTopic } from "./hcs";
import { fetchPublicFx, isFxPair } from "./oracle/fx";
import { clientStats, navView, reserveView, signFeedBody, statsView } from "./oracle/x402";
import { MockOffRamp } from "./offramp/mock";
import { taskMessage } from "@byline-work/shared";
import { bindPayout, claim, createBatch, dispute, feed, httpError, links, queue, submit, taskView } from "./work";
import { buildAuthUrl, DENIAL_TEXT, handleCallback, type StepUpAction } from "./world";

const COOKIE = "bw_session";
const nowSec = () => Math.floor(Date.now() / 1000);

function session(c: Context, db: Db): string {
  let sid = getCookie(c, COOKIE);
  if (!sid) {
    sid = randomUUID();
    setCookie(c, COOKIE, sid, { httpOnly: true, sameSite: "Lax", path: "/", secure: config.sessionSecure, maxAge: 60 * 60 * 24 * 30 });
  }
  if (!get(db, "SELECT id FROM sessions WHERE id = ?", sid)) {
    run(db, "INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)", sid, Date.now(), Date.now() + 30 * 86_400_000);
  }
  return sid;
}

function worker(db: Db, sid: string): WorkerRow | undefined {
  const row = get<{ worker_id: string | null }>(db, "SELECT worker_id FROM sessions WHERE id = ?", sid);
  return row?.worker_id ? get<WorkerRow>(db, "SELECT * FROM workers WHERE id = ?", row.worker_id) : undefined;
}

function publicWorker(w: WorkerRow) {
  return {
    workerId: w.id,
    kind: w.kind,
    label: w.label,
    worldId: w.kind === "world",
    accountId: w.account_id,
    evmAddress: w.evm_address,
    banned: !!w.banned_at,
    displayName: w.display_name,
  };
}

function fail(c: Context, e: unknown) {
  const http = httpError(e);
  return c.json(http.body, http.status as 400);
}

function allow(header: string | undefined, list: string[]): boolean {
  return !!header && list.includes(header);
}

/** Dollar strings the web reads. A 7-digit integer would be treated as base units, so keep a decimal. */
function uiDollars(base: bigint): string {
  const s = baseToDecimal(base);
  return /^\d{7,}$/.test(s) ? `${s}.0` : s;
}

function plainDollars(decimal: string): string {
  return /^\d{7,}$/.test(decimal) ? `${decimal}.0` : decimal;
}

/** A browser navigation should follow World. `api()` sends Accept: application/json and still gets `{ url }`. */
function wantsPage(c: Context): boolean {
  return (c.req.header("accept") ?? "").includes("text/html");
}

/**
 * The lab and review pages are the demo desks. They do not send `x-byline-account`;
 * the server holds those keys. A header that is present must still be on the allowlist.
 */
function deskAccount(c: Context, list: string[], missing: string[], emptyError: string, rejectError: string): { accountId: string } | { error: Response } {
  if (!list.length) return { error: c.json({ error: emptyError, missing }, 503) };
  const header = c.req.header("x-byline-account");
  if (header && !allow(header, list)) return { error: c.json({ error: rejectError }, 403) };
  return { accountId: header && allow(header, list) ? header : list[0]! };
}

type WebBatch = {
  title?: string;
  pay?: string;
  count?: number;
  qaMode?: string;
  reviewWindow?: number;
  workWindow?: number;
  revisionWindow?: number;
  rubric?: string | string[];
  goldQuestion?: string;
  goldAnswer?: string;
  prompt?: string;
  payPerTask?: string;
  taskCount?: number;
  tasks?: BatchCreateRequest["tasks"];
  labAccountId?: string;
};

/** Web batch: one prompt, dollar `pay`, `count` tasks, windows in seconds. Native shape still works. */
function toBatchRequest(raw: unknown, labAccountId: string): BatchCreateRequest {
  const body = (raw ?? {}) as WebBatch;
  const qaMode: QaMode | null = body.qaMode === "manual" ? "manual" : body.qaMode === "auto" ? "auto" : null;
  if (typeof body.payPerTask === "string" && Array.isArray(body.tasks)) {
    if (!qaMode) throw Object.assign(new Error("qaMode must be auto or manual"), { status: 400 });
    const rubric = Array.isArray(body.rubric) ? body.rubric : String(body.rubric ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return {
      title: String(body.title ?? ""),
      qaMode,
      payPerTask: body.payPerTask,
      taskCount: Number(body.taskCount ?? body.tasks.length),
      reviewWindow: Number(body.reviewWindow),
      workWindow: Number(body.workWindow),
      revisionWindow: Number(body.revisionWindow),
      rubric,
      tasks: body.tasks,
      labAccountId: body.labAccountId || labAccountId,
    };
  }
  const title = String(body.title ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  const rubricText = typeof body.rubric === "string" ? body.rubric.trim() : "";
  const pay = String(body.pay ?? "").trim();
  const count = Number(body.count);
  if (!title || !prompt || !rubricText) throw Object.assign(new Error("Title, prompt, and rubric are required."), { status: 400 });
  if (!qaMode) throw Object.assign(new Error("qaMode must be auto or manual"), { status: 400 });
  if (!/^\d+(\.\d{1,6})?$/.test(pay)) throw Object.assign(new Error("Pay must be a dollar amount."), { status: 400 });
  const goldQuestion = String(body.goldQuestion ?? "").trim();
  const goldAnswer = String(body.goldAnswer ?? "").trim();
  if (qaMode === "auto" && (!goldQuestion || !goldAnswer)) {
    throw Object.assign(new Error("Auto QA needs a gold question and answer."), { status: 400 });
  }
  const rubric = rubricText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (goldQuestion) rubric.push(goldQuestion);
  const gold: Record<string, string> = goldAnswer ? { answer: goldAnswer } : {};
  return {
    title,
    qaMode,
    payPerTask: pay,
    taskCount: count,
    reviewWindow: Number(body.reviewWindow),
    workWindow: Number(body.workWindow),
    revisionWindow: Number(body.revisionWindow),
    rubric,
    tasks: Array.from({ length: Number.isInteger(count) && count > 0 ? count : 0 }, () => ({ prompt, gold, checklist: [] })),
    labAccountId,
  };
}

/** The work desk posts a free-text body. Auto QA compares it to the stored gold answer. */
function asSubmission(body: unknown): WorkSubmission {
  if (typeof body === "string" && body.trim()) return { answers: { answer: body.trim() }, checklist: {} };
  if (body && typeof body === "object") {
    const o = body as Partial<WorkSubmission>;
    if (o.answers && typeof o.answers === "object") return { answers: o.answers, checklist: o.checklist ?? {}, note: o.note };
  }
  throw Object.assign(new Error("body is required"), { status: 400 });
}

function presentFeed(db: Db) {
  return feed(db).map((item) => {
    const prompt = get<{ prompt: string }>(db, "SELECT prompt FROM batch_items WHERE batch_id = ? ORDER BY idx LIMIT 1", item.batchId)?.prompt ?? "";
    const funded = get<{ funded_tx: string | null }>(db, "SELECT funded_tx FROM batches WHERE id = ?", item.batchId);
    return {
      ...item,
      pay: plainDollars(item.payDecimal),
      prompt,
      txId: funded?.funded_tx ?? null,
      tokenId: config.token.id || null,
      contractId: config.escrow.contractId || null,
    };
  });
}

function presentTasks(db: Db, w: WorkerRow | null) {
  if (!w) return [];
  const ids = all<{ task_id: number }>(db, "SELECT task_id FROM tasks WHERE worker_id = ? ORDER BY updated_at DESC", w.id);
  return ids.flatMap((row) => {
    const view = taskView(db, row.task_id, w);
    if (!view) return [];
    const events = all<{ name: string; payload: string; created_at: number; hcs_sequence: number | null; hcs_topic: string | null }>(
      db,
      "SELECT name, payload, created_at, hcs_sequence, hcs_topic FROM task_events WHERE task_id = ? ORDER BY created_at ASC",
      row.task_id,
    );
    const timeline = events.map((e) => {
      let amount: string | undefined;
      try {
        const payload = JSON.parse(e.payload) as { pay?: string; workerAmount?: string };
        const raw = payload.workerAmount || payload.pay;
        if (raw && /^\d+$/.test(raw)) amount = uiDollars(BigInt(raw));
      } catch {
        amount = undefined;
      }
      return { event: e.name, at: e.created_at, amount, sequence: e.hcs_sequence, topicId: e.hcs_topic };
    });
    return [{ ...view, pay: plainDollars(view.payDecimal), timeline, tokenId: config.token.id || null, contractId: config.escrow.contractId || null }];
  });
}

function presentQueue(db: Db) {
  return queue(db).map((item) => {
    const prompt = get<{ prompt: string }>(db, "SELECT prompt FROM batch_items WHERE task_id = ? ORDER BY idx LIMIT 1", Number(item.taskId))?.prompt ?? "";
    return {
      ...item,
      pay: plainDollars(item.payDecimal),
      worker: item.workerAccount,
      reason: item.reasonText,
      prompt,
      tokenId: config.token.id || null,
      contractId: config.escrow.contractId || null,
    };
  });
}

export function publicScores(db: Db) {
  const mapped = all<{ name: string; payload: string; created_at: number }>(db, "SELECT name, payload, created_at FROM task_events").flatMap((r) => {
    const payload = JSON.parse(r.payload) as { worker?: string; payout?: string; pay?: string; workerAmount?: string; workerBps?: string; taskId?: string };
    const task = payload.taskId ? get<{ worker_evm: string | null }>(db, "SELECT worker_evm FROM tasks WHERE task_id = ?", Number(payload.taskId)) : undefined;
    const who = payload.worker || payload.payout || task?.worker_evm;
    if (!who) return [];
    const event = r.name === "TaskClaimed" ? "claimed" : r.name === "TaskSubmitted" ? "submitted" : r.name === "QaPassed" ? "qa_pass" : r.name === "TaskReleased" ? "released" : r.name === "TaskResolved" ? "resolved" : "";
    if (!event) return [];
    const amount = payload.pay || payload.workerAmount;
    return [{
      worker: who,
      event,
      valueBusd: amount && (event === "released" || event === "resolved") ? busdFromBase(BigInt(amount)) : undefined,
      ageDays: Math.max(0, (Date.now() - r.created_at) / 86_400_000),
      disputeLost: event === "resolved" && payload.workerBps === "0",
    }];
  });
  return scoresFromEvents(mapped);
}

export function mount(app: Hono, db: Db) {
  app.get("/api/health", (c) => c.json({ ok: true, service: "byline-work" }));

  app.get("/api/config", (c) => {
    const body: ConfigResponse = {
      network: config.hedera.network,
      escrow: config.escrow.contractId || null,
      token: config.token.id || null,
      topic: config.hedera.topicId || null,
      scheduling: config.escrow.scheduling,
      hitlBase: config.escrow.hitlBase.toString(),
      demoMockWorld: config.demoMockWorld,
      custody: "demo",
      ready: {
        chain: ready.chain(),
        hcs: ready.hcs(),
        world: ready.world(),
        feed: ready.feed(),
        zg: ready.zg(),
        x402: ready.x402(),
      },
    };
    return c.json(body);
  });

  app.get("/api/denials", (c) => c.json(DENIAL_TEXT));

  app.get("/api/me", async (c) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ workerId: null, signedIn: false });
    let busd: string | null = null;
    let inr: string | null = null;
    let fxRate: string | null = null;
    let fxSource: string | null = null;
    if (w.account_id && config.token.id) {
      try {
        busd = uiDollars(await tokenBalance(w.account_id, config.token.id));
        const fx = await fetchPublicFx("USD-INR");
        fxRate = String(fx.rate);
        fxSource = fx.source;
        const usd = Number(busd);
        if (Number.isFinite(usd)) inr = (usd * fx.rate).toFixed(2);
      } catch {
        /* balance stays pending when the mirror or FX source is down */
      }
    }
    return c.json({
      ...publicWorker(w),
      signedIn: true,
      verified: w.kind === "world",
      banned: !!w.banned_at,
      busd,
      inr,
      fxPair: fxRate ? "USD-INR" : null,
      fxRate,
      fxSource,
      verifiedHuman: w.kind === "world",
      tokenId: config.token.id || null,
    });
  });

  app.post("/api/demo/worker", async (c) => {
    if (!config.demoMockWorld) return c.json({ error: "DEMO_MOCK_WORLD is off. This route does not create a World ID." }, 404);
    const body = await c.req.json().catch(() => ({} as { displayName?: string; accountId?: string }));
    const id = randomUUID();
    run(
      db,
      "INSERT INTO workers (id, kind, label, display_name, account_id, created_at) VALUES (?, 'demo', 'demo human', ?, ?, ?)",
      id, body.displayName ?? "Demo human", body.accountId ?? null, Date.now(),
    );
    run(db, "UPDATE sessions SET worker_id = ? WHERE id = ?", id, session(c, db));
    const w = get<WorkerRow>(db, "SELECT * FROM workers WHERE id = ?", id)!;
    return c.json({ ...publicWorker(w), note: "demo human. This is not a World ID." });
  });

  app.get("/api/world/login", async (c) => {
    if (!ready.world()) return c.json({ error: "World ID is not configured", missing: ["WORLD_CLIENT_ID", "WORLD_CLIENT_SECRET"] }, 503);
    try {
      const url = await buildAuthUrl(db, session(c, db), "login");
      if (wantsPage(c)) return c.redirect(url);
      return c.json({ url });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/world/stepup", async (c) => {
    if (!ready.world()) return c.json({ error: "World ID is not configured", missing: ["WORLD_CLIENT_ID", "WORLD_CLIENT_SECRET"] }, 503);
    const action = c.req.query("action");
    const target = c.req.query("target") ?? "";
    if (action !== "claim_high" && action !== "payout_wallet") return c.json({ error: "action must be claim_high or payout_wallet" }, 400);
    if (!target) return c.json({ error: "target is required" }, 400);
    try {
      const url = await buildAuthUrl(db, session(c, db), "stepup", action as StepUpAction, target);
      if (wantsPage(c)) return c.redirect(url);
      return c.json({ url });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/world/callback", async (c) => {
    const result = await handleCallback(db, getCookie(c, COOKIE) ?? null, new URL(c.req.url).search);
    const dest = new URL("/work", config.webOrigin);
    if (result.ok && result.purpose === "login") {
      dest.searchParams.set("login", "1");
      dest.searchParams.set("world", "login");
    } else if (result.ok && result.purpose === "stepup") {
      dest.searchParams.set("approval", result.approvalId);
      dest.searchParams.set("action", result.action);
      dest.searchParams.set("target", result.target);
      dest.searchParams.set("world", "stepup");
    } else if (!result.ok) {
      dest.searchParams.set("denied", result.reason);
      dest.searchParams.set("detail", DENIAL_TEXT[result.reason] ?? result.detail);
      if (result.action) dest.searchParams.set("action", result.action);
      if (result.target) dest.searchParams.set("target", result.target);
      dest.searchParams.set("world", "denied");
      dest.searchParams.set("reason", result.reason);
    }
    return c.redirect(dest.href);
  });

  app.post("/api/world/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const postPayout = async (c: Context) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ error: "Sign in first." }, 401);
    const body = await c.req.json().catch(() => ({} as { accountId?: string; approvalId?: string }));
    if (!body.accountId) return c.json({ error: "accountId is required" }, 400);
    try {
      return c.json(await bindPayout(db, w, body.accountId, body.approvalId ?? null));
    } catch (e) {
      return fail(c, e);
    }
  };
  app.post("/api/workers/payout", postPayout);
  app.post("/api/work/payout", postPayout);

  app.post("/api/lab/batches", async (c) => {
    const desk = deskAccount(c, labAllowlist(), ["LAB_ACCOUNT_ID or LAB_ALLOWLIST"], "Lab allowlist is not configured", "This account is not on the lab allowlist.");
    if ("error" in desk) return desk.error;
    try {
      const input = toBatchRequest(await c.req.json(), desk.accountId);
      const created = await createBatch(db, input);
      return c.json({
        ...created,
        id: created.batchId,
        title: input.title,
        pay: input.payPerTask,
        count: input.taskCount,
        qaMode: input.qaMode,
        status: "funded",
        locked: plainDollars(created.totalDecimal),
        total: plainDollars(created.totalDecimal),
      }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/lab/batches", (c) => {
    const rows = all<BatchRow>(db, "SELECT * FROM batches ORDER BY created_at DESC");
    return c.json({
      batches: rows.map((b) => {
        const pay = BigInt(b.pay_per_task);
        return {
          id: b.id,
          batchId: b.id,
          title: b.title,
          pay: uiDollars(pay),
          count: b.task_count,
          claimed: Math.max(0, b.task_count - b.unclaimed),
          unclaimed: b.unclaimed,
          qaMode: b.qa_mode,
          status: b.funded_tx ? "funded" : "pending",
          locked: uiDollars(pay * BigInt(b.task_count)),
          txId: b.funded_tx,
          tokenId: config.token.id || null,
          contractId: config.escrow.contractId || null,
          custody: "demo",
          custodyNote: "Server-held lab key (demo custody).",
        };
      }),
    });
  });

  app.post("/api/batches", async (c) => {
    const account = c.req.header("x-byline-account") ?? "";
    if (!labAllowlist().length) return c.json({ error: "Lab allowlist is not configured", missing: ["LAB_ACCOUNT_ID or LAB_ALLOWLIST"] }, 503);
    if (!allow(account, labAllowlist())) return c.json({ error: "This account is not on the lab allowlist." }, 403);
    try {
      const body = await c.req.json();
      return c.json(await createBatch(db, { ...body, labAccountId: account }), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/batches", (c) => c.json(feed(db)));

  app.get("/api/batches/:id", (c) => {
    const row = get<{ id: string; title: string; qa_mode: string; pay_per_task: string; task_count: number; unclaimed: number; funded_tx: string | null }>(
      db, "SELECT id, title, qa_mode, pay_per_task, task_count, unclaimed, funded_tx FROM batches WHERE id = ?", c.req.param("id"),
    );
    if (!row) return c.json({ error: "unknown batch" }, 404);
    return c.json({
      ...row,
      payDecimal: baseToDecimal(BigInt(row.pay_per_task)),
      custody: "demo",
      custodyNote: "Server-held lab key (demo custody).",
      hashscan: links(row.funded_tx ? { tx: hashscanTx(row.funded_tx, config.hedera.network) } : {}),
    });
  });

  app.get("/api/tasks", (c) => c.json(feed(db)));

  const postClaim = async (c: Context) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ error: "Sign in first." }, 401);
    const body = await c.req.json().catch(() => ({} as { batchId?: string; approvalId?: string }));
    if (!body.batchId) return c.json({ error: "batchId is required" }, 400);
    try {
      return c.json(await claim(db, w, body.batchId, body.approvalId));
    } catch (e) {
      return fail(c, e);
    }
  };
  app.post("/api/tasks/claim", postClaim);
  app.post("/api/work/claim", postClaim);

  app.get("/api/work/state", (c) => {
    const w = worker(db, session(c, db)) ?? null;
    return c.json({ feed: presentFeed(db), tasks: presentTasks(db, w) });
  });

  app.post("/api/work/submit", async (c) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ error: "Sign in first." }, 401);
    const body = await c.req.json().catch(() => ({} as { taskId?: string | number; body?: unknown }));
    const taskId = Number(body.taskId);
    if (!Number.isInteger(taskId)) return c.json({ error: "taskId is required" }, 400);
    const row = get<TaskRow>(db, "SELECT state FROM tasks WHERE task_id = ?", taskId);
    const resubmit = row?.state === "Revising" || row?.state === "Failed";
    try {
      return c.json(await submit(db, w, taskId, asSubmission(body.body), resubmit));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/tasks/:id", (c) => {
    const view = taskView(db, Number(c.req.param("id")), worker(db, session(c, db)) ?? null);
    if (!view) return c.json({ error: "unknown task" }, 404);
    return c.json(view);
  });

  app.get("/api/tasks/:id/stream", (c) => {
    const id = Number(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      let last = "";
      for (let i = 0; i < 180; i++) {
        const view = taskView(db, id, worker(db, session(c, db)) ?? null);
        const data = JSON.stringify(view ?? { error: "unknown task" });
        if (data !== last) {
          await stream.writeSSE({ data, event: "task" });
          last = data;
        }
        await stream.sleep(1000);
      }
    });
  });

  app.post("/api/tasks/:id/submit", async (c) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ error: "Sign in first." }, 401);
    const body = (await c.req.json()) as WorkSubmission;
    try {
      return c.json(await submit(db, w, Number(c.req.param("id")), body, false));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/tasks/:id/resubmit", async (c) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ error: "Sign in first." }, 401);
    const body = (await c.req.json()) as WorkSubmission;
    try {
      return c.json(await submit(db, w, Number(c.req.param("id")), body, true));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/tasks/:id/dispute", async (c) => {
    const w = worker(db, session(c, db));
    if (!w) return c.json({ error: "Sign in first." }, 401);
    const body = await c.req.json().catch(() => ({} as { reason?: string }));
    if (!body.reason) return c.json({ error: "reason is required" }, 400);
    try {
      return c.json(await dispute(db, w, Number(c.req.param("id")), body.reason));
    } catch (e) {
      return fail(c, e);
    }
  });

  const reviewDesk = (c: Context) => deskAccount(c, reviewerAllowlist(), ["REVIEWER_ACCOUNT_ID or REVIEWER_ALLOWLIST"], "Reviewer allowlist is not configured", "Reviewer allowlist rejected this account.");

  app.get("/api/review/queue", (c) => {
    const desk = reviewDesk(c);
    if ("error" in desk) return desk.error;
    return c.json({ reviewer: { accountId: desk.accountId }, queue: presentQueue(db) });
  });

  app.post("/api/review/:id/approve", async (c) => {
    const desk = reviewDesk(c);
    if ("error" in desk) return desk.error;
    try {
      // ESC-22: the desk account picks the reviewer key, so the second approval above the dual-review
      // threshold must come from a different reviewer account (x-byline-account).
      const as = config.roles.reviewer2.accountId && desk.accountId === config.roles.reviewer2.accountId ? "reviewer2" : "reviewer";
      const sent = await approveTask(BigInt(c.req.param("id")), as);
      return c.json({ txId: sent.txId, reviewer: desk.accountId, hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network) }) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/review/:id/hold", async (c) => {
    const desk = reviewDesk(c);
    if ("error" in desk) return desk.error;
    const body = await c.req.json().catch(() => ({} as { reason?: string }));
    if (!body.reason) return c.json({ error: "reason text is required" }, 400);
    const reasonHash = keccak256(stringToBytes(body.reason));
    run(db, "UPDATE tasks SET reason_text = ? WHERE task_id = ?", body.reason, Number(c.req.param("id")));
    try {
      const sent = await holdTask(BigInt(c.req.param("id")), reasonHash);
      return c.json({ txId: sent.txId, reasonHash, hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network) }) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/review/:id/resolve", async (c) => {
    const desk = reviewDesk(c);
    if ("error" in desk) return desk.error;
    const body = await c.req.json().catch(() => ({} as { workerBps?: number }));
    if (typeof body.workerBps !== "number" || body.workerBps < 0 || body.workerBps > 10_000) return c.json({ error: "workerBps must be 0..10000" }, 400);
    try {
      const sent = await resolveTask(BigInt(c.req.param("id")), body.workerBps);
      return c.json({ txId: sent.txId, hashscan: links({ tx: hashscanTx(sent.txId, config.hedera.network) }) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/fraud", async (c) => {
    const missing = ["BUSD_TOKEN_ID", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY", "BACKEND_ACCOUNT_ID", "BACKEND_PRIVATE_KEY", "ESCROW_CONTRACT_ID", "HCS_TOPIC_ID", "OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY"].filter((k) => !(process.env[k] ?? "").trim());
    if (missing.length) return c.json({ error: "Fraud action is not configured", missing }, 503);
    const body = await c.req.json().catch(() => ({} as { workerId?: string; accountId?: string }));
    if (!body.workerId || !body.accountId) return c.json({ error: "workerId and accountId are required" }, 400);
    const w = get<WorkerRow>(db, "SELECT * FROM workers WHERE id = ?", body.workerId);
    if (!w || !chainEvm(w)) return c.json({ error: "unknown worker" }, 404);
    try {
      const { freeze } = await import("../../../stablecoin/lifecycle");
      const freezeTx = await freeze(body.accountId);
      const status = await setWorkerStatus(chainEvm(w) as `0x${string}`, false);
      banWorker(db, w.id);
      const hcs = await submitHcs(taskMessage({ event: "fraud", worker: body.accountId, token: config.token.id, tx: freezeTx, ts: nowSec() }));
      return c.json({
        freezeTx,
        statusTx: status.txId,
        banned: true,
        hcsSequence: hcs.sequence,
        hashscan: {
          ...links({ tx: hashscanTx(freezeTx, config.hedera.network) }),
          topicMessage: hashscanTopicMessage(hcs.topicId, hcs.sequence, config.hedera.network),
        },
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/compliance/freeze", async (c) => {
    const missing = ["BUSD_TOKEN_ID", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY"].filter((k) => !(process.env[k] ?? "").trim());
    if (missing.length) return c.json({ error: "Freeze is not configured", missing, custody: "demo" }, 503);
    const body = await c.req.json().catch(() => ({} as { accountId?: string }));
    if (!body.accountId) return c.json({ error: "accountId is required" }, 400);
    try {
      const { freeze } = await import("../../../stablecoin/lifecycle");
      const freezeTx = await freeze(body.accountId);
      const w = get<WorkerRow>(db, "SELECT * FROM workers WHERE account_id = ?", body.accountId);
      let statusTx: string | undefined;
      let banned = false;
      let hcsSequence: number | undefined;
      let topicId: string | undefined;
      const fraudMissing = ["BACKEND_ACCOUNT_ID", "BACKEND_PRIVATE_KEY", "ESCROW_CONTRACT_ID", "HCS_TOPIC_ID", "OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY"].filter((k) => !(process.env[k] ?? "").trim());
      if (w && chainEvm(w) && fraudMissing.length === 0 && config.token.id) {
        const status = await setWorkerStatus(chainEvm(w) as `0x${string}`, false);
        banWorker(db, w.id);
        banned = true;
        statusTx = status.txId;
        const hcs = await submitHcs(taskMessage({ event: "fraud", worker: body.accountId, token: config.token.id, tx: freezeTx, ts: nowSec() }));
        hcsSequence = hcs.sequence;
        topicId = hcs.topicId;
      }
      return c.json({
        freezeTx,
        txId: freezeTx,
        statusTx,
        banned,
        accountId: body.accountId,
        hcsSequence,
        topicId,
        custody: "demo",
        custodyNote: "Server-held compliance key (demo custody).",
        hashscan: links({ tx: hashscanTx(freezeTx, config.hedera.network) }),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/redeem", async (c) => {
    const w = worker(db, session(c, db));
    if (!w?.account_id) return c.json({ error: "Bind a payout account first." }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Partial<RedeemRequest>;
    const corridor = body.corridor ?? "USD-INR";
    if (!body.amount) return c.json({ error: "amount is required" }, 400);
    const dest = body.dest ?? { name: "Simulated payout", account: "simulated" };
    const key = keyFor(w.account_id);
    if (!key) return c.json({ error: "No server-held key for this payout account (demo custody).", missing: ["WORKER_A_PRIVATE_KEY"] }, 503);
    try {
      const ramp = new MockOffRamp(async (pair) => {
        const quote = await fetchPublicFx(pair);
        return { rate: quote.rate, source: quote.source };
      });
      const quote = await ramp.quote(decimalToBase(body.amount), corridor);
      const { redeem } = await import("../../../stablecoin/lifecycle");
      const burned = await redeem(w.account_id, key, body.amount);
      const paid = await ramp.payout(quote.id, burned.burnTx, dest);
      return c.json({
        simulated: true,
        text: paid.text,
        path: burned.path,
        transferTx: burned.transferTx,
        burnTx: burned.burnTx,
        quote: { rate: quote.rate, localAmount: quote.localAmount, currency: quote.currency, source: quote.source, simulated: true as const },
        hashscan: links({ tx: hashscanTx(burned.burnTx, config.hedera.network) }),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/fx/:pair", async (c) => {
    const pair = c.req.param("pair").toUpperCase();
    if (!isFxPair(pair)) return c.json({ error: "pair must be USD-INR, USD-PHP, or USD-NGN" }, 400);
    try {
      return c.json(await fetchPublicFx(pair));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/ledger", async (c) => {
    if (!config.hedera.topicId) return c.json({ error: "HCS is not configured", missing: ["HCS_TOPIC_ID"] }, 503);
    const entries = await readTopic(50);
    return c.json({
      topic: config.hedera.topicId,
      hashscan: hashscanTopic(config.hedera.topicId, config.hedera.network),
      messages: entries.map((e) => ({ ...e, hashscan: hashscanTopicMessage(config.hedera.topicId, e.sequence, config.hedera.network) })),
    });
  });

  app.get("/api/scores", (c) => c.json(publicScores(db)));

  app.get("/api/transparency", async (c) => {
    const stats = statsView(db);
    let reserve: string | null = null;
    let supply: string | null = null;
    let nav: string | null = null;
    let reserveTx: string | null = null;
    if (config.token.id) {
      try {
        const view = await reserveView(db);
        reserve = uiDollars(BigInt(view.reserve));
        supply = uiDollars(BigInt(view.supply));
        nav = view.ratio;
        reserveTx = view.lastUpdateTx;
      } catch {
        /* mirror or token read failed; escrow stats and the log still render */
      }
    }
    let log: unknown[] = [];
    if (config.hedera.topicId) {
      try {
        const entries = await readTopic(50);
        log = entries.map((e) => ({
          event: "event" in e ? e.event : e.kind,
          kind: e.kind,
          ts: e.ts,
          amount: "amount" in e && typeof e.amount === "string" && /^\d+$/.test(e.amount) ? uiDollars(BigInt(e.amount)) : "amount" in e ? e.amount : undefined,
          tx: "tx" in e ? e.tx : undefined,
          scheduleId: "scheduleId" in e ? e.scheduleId : undefined,
          token: "token" in e ? e.token : config.token.id || undefined,
          sequence: e.sequence,
          topicId: config.hedera.topicId,
          path: "path" in e ? e.path : undefined,
          worker: "worker" in e ? e.worker : undefined,
        }));
      } catch {
        log = [];
      }
    }
    return c.json({
      reserve,
      reserveTx,
      nav,
      supply,
      valueLocked: uiDollars(BigInt(stats.valueLocked)),
      tokenId: config.token.id || null,
      contractId: config.escrow.contractId || null,
      topicId: config.hedera.topicId || null,
      log,
      leaderboard: publicScores(db).map((row) => ({
        worker: row.worker,
        accountId: /^0\.0\.\d+$/.test(row.worker) || /^0x[0-9a-fA-F]{40}$/.test(row.worker) ? row.worker : null,
        score: row.score,
        paid: row.volume || null,
      })),
      custody: "demo",
    });
  });

  app.get("/x402/busd/reserve", async (c) => {
    if (!ready.x402()) return c.json({ error: "x402 reserve feed is not configured", missing: ["OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY", "FEED_SIGNER_KEY", "BUSD_TOKEN_ID"] }, 503);
    return c.json(await signFeedBody("reserve", await reserveView(db)));
  });
  app.get("/x402/busd/nav", async (c) => {
    if (!ready.x402()) return c.json({ error: "x402 NAV feed is not configured", missing: ["FEED_SIGNER_KEY", "BUSD_TOKEN_ID"] }, 503);
    return c.json(await signFeedBody("nav", await navView(db)));
  });
  app.get("/x402/fx/:pair", async (c) => {
    if (!ready.x402()) return c.json({ error: "x402 FX feed is not configured", missing: ["FEED_SIGNER_KEY"] }, 503);
    const pair = c.req.param("pair").toUpperCase();
    if (!isFxPair(pair)) return c.json({ error: "pair must be USD-INR, USD-PHP, or USD-NGN" }, 400);
    const quote = await fetchPublicFx(pair);
    return c.json(await signFeedBody("fx", { feed: "fx", ...quote }));
  });
  app.get("/x402/client/:id/stats", async (c) => {
    if (!ready.x402()) return c.json({ error: "x402 client stats feed is not configured", missing: ["FEED_SIGNER_KEY"] }, 503);
    const id = c.req.param("id");
    if (!/^\d+\.\d+\.\d+$/.test(id)) return c.json({ error: "client id must be a Hedera account id like 0.0.12345" }, 400);
    return c.json(await signFeedBody("client", clientStats(db, id)));
  });
  app.get("/x402/escrow/stats", async (c) => {
    if (!ready.x402()) return c.json({ error: "x402 stats feed is not configured", missing: ["FEED_SIGNER_KEY"] }, 503);
    return c.json(await signFeedBody("stats", statsView(db)));
  });
}

function keyFor(accountId: string): string | null {
  for (const role of Object.values(config.roles)) {
    if (role.accountId === accountId && role.privateKey) return role.privateKey;
  }
  return null;
}
