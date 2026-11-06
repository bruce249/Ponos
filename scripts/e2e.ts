/**
 * Headless instant, approved, and timeout paths.
 * Checks exact bUSD deltas and one HCS message per transition (via an indexer tick).
 * hip1215/sdk must leave a schedule id. keeper mode pays by a keeper tick.
 *   npm run e2e
 */
import { randomUUID } from "node:crypto";
import { decimalToBase, releaseSplit } from "@byline-work/shared";
import { evmAddressFromKey, tokenBalance } from "../apps/api/src/chain";
import { config } from "../apps/api/src/config";
import { get, openDb, run, type WorkerRow } from "../apps/api/src/db";
import { approveTask, registerWorker } from "../apps/api/src/escrow";
import { indexerTick } from "../apps/api/src/indexer";
import { keeperTick } from "../apps/api/src/keeper";
import { claim, createBatch, submit } from "../apps/api/src/work";
import { kyc } from "../stablecoin/lifecycle";
import { die, missing, need } from "./lib";

const absent = missing([
  "LAB_ACCOUNT_ID", "LAB_PRIVATE_KEY", "WORKER_A_ACCOUNT_ID", "WORKER_A_PRIVATE_KEY",
  "BACKEND_ACCOUNT_ID", "BACKEND_PRIVATE_KEY", "QA_ORACLE_ACCOUNT_ID", "QA_ORACLE_PRIVATE_KEY",
  "REVIEWER_ACCOUNT_ID", "REVIEWER_PRIVATE_KEY", "TREASURY_ACCOUNT_ID", "QA_POOL_ACCOUNT_ID",
  "BUSD_TOKEN_ID", "ESCROW_CONTRACT_ID", "ESCROW_ADDRESS", "HCS_TOPIC_ID",
  "OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY", "COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY",
]);
if (absent.length) die(`e2e is not configured. Missing: ${absent.join(", ")}`);

const token = need("BUSD_TOKEN_ID");
const scheduling = config.escrow.scheduling;
const lab = need("LAB_ACCOUNT_ID");
const workerAccount = need("WORKER_A_ACCOUNT_ID");
const treasury = need("TREASURY_ACCOUNT_ID");
const qaPool = need("QA_POOL_ACCOUNT_ID");
const evm = evmAddressFromKey(need("WORKER_A_PRIVATE_KEY"));

await kyc(workerAccount);
await registerWorker(evm, evm, 20);
const db = openDb(config.dbPath);
const workerId = randomUUID();
run(db, "INSERT INTO workers (id, kind, label, display_name, account_id, evm_address, created_at) VALUES (?, 'demo', 'demo human', 'e2e', ?, ?, ?)", workerId, workerAccount, evm, Date.now());
const worker: WorkerRow = { id: workerId, kind: "demo", label: "demo human", display_name: "e2e", world_iss: null, world_sub: null, world_acr: null, account_id: workerAccount, evm_address: evm, chain_evm: evm, banned_at: null, created_at: Date.now() };

const gold = { q1: "ok" };
const checklist = ["done"];
const one = () => ({ prompt: "Reply ok", gold, checklist });
const window = Number(process.env.MIN_WINDOW_SEC || "120");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function expectHcs(taskId: number, names: string[]) {
  await indexerTick(db);
  for (const name of names) {
    const row = get<{ hcs_sequence: number | null }>(db, "SELECT hcs_sequence FROM task_events WHERE task_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1", taskId, name);
    if (!row?.hcs_sequence) die(`No HCS message for ${name} on task ${taskId}. The indexer tick did not anchor it.`);
    console.log(`  hcs ${name} #${row.hcs_sequence}`);
  }
}

async function assertPaid(payDecimal: string, before: { worker: bigint; treasury: bigint; qa: bigint }) {
  const pay = decimalToBase(payDecimal);
  const split = releaseSplit(pay, config.escrow.feeBps, config.escrow.qaBps);
  const after = {
    worker: await tokenBalance(workerAccount, token),
    treasury: await tokenBalance(treasury, token),
    qa: await tokenBalance(qaPool, token),
  };
  const check = (label: string, got: bigint, expected: bigint) => {
    if (got !== expected) {
      die(`${label} delta ${got} != ${expected}. A bUSD custom fee would skim the escrow; the HTS fee must stay in HBAR or the escrow, treasury, and QA pool must be exempt.`);
    }
  };
  check("worker", after.worker - before.worker, split.pay);
  check("treasury", after.treasury - before.treasury, split.treasury);
  check("qa pool", after.qa - before.qa, split.qa);
  console.log(`  balances match pay ${split.pay} treasury ${split.treasury} qa ${split.qa}`);
}

async function balances() {
  return {
    worker: await tokenBalance(workerAccount, token),
    treasury: await tokenBalance(treasury, token),
    qa: await tokenBalance(qaPool, token),
  };
}

console.log(`scheduling: ${scheduling}`);
let keeperPaid = false;

console.log("instant");
{
  const batch = await createBatch(db, { title: "e2e instant", qaMode: "auto", payPerTask: "40", taskCount: 1, reviewWindow: window, workWindow: window, revisionWindow: window, rubric: checklist, tasks: [one()], labAccountId: lab });
  const claimed = await claim(db, worker, batch.batchId);
  const before = await balances();
  await submit(db, worker, Number(claimed.taskId), { answers: gold, checklist: { done: true } }, false);
  await expectHcs(Number(claimed.taskId), ["TaskClaimed", "TaskSubmitted", "QaPassed", "TaskReleased"]);
  await assertPaid("40", before);
}

console.log("approved");
{
  const batch = await createBatch(db, { title: "e2e approved", qaMode: "auto", payPerTask: "250", taskCount: 1, reviewWindow: 3600, workWindow: 3600, revisionWindow: 3600, rubric: checklist, tasks: [one()], labAccountId: lab });
  const claimed = await claim(db, worker, batch.batchId);
  await submit(db, worker, Number(claimed.taskId), { answers: gold, checklist: { done: true } }, false);
  const before = await balances();
  await approveTask(BigInt(claimed.taskId));
  await expectHcs(Number(claimed.taskId), ["TaskClaimed", "TaskSubmitted", "QaPassed", "TaskApproved", "TaskReleased"]);
  await assertPaid("250", before);
}

console.log("timeout");
{
  const batch = await createBatch(db, { title: "e2e timeout", qaMode: "manual", payPerTask: "40", taskCount: 1, reviewWindow: window, workWindow: 3600, revisionWindow: window, rubric: checklist, tasks: [one()], labAccountId: lab });
  const claimed = await claim(db, worker, batch.batchId);
  const submitted = await submit(db, worker, Number(claimed.taskId), { answers: gold, checklist: { done: true } }, false);
  if (submitted.qa) die("manual batch was auto-graded");
  await indexerTick(db);
  const task = get<{ schedule_address: string | null; schedule_id: string | null; review_deadline: number | null }>(db, "SELECT schedule_address, schedule_id, review_deadline FROM tasks WHERE task_id = ?", Number(claimed.taskId));
  const schedule = task?.schedule_id || task?.schedule_address || "";
  const zero = "0x0000000000000000000000000000000000000000";
  if (scheduling === "hip1215" && (!schedule || schedule.toLowerCase() === zero)) die("hip1215 submit did not record a schedule id");
  if (scheduling === "sdk" && !task?.schedule_id) die("sdk scheduling did not record a schedule id");
  if (scheduling === "keeper" && task?.schedule_address) die("keeper mode should not schedule inside the contract");
  if (scheduling !== "keeper") console.log(`  schedule ${schedule}`);
  const before = await balances();
  const deadline = (task?.review_deadline ?? Math.floor(Date.now() / 1000) + window) * 1000;
  if (scheduling === "keeper") {
    await sleep(Math.max(0, deadline - Date.now() + 2000));
    await keeperTick(db);
  } else {
    const until = deadline + 45_000;
    while (Date.now() < until) {
      await sleep(5000);
      await indexerTick(db);
      const state = get<{ state: string }>(db, "SELECT state FROM tasks WHERE task_id = ?", Number(claimed.taskId));
      if (state?.state === "Released") break;
    }
    const state = get<{ state: string }>(db, "SELECT state FROM tasks WHERE task_id = ?", Number(claimed.taskId));
    if (state?.state !== "Released") {
      // The keeper would still pay, so a green run could hide a schedule that never fires (spike S3, decision D1).
      const msg = `The ${scheduling} schedule did not release task ${claimed.taskId} by ${new Date(until).toISOString()}.`;
      if (process.env.E2E_ALLOW_KEEPER_FALLBACK !== "1") {
        die(`${msg} The keeper would pay it, but D1 needs to know the schedule failed. Set ESCROW_SCHEDULING=keeper (redeploy with the flag off) or E2E_ALLOW_KEEPER_FALLBACK=1 to accept the keeper.`);
      }
      console.log(`  WARNING: ${msg} Keeper tick instead (E2E_ALLOW_KEEPER_FALLBACK=1).`);
      await keeperTick(db);
      keeperPaid = true;
    }
  }
  await expectHcs(Number(claimed.taskId), ["TaskClaimed", "TaskSubmitted", "TaskReleased"]);
  await assertPaid("40", before);
}

console.log(keeperPaid ? "e2e ok, but the timeout was paid by the keeper, not the schedule" : scheduling === "keeper" ? "e2e ok (keeper path)" : "e2e ok (scheduled release paid)");
