import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeSubmission } from "../src/qa/grade";

const gold = { q1: "Pune" };
const checklist = ["read the prompt", "cited a source"];
const good = { answers: { q1: "Pune" }, checklist: { "read the prompt": true, "cited a source": true } };

test("a correct gold answer and a complete checklist pass", () => {
  const g = gradeSubmission(good, gold, checklist);
  assert.equal(g.pass, true);
  assert.deepEqual(g.reasons, []);
});

test("a wrong gold answer fails the task", () => {
  const g = gradeSubmission({ ...good, answers: { q1: "Mumbai" } }, gold, checklist);
  assert.equal(g.pass, false);
  assert.deepEqual(g.reasons, ["gold mismatch: q1"]);
});

test("whitespace around an answer is ignored, case is not", () => {
  assert.equal(gradeSubmission({ ...good, answers: { q1: "  Pune \n" } }, gold, checklist).pass, true);
  assert.equal(gradeSubmission({ ...good, answers: { q1: "pune" } }, gold, checklist).pass, false);
});

test("a checklist item must be exactly true, not truthy", () => {
  const g = gradeSubmission({ answers: good.answers, checklist: { "read the prompt": true, "cited a source": "yes" as unknown as boolean } }, gold, checklist);
  assert.equal(g.pass, false);
  assert.deepEqual(g.reasons, ["checklist missing: cited a source"]);
});

test("a missing answers object fails instead of throwing", () => {
  const g = gradeSubmission({} as never, gold, checklist);
  assert.equal(g.pass, false);
  assert.equal(g.reasons.length, 3);
});

test("the report hash is deterministic and changes with the outcome", () => {
  const a = gradeSubmission(good, gold, checklist);
  const b = gradeSubmission(good, gold, checklist);
  const c = gradeSubmission({ ...good, answers: { q1: "x" } }, gold, checklist);
  assert.equal(a.reportHash, b.reportHash);
  assert.notEqual(a.reportHash, c.reportHash);
  assert.match(a.reportHash, /^0x[0-9a-f]{64}$/);
});
