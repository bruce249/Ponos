import assert from "node:assert/strict";
import { test } from "node:test";
import { contributorScore, onTimeRate, passRate, SCORE_FLOOR, scoresFromEvents, volumeBusd } from "../src/score";

test("pass rate uses the prior α = 5", () => {
  assert.equal(passRate(0, 0, 0.5), 0.5);
  assert.equal(passRate(1, 1, 0), (1 + 0) / (1 + 5));
});

test("on-time rate is submits over claims", () => {
  assert.equal(onTimeRate(1, 2), 0.5);
  assert.equal(onTimeRate(0, 0), 0);
});

test("volume decays by half every 30 days and k = 200 pulls a small book down", () => {
  assert.equal(volumeBusd([{ valueBusd: 200, ageDays: 0 }]), 200);
  assert.ok(Math.abs(volumeBusd([{ valueBusd: 200, ageDays: 30 }]) - 100) < 1e-9);
  const fresh = contributorScore({
    passes: 10,
    submissions: 10,
    onTimeSubmits: 10,
    claimed: 10,
    volume: 200,
    disputesLost: 0,
    globalPassRate: 1,
  });
  const tiny = contributorScore({
    passes: 10,
    submissions: 10,
    onTimeSubmits: 10,
    claimed: 10,
    volume: 1,
    disputesLost: 0,
    globalPassRate: 1,
  });
  assert.ok(fresh > tiny);
  assert.ok(fresh > 40);
});

test("a lost dispute costs 10 points and the floor is 0", () => {
  const base = {
    passes: 1,
    submissions: 1,
    onTimeSubmits: 1,
    claimed: 1,
    volume: 10_000,
    disputesLost: 0,
    globalPassRate: 1,
  };
  const clean = contributorScore(base);
  const lost = contributorScore({ ...base, disputesLost: 1 });
  assert.ok(Math.abs(clean - lost - 10) < 1e-9);
  assert.equal(contributorScore({ ...base, disputesLost: 100 }), SCORE_FLOOR);
});

test("scoresFromEvents reads only public events and ignores a missing worker sub", () => {
  const rows = scoresFromEvents([
    { worker: "0.0.1", event: "claimed" },
    { worker: "0.0.1", event: "submitted" },
    { worker: "0.0.1", event: "qa_pass" },
    { worker: "0.0.1", event: "released", valueBusd: 40, ageDays: 0 },
    { worker: "0.0.2", event: "claimed" },
    { worker: "0.0.2", event: "resolved", valueBusd: 0, disputeLost: true },
  ]);
  assert.equal(rows[0]?.worker, "0.0.1");
  assert.ok(rows[0]!.score > rows[1]!.score);
  assert.equal(rows[1]?.disputesLost, 1);
});

test("score tiers raise the in-flight cap and never go below the base", async () => {
  const { inFlightCapForScore } = await import("../src/score");
  assert.equal(inFlightCapForScore(0, 2), 2);
  assert.equal(inFlightCapForScore(19.9, 2), 2);
  assert.equal(inFlightCapForScore(20, 2), 4);
  assert.equal(inFlightCapForScore(55, 2), 8);
  assert.equal(inFlightCapForScore(99, 2), 12);
  assert.equal(inFlightCapForScore(99, 20), 20);
});
