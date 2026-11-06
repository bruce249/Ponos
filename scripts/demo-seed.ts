/**
 * One take: deposit 1,000 bUSD, fund three new batches, and claim+submit the timeout task.
 * Batch ids are new every run. Stops with a plain list if the chain is not configured.
 *   npm run demo-seed
 */
import { evmAddressFromKey } from "../apps/api/src/chain";
import { config } from "../apps/api/src/config";
import { openDb, run } from "../apps/api/src/db";
import { registerWorker } from "../apps/api/src/escrow";
import { claim, createBatch, submit } from "../apps/api/src/work";
import { deposit, kyc } from "../stablecoin/lifecycle";
import { die, missing, need } from "./lib";
import { randomUUID } from "node:crypto";

const absent = missing([
  "LAB_ACCOUNT_ID",
  "LAB_PRIVATE_KEY",
  "WORKER_A_ACCOUNT_ID",
  "WORKER_A_PRIVATE_KEY",
  "BACKEND_ACCOUNT_ID",
  "BACKEND_PRIVATE_KEY",
  "BUSD_TOKEN_ID",
  "BUSD_RESERVE_ADDRESS",
  "ESCROW_CONTRACT_ID",
  "ESCROW_ADDRESS",
  "TREASURY_ACCOUNT_ID",
  "QA_POOL_ACCOUNT_ID",
  "SCS_ADMIN_ACCOUNT_ID",
  "SCS_ADMIN_PRIVATE_KEY",
  "CASHIN_ACCOUNT_ID",
  "CASHIN_PRIVATE_KEY",
  "COMPLIANCE_ACCOUNT_ID",
  "COMPLIANCE_PRIVATE_KEY",
]);
if (absent.length) die(`demo-seed is not configured. Missing: ${absent.join(", ")}`);

const lab = need("LAB_ACCOUNT_ID");
const workerAccount = need("WORKER_A_ACCOUNT_ID");
console.log("demo custody: the lab key is held by this process.");

const deposited = await deposit(lab, "1000");
console.log(`deposited 1000 bUSD  reserve ${deposited.reserveTx}  cash-in ${deposited.cashInTx}`);

for (const id of [lab, need("TREASURY_ACCOUNT_ID"), need("QA_POOL_ACCOUNT_ID"), need("ESCROW_CONTRACT_ID"), workerAccount]) {
  const tx = await kyc(id);
  console.log(`kyc ${id}  ${tx}`);
}

const evm = evmAddressFromKey(need("WORKER_A_PRIVATE_KEY"));
const registered = await registerWorker(evm, evm, config.caps.inFlightNew);
console.log(`registerWorker ${registered.txId}`);

const db = openDb(config.dbPath);
const workerId = randomUUID();
run(
  db,
  "INSERT INTO workers (id, kind, label, display_name, account_id, evm_address, created_at) VALUES (?, 'demo', 'demo human', 'Pune demo', ?, ?, ?)",
  workerId, workerAccount, evm, Date.now(),
);
const worker = { id: workerId, kind: "demo" as const, label: "demo human", display_name: "Pune demo", world_iss: null, world_sub: null, world_acr: null, account_id: workerAccount, evm_address: evm, banned_at: null, created_at: Date.now() };

const gold = { q1: "Pune" };
const checklist = ["read the prompt"];
const prompt = "Where is the freelancer in the demo script?";
const task = () => ({ prompt, gold, checklist });

const a = await createBatch(db, {
  title: "Batch A",
  qaMode: "auto",
  payPerTask: "40",
  taskCount: 10,
  reviewWindow: 3600,
  workWindow: 3600,
  revisionWindow: 3600,
  rubric: checklist,
  tasks: Array.from({ length: 10 }, task),
  labAccountId: lab,
});
const b = await createBatch(db, {
  title: "Batch B",
  qaMode: "auto",
  payPerTask: "250",
  taskCount: 1,
  reviewWindow: 3600,
  workWindow: 3600,
  revisionWindow: 3600,
  rubric: checklist,
  tasks: [task()],
  labAccountId: lab,
});
const c = await createBatch(db, {
  title: "Batch C timeout",
  qaMode: "manual",
  payPerTask: "40",
  taskCount: 1,
  reviewWindow: Number(process.env.MIN_WINDOW_SEC || "120"),
  workWindow: 3600,
  revisionWindow: Number(process.env.MIN_WINDOW_SEC || "120"),
  rubric: checklist,
  tasks: [task()],
  labAccountId: lab,
});
const claimed = await claim(db, worker, c.batchId);
const submitted = await submit(db, worker, Number(claimed.taskId), { answers: gold, checklist: { "read the prompt": true } }, false);

console.log("Funded: $1000 locked across three new batches (demo custody).");
console.log(`BATCH_A=${a.batchId}  ${a.totalDecimal} bUSD  ${a.txId}`);
console.log(`BATCH_B=${b.batchId}  ${b.totalDecimal} bUSD  ${b.txId}`);
console.log(`BATCH_C=${c.batchId}  task ${claimed.taskId} submitted ${submitted.txId}`);
console.log("Batch C is manual. Auto QA will not pass it. The timeout scene pays it.");
console.log(`worker label: demo human (not a World ID)`);
