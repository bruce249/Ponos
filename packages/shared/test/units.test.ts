import assert from "node:assert/strict";
import { test } from "node:test";
import { baseToDecimal, decimalToBase, hbarToTinybar, HITL_BASE_UNITS, requiresStepUp, tinybarToHbar } from "../src/units";

test("bUSD base units reject floats on the way in and round-trip", () => {
  assert.equal(decimalToBase("40"), 40_000_000n);
  assert.equal(decimalToBase("100"), HITL_BASE_UNITS);
  assert.equal(decimalToBase("0.000001"), 1n);
  assert.equal(baseToDecimal(40_000_000n), "40");
  assert.equal(baseToDecimal(1n), "0.000001");
  assert.equal(baseToDecimal(decimalToBase("250.5")), "250.5");
  assert.throws(() => decimalToBase("1.0000001"));
  assert.throws(() => decimalToBase("-1"));
  assert.throws(() => decimalToBase("1e2"));
});

test("step-up starts strictly above 100 bUSD", () => {
  assert.equal(requiresStepUp(100_000_000n), false);
  assert.equal(requiresStepUp(100_000_001n), true);
  assert.equal(requiresStepUp(40_000_000n), false);
});

test("tinybars", () => {
  assert.equal(hbarToTinybar("0.001"), 100_000n);
  assert.equal(hbarToTinybar("0.005"), 500_000n);
  assert.equal(tinybarToHbar(100_000n), "0.001");
});
