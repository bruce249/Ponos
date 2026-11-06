/**
 * Keeper. Runs every 15 seconds in every scheduling mode.
 * Expires abandoned claims, releases due reviews and unresolved disputes (D8),
 * and refunds revision and failure windows that closed. A revert that leaves
 * state unchanged (frozen, un-KYC'd, paused token) is retried next tick.
 */
import { config } from "./config";
import { accountInfo, EscrowCallError } from "./chain";
import { all, type Db, type TaskRow } from "./db";
import { expireClaim, refundTask, releaseTask } from "./escrow";

function dueMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function alreadyDone(message: string): boolean {
  return /BadState|NotDue|NoneLeft/.test(message);
}

export async function keeperTick(db: Db): Promise<{ acted: number; retried: number }> {
  if (!config.escrow.contractId || !config.roles.backend.privateKey) return { acted: 0, retried: 0 };
  const now = Math.floor(Date.now() / 1000);
  const due = all<TaskRow>(
    db,
    `SELECT * FROM tasks WHERE
       (state = 'Claimed' AND work_deadline > 0 AND work_deadline <= ?)
       OR (state IN ('Submitted', 'AwaitingApproval') AND review_deadline > 0 AND review_deadline <= ?)
       OR (state IN ('Revising', 'Failed') AND action_deadline > 0 AND action_deadline <= ?)
       OR (state = 'Disputed' AND dispute_deadline > 0 AND dispute_deadline <= ?)`,
    now, now, now, now,
  );
  let acted = 0;
  let retried = 0;
  for (const task of due) {
    try {
      if (task.state === "Claimed") await expireClaim(BigInt(task.task_id));
      else if (task.state === "Revising" || task.state === "Failed") await refundTask(BigInt(task.task_id));
      else await releaseTask(BigInt(task.task_id));
      acted += 1;
    } catch (e: unknown) {
      const message = dueMessage(e);
      if (alreadyDone(message)) continue;
      retried += 1;
      const txId = e instanceof EscrowCallError ? e.txId : "";
      console.error(`[keeper] task ${task.task_id} ${task.state} will retry: ${message}${txId ? ` (${txId})` : ""}`);
    }
  }
  if (config.escrow.contractId) {
    try {
      const info = await accountInfo(config.escrow.contractId);
      if (info && info.balanceTinybar < config.escrow.hbarLowTinybar) {
        console.warn(`[keeper] escrow HBAR is low: ${info.balanceTinybar} tinybar (watermark ${config.escrow.hbarLowTinybar}). HIP-1215 schedules need this balance.`);
      }
    } catch {
      /* contract account may not be visible as an account yet */
    }
  }
  return { acted, retried };
}
