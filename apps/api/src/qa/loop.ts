/**
 * Auto QA runs as soon as work is stored, and again from this loop if the
 * process died between the database write and the chain call.
 * Manual batches are never graded here. They wait for the deadline.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Hex, WorkSubmission } from "@byline-work/shared";
import { config } from "../config";
import { all, get, run, type Db } from "../db";
import { qaFail, qaPass } from "../escrow";
import { gradeSubmission, parseZgVerdict, type ZgVerdict } from "./grade";
import { zgChat } from "./zg";

type Pending = { task_id: number; body: string; qa_mode: string; gold_json: string; checklist_json: string };

export async function gradeTask(db: Db, taskId: number): Promise<{ pass: boolean; reportHash: Hex; txId: string | null } | null> {
  const row = get<Pending>(
    db,
    `SELECT t.task_id, w.body, b.qa_mode, i.gold_json, i.checklist_json
     FROM tasks t
     JOIN batches b ON b.id = t.batch_id
     JOIN work w ON w.task_id = t.task_id
     LEFT JOIN batch_items i ON i.task_id = t.task_id
     WHERE t.task_id = ? AND t.state = 'Submitted'
     ORDER BY w.created_at DESC LIMIT 1`,
    taskId,
  );
  if (!row || row.qa_mode !== "auto" || !row.gold_json) return null;
  const already = get<{ id: string; chain_tx: string | null }>(db, "SELECT id, chain_tx FROM reports WHERE task_id = ? AND chain_tx IS NOT NULL ORDER BY created_at DESC LIMIT 1", taskId);
  if (already?.chain_tx) return null;

  const submission = JSON.parse(row.body) as WorkSubmission;
  const gold = JSON.parse(row.gold_json) as Record<string, string>;
  const checklist = JSON.parse(row.checklist_json) as string[];
  const grade = gradeSubmission(submission, gold, checklist);

  let requestId: string | null = null;
  let teeVerified: boolean | null = null;
  let zgNote: string | null = null;
  let zgVerdict: ZgVerdict | null = null;
  if (config.zg.apiKey) {
    try {
      const zg = await zgChat(config.zg, [
        { role: "system", content: "You grade a rubric. Reply with JSON {\"pass\": boolean, \"notes\": string}. Do not invent a TEE flag." },
        { role: "user", content: JSON.stringify({ goldKeys: Object.keys(gold), checklist, deterministicPass: grade.pass, reasons: grade.reasons }) },
      ], { json: true, maxTokens: 400, temperature: 0 });
      requestId = zg.requestId;
      teeVerified = zg.teeVerified;
      zgNote = zg.text.slice(0, 500);
      // Advisory only. The model is sent gold keys and a flag, not the worker's answer, so it cannot judge the work,
      // and on testnet it flipped a correct submission to fail. The outcome comes from the deterministic grade alone.
      zgVerdict = parseZgVerdict(zg.text);
    } catch (e: unknown) {
      zgNote = e instanceof Error ? e.message : String(e);
      teeVerified = null;
    }
  }

  const reportBody = { reasons: grade.reasons, goldChecked: grade.body.goldChecked, checklist: grade.body.checklist, zgNote, zgVerdict, zgDisagrees: zgVerdict !== null && zgVerdict !== "unknown" && (zgVerdict === "pass") !== grade.pass };
  grade.reportHash = `0x${createHash("sha256").update(JSON.stringify(reportBody), "utf8").digest("hex")}`;
  const id = randomUUID();
  let txId: string | null = null;
  let chainError: string | null = null;
  try {
    const sent = grade.pass ? await qaPass(BigInt(taskId), grade.reportHash) : await qaFail(BigInt(taskId), grade.reportHash);
    txId = sent.txId;
  } catch (e: unknown) {
    chainError = e instanceof Error ? e.message : String(e);
  }
  run(
    db,
    `INSERT INTO reports (id, task_id, passed, report_hash, body, zg_request_id, tee_verified, chain_tx, chain_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    taskId,
    grade.pass ? 1 : 0,
    grade.reportHash,
    JSON.stringify(reportBody),
    requestId,
    teeVerified === null ? null : teeVerified ? 1 : 0,
    txId,
    chainError,
    Date.now(),
  );
  return { pass: grade.pass, reportHash: grade.reportHash, txId };
}

/** Manual batches are filtered out in SQL. A manual task cannot be auto-passed. */
export async function qaTick(db: Db): Promise<number> {
  const rows = all<{ task_id: number }>(
    db,
    `SELECT t.task_id FROM tasks t
     JOIN batches b ON b.id = t.batch_id
     WHERE t.state = 'Submitted' AND b.qa_mode = 'auto'
       AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.task_id = t.task_id AND r.chain_tx IS NOT NULL)
     LIMIT 10`,
  );
  let n = 0;
  for (const row of rows) {
    const graded = await gradeTask(db, row.task_id);
    if (graded) n += 1;
  }
  return n;
}
