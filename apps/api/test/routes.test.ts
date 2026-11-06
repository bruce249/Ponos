/**
 * Route guards, driven through the real Hono app with a throwaway SQLite file.
 * Every case here is decided before any Hedera call, so the suite needs no network or keys.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PrivateKey } from "@hiero-ledger/sdk";
import type { Hono } from "hono";

const dir = mkdtempSync(join(tmpdir(), "byline-routes-"));
const fakeKey = () => PrivateKey.generateECDSA().toStringDer();

// Config is read once at import, so the environment is set first.
Object.assign(process.env, {
  HEDERA_NETWORK: "hedera:testnet",
  DEMO_MOCK_WORLD: "1",
  DB_PATH: join(dir, "test.db"),
  BUSD_TOKEN_ID: "0.0.5001",
  ESCROW_CONTRACT_ID: "0.0.5002",
  COMPLIANCE_ACCOUNT_ID: "0.0.6001",
  COMPLIANCE_PRIVATE_KEY: fakeKey(),
  TREASURY_ACCOUNT_ID: "0.0.6002",
  TREASURY_PRIVATE_KEY: fakeKey(),
  LAB_ACCOUNT_ID: "0.0.6003",
  LAB_PRIVATE_KEY: fakeKey(),
  REVIEWER_ACCOUNT_ID: "0.0.6004",
  REVIEWER_PRIVATE_KEY: fakeKey(),
  WORKER_A_ACCOUNT_ID: "0.0.7001",
  WORKER_A_PRIVATE_KEY: fakeKey(),
  LAB_ALLOWLIST: "",
  REVIEWER_ALLOWLIST: "",
  FEED_SIGNER_KEY: "",
  OPERATOR_ACCOUNT_ID: "",
  OPERATOR_PRIVATE_KEY: "",
});

let app: Hono;
let close = () => {};

before(async () => {
  const { openDb } = await import("../src/db");
  const { createApp } = await import("../src/app");
  const db = openDb(process.env.DB_PATH!);
  close = () => db.close();
  app = createApp(db, { x402: false });
});

after(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await app.request(path, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function demoWorker(accountId?: string) {
  const res = await call("/api/demo/worker", { method: "POST", body: JSON.stringify({ displayName: "Asha", accountId }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

test("health and unknown routes answer JSON", async () => {
  assert.deepEqual((await call("/api/health")).body, { ok: true, service: "byline-work" });
  const missing = await call("/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "not found");
});

test("config never reports custody other than demo and does not leak keys", async () => {
  const res = await call("/api/config");
  assert.equal(res.body.custody, "demo");
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE|302e|3030/);
});

test("a demo worker cannot claim a platform role account", async () => {
  const res = await call("/api/demo/worker", { method: "POST", body: JSON.stringify({ accountId: "0.0.6002" }) });
  assert.equal(res.status, 400);
  const bad = await call("/api/demo/worker", { method: "POST", body: JSON.stringify({ accountId: "treasury" }) });
  assert.equal(bad.status, 400);
});

test("redeem only signs with a demo worker wallet key, never another role's key", async () => {
  const stranger = await demoWorker("0.0.9999");
  const res = await call("/api/redeem", { method: "POST", cookie: stranger.cookie, body: JSON.stringify({ amount: "5" }) });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /WORKER_A/);
});

test("redeem rejects malformed amounts before touching the chain", async () => {
  const w = await demoWorker("0.0.7001");
  for (const amount of ["-1", "1.0000001", "abc", "0"]) {
    const res = await call("/api/redeem", { method: "POST", cookie: w.cookie, body: JSON.stringify({ amount }) });
    assert.equal(res.status, 400, `amount ${amount}`);
  }
});

test("payout binding refuses platform accounts and a wallet already bound to someone else", async () => {
  await demoWorker("0.0.8001");
  const other = await demoWorker();
  const taken = await call("/api/work/payout", { method: "POST", cookie: other.cookie, body: JSON.stringify({ accountId: "0.0.8001" }) });
  assert.equal(taken.status, 409);
  const role = await call("/api/work/payout", { method: "POST", cookie: other.cookie, body: JSON.stringify({ accountId: "0.0.6003" }) });
  assert.equal(role.status, 400);
});

test("freeze never targets the escrow, the treasury, or another platform role", async () => {
  for (const accountId of ["0.0.5002", "0.0.6002", "0.0.6003", "0.0.6004"]) {
    const res = await call("/api/compliance/freeze", { method: "POST", body: JSON.stringify({ accountId }) });
    assert.equal(res.status, 400, accountId);
  }
});

test("a desk header that is not on the allowlist is rejected", async () => {
  const res = await call("/api/compliance/freeze", { method: "POST", headers: { "x-byline-account": "0.0.1" }, body: JSON.stringify({ accountId: "0.0.7001" }) });
  assert.equal(res.status, 403);
});

test("review routes validate the task id and resolve basis points", async () => {
  assert.equal((await call("/api/review/abc/approve", { method: "POST" })).status, 400);
  assert.equal((await call("/api/review/1e3/hold", { method: "POST", body: JSON.stringify({ reason: "x" }) })).status, 400);
  assert.equal((await call("/api/review/1/hold", { method: "POST", body: JSON.stringify({ reason: "   " }) })).status, 400);
  for (const workerBps of [1.5, -1, 10_001, "5000"]) {
    const res = await call("/api/review/1/resolve", { method: "POST", body: JSON.stringify({ workerBps }) });
    assert.equal(res.status, 400, String(workerBps));
  }
});

test("logout ends the worker session on the server, not only the cookie", async () => {
  const w = await demoWorker();
  assert.equal((await call("/api/me", { cookie: w.cookie })).body.signedIn, true);
  await call("/api/world/logout", { method: "POST", cookie: w.cookie });
  assert.equal((await call("/api/me", { cookie: w.cookie })).body.signedIn, false);
});

test("submit with a broken body is a 400, not a crash", async () => {
  const w = await demoWorker();
  const res = await call("/api/tasks/1/submit", { method: "POST", cookie: w.cookie, body: "{not json" });
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
  assert.equal(typeof res.body.error, "string");
});
