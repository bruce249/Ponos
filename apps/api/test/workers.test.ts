import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { banGate, banWorker, claimCapGate, recordClaim } from "../src/caps";
import { config } from "../src/config";
import { chainEvm, get, openDb, run, type WorkerRow } from "../src/db";

const dir = () => mkdtempSync(join(tmpdir(), "byline-workers-"));

function worker(db: ReturnType<typeof openDb>, id: string): WorkerRow {
  run(db, "INSERT INTO workers (id, kind, label, created_at) VALUES (?, 'demo', 'demo human', ?)", id, Date.now());
  return get<WorkerRow>(db, "SELECT * FROM workers WHERE id = ?", id)!;
}

test("the on-chain identity survives a payout change", () => {
  assert.equal(chainEvm({ chain_evm: "0xaaa", evm_address: "0xbbb" }), "0xaaa");
  assert.equal(chainEvm({ chain_evm: null, evm_address: "0xbbb" }), "0xbbb");
  assert.equal(chainEvm({ chain_evm: null, evm_address: null }), null);
});

test("opening an older database adds chain_evm without losing rows", () => {
  const path = join(dir(), "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE workers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT, display_name TEXT, world_iss TEXT, world_sub TEXT, world_acr TEXT, account_id TEXT, evm_address TEXT, banned_at INTEGER, created_at INTEGER NOT NULL)");
  old.exec("INSERT INTO workers (id, kind, evm_address, created_at) VALUES ('w1', 'demo', '0xold', 1)");
  old.close();
  const db = openDb(path);
  const row = get<WorkerRow>(db, "SELECT * FROM workers WHERE id = 'w1'")!;
  assert.equal(row.evm_address, "0xold");
  assert.equal(row.chain_evm, null);
  assert.equal(chainEvm(row), "0xold");
  openDb(path); // a second open is a no-op
});

test("the daily claim cap blocks the claim after the limit", () => {
  const db = openDb(join(dir(), "caps.db"));
  const w = worker(db, "w1");
  for (let i = 0; i < config.caps.dailyClaims - 1; i++) recordClaim(db, w.id, "0xb", i);
  assert.equal(claimCapGate(db, w.id).ok, true);
  recordClaim(db, w.id, "0xb", 99);
  const gate = claimCapGate(db, w.id);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.reason, "cap_reached");
});

test("a ban sticks to the worker and is read back by the gate", () => {
  const db = openDb(join(dir(), "ban.db"));
  const w = worker(db, "w1");
  assert.equal(banGate(w).ok, true);
  banWorker(db, w.id);
  const gate = banGate(get<WorkerRow>(db, "SELECT * FROM workers WHERE id = 'w1'")!);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.reason, "banned");
});
