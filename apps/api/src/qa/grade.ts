/** Deterministic QA: gold answers plus a rubric checklist. No model, no randomness. */
import { createHash } from "node:crypto";
import type { WorkSubmission } from "@byline-work/shared";

export type Grade = {
  pass: boolean;
  reasons: string[];
  reportHash: `0x${string}`;
  body: { reasons: string[]; goldChecked: number; checklist: string[] };
};

export type ZgVerdict = "pass" | "fail" | "unknown";

/** Reads the `pass` field of the model's JSON reply. Anything unparseable is "unknown", never a failure. */
export function parseZgVerdict(text: string): ZgVerdict {
  const m = /"pass"\s*:\s*(true|false)/.exec(text);
  return m ? (m[1] === "true" ? "pass" : "fail") : "unknown";
}

export function gradeSubmission(submission: WorkSubmission, gold: Record<string, string>, checklist: string[]): Grade {
  const reasons: string[] = [];
  for (const [key, want] of Object.entries(gold)) {
    const got = String(submission.answers?.[key] ?? "").trim();
    if (got !== String(want).trim()) reasons.push(`gold mismatch: ${key}`);
  }
  for (const item of checklist) {
    if (submission.checklist?.[item] !== true) reasons.push(`checklist missing: ${item}`);
  }
  const body = { reasons, goldChecked: Object.keys(gold).length, checklist };
  const reportHash = `0x${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}` as `0x${string}`;
  return { pass: reasons.length === 0, reasons, reportHash, body };
}
