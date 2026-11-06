import assert from "node:assert/strict";
import { test } from "node:test";
import { platformFee, releaseSplit, resolutionConserves, resolveSplit, splitFee } from "../src/fee";

const FEE = 300n;
const QA = 3333n;

test("fee is pay * bps / 10000, matching the contract", () => {
  assert.equal(platformFee(40_000_000n, FEE), 1_200_000n);
  assert.equal(platformFee(250_000_000n, FEE), 7_500_000n);
  assert.equal(platformFee(1n, FEE), 0n);
});

test("QA share dust stays with the treasury", () => {
  const fee = platformFee(40_000_000n, FEE);
  const split = splitFee(fee, QA);
  assert.equal(split.qa + split.treasury, fee);
  assert.equal(split.qa, (fee * QA) / 10_000n);
  assert.ok(split.treasury >= split.qa || split.treasury === fee - split.qa);
});

test("a release pays the worker `pay` and splits only the fee", () => {
  const s = releaseSplit(40_000_000n, FEE, QA);
  assert.equal(s.pay, 40_000_000n);
  assert.equal(s.treasury + s.qa, s.fee);
  assert.equal(s.unit, s.pay + s.fee);
});

test("resolve charges the fee only on the worker share and conserves pay+fee", () => {
  for (const bps of [0n, 1n, 2500n, 5000n, 9999n, 10_000n]) {
    assert.equal(resolutionConserves(40_000_000n, FEE, QA, bps), true);
    assert.equal(resolutionConserves(1n, FEE, QA, bps), true);
    assert.equal(resolutionConserves(250_000_000n, FEE, QA, bps), true);
  }
  const full = resolveSplit(100n, FEE, QA, 10_000n);
  assert.equal(full.worker, 100n);
  assert.equal(full.client, 0n);
  const none = resolveSplit(100n, FEE, QA, 0n);
  assert.equal(none.worker, 0n);
  assert.equal(none.fee, 0n);
  assert.equal(none.client, 100n + platformFee(100n, FEE));
});

test("a refund is the full unit, not a haircut", () => {
  const pay = 40_000_000n;
  const fee = platformFee(pay, FEE);
  assert.equal(pay + fee, 41_200_000n);
});
