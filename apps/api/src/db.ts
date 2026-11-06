/**
 * Server state. Node's built-in SQLite, no native addon.
 * World `sub`, work bodies, gold answers and sessions never leave this file.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,                         -- 'world' | 'demo'
      label TEXT,                                 -- 'demo human' when kind is demo
      display_name TEXT,
      world_iss TEXT,
      world_sub TEXT,
      world_acr TEXT,
      account_id TEXT,
      evm_address TEXT,                           -- payout address, may change
      chain_evm TEXT,                             -- identity registered on the escrow, never changes
      banned_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (world_iss, world_sub)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      worker_id TEXT REFERENCES workers(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oidc (
      state TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      purpose TEXT NOT NULL,                      -- 'login' | 'stepup'
      action TEXT,                                -- 'claim_high' | 'payout_wallet'
      target TEXT,
      nonce TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES workers(id),
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      auth_time INTEGER NOT NULL,
      acr TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT,
      session_id TEXT,
      action TEXT,
      target TEXT,
      reason TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rubric TEXT NOT NULL,
      qa_mode TEXT NOT NULL,                      -- auto | manual
      client_account_id TEXT,
      client_evm TEXT,
      pay_per_task TEXT NOT NULL,
      task_count INTEGER NOT NULL,
      unclaimed INTEGER NOT NULL,
      review_window INTEGER NOT NULL,
      work_window INTEGER NOT NULL,
      revision_window INTEGER NOT NULL,
      funded_tx TEXT,
      receipt_sequence INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batch_items (
      batch_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      gold_json TEXT NOT NULL,
      checklist_json TEXT NOT NULL,
      task_id INTEGER,
      PRIMARY KEY (batch_id, idx)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL,
      state TEXT NOT NULL,
      worker_id TEXT,
      worker_evm TEXT,
      payout TEXT,
      work_deadline INTEGER,
      review_deadline INTEGER,
      action_deadline INTEGER,
      dispute_deadline INTEGER,
      work_hash TEXT,
      report_hash TEXT,
      reason_hash TEXT,
      reason_text TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      schedule_address TEXT,
      schedule_id TEXT,
      pay_base TEXT,
      worker_amount TEXT,
      path TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      task_id INTEGER,
      batch_id TEXT,
      payload TEXT NOT NULL,
      hcs_sequence INTEGER,
      hcs_topic TEXT,
      hcs_error TEXT,
      hcs_attempts INTEGER NOT NULL DEFAULT 0,
      consensus_ts TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS work (
      id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      body TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      report_hash TEXT NOT NULL,
      body TEXT NOT NULL,
      zg_request_id TEXT,
      tee_verified INTEGER,
      chain_tx TEXT,
      chain_error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      task_id INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nav_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nav TEXT NOT NULL,
      supply TEXT NOT NULL,
      reserve TEXT NOT NULL,
      tx TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fx_cache (
      pair TEXT PRIMARY KEY,
      rate TEXT NOT NULL,
      source TEXT NOT NULL,
      tx_id TEXT,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_batch ON tasks(batch_id, state);
    CREATE INDEX IF NOT EXISTS claims_worker ON claims(worker_id, created_at);
    CREATE INDEX IF NOT EXISTS events_hcs ON task_events(hcs_sequence, hcs_attempts);
  `);
  const cols = db.prepare("PRAGMA table_info(workers)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "chain_evm")) db.exec("ALTER TABLE workers ADD COLUMN chain_evm TEXT");
  return db;
}

/** The address the escrow knows this worker by. A payout change moves `evm_address` but never this. */
export function chainEvm(w: { chain_evm: string | null; evm_address: string | null }): string | null {
  return w.chain_evm ?? w.evm_address;
}

export function get<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as [])) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as [])) as T[];
}

export function run(db: Db, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as []));
}

export function metaGet(db: Db, key: string): string | undefined {
  return get<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key)?.value;
}

export function metaSet(db: Db, key: string, value: string) {
  run(db, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

export type WorkerRow = {
  id: string;
  kind: "world" | "demo";
  label: string | null;
  display_name: string | null;
  world_iss: string | null;
  world_sub: string | null;
  world_acr: string | null;
  account_id: string | null;
  evm_address: string | null;
  chain_evm: string | null;
  banned_at: number | null;
  created_at: number;
};

export type BatchRow = {
  id: string;
  title: string;
  rubric: string;
  qa_mode: "auto" | "manual";
  client_account_id: string | null;
  client_evm: string | null;
  pay_per_task: string;
  task_count: number;
  unclaimed: number;
  review_window: number;
  work_window: number;
  revision_window: number;
  funded_tx: string | null;
  receipt_sequence: number | null;
  created_at: number;
};

export type TaskRow = {
  task_id: number;
  batch_id: string;
  state: string;
  worker_id: string | null;
  worker_evm: string | null;
  payout: string | null;
  work_deadline: number | null;
  review_deadline: number | null;
  action_deadline: number | null;
  dispute_deadline: number | null;
  work_hash: string | null;
  report_hash: string | null;
  reason_hash: string | null;
  reason_text: string | null;
  fail_count: number;
  schedule_address: string | null;
  schedule_id: string | null;
  pay_base: string | null;
  worker_amount: string | null;
  path: string | null;
  updated_at: number;
};

export type ApprovalRow = {
  id: string;
  worker_id: string;
  action: string;
  target: string;
  auth_time: number;
  acr: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
};

export type OidcRow = {
  state: string;
  session_id: string;
  purpose: "login" | "stepup";
  action: string | null;
  target: string | null;
  nonce: string;
  code_verifier: string;
  created_at: number;
  consumed_at: number | null;
};
