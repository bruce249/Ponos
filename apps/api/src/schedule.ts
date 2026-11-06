/**
 * SDK scheduled release (HIP-423). Used only when ESCROW_SCHEDULING=sdk.
 * HIP-1215 scheduling lives inside the contract. The keeper runs in every mode.
 */
import { ContractExecuteTransaction, ContractId, ScheduleCreateTransaction, Timestamp } from "@hiero-ledger/sdk";
import { encodeFunctionData } from "viem";
import { escrowAbi } from "@byline-work/shared";
import { config } from "./config";
import { hederaClient, requireEscrow, requireRole } from "./chain";
import { get, run, type Db } from "./db";

export async function scheduleRelease(db: Db, taskId: bigint, expirySec: number): Promise<string | null> {
  if (config.escrow.scheduling !== "sdk") return null;
  requireEscrow();
  const existing = get<{ schedule_id: string | null }>(db, "SELECT schedule_id FROM tasks WHERE task_id = ?", Number(taskId));
  if (existing?.schedule_id) return existing.schedule_id;
  const backend = requireRole("backend");
  const data = encodeFunctionData({ abi: escrowAbi, functionName: "releaseIfDue", args: [taskId] });
  const inner = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(config.escrow.contractId))
    .setGas(750_000)
    .setFunctionParameters(Buffer.from(data.slice(2), "hex"));
  const when = Math.max(expirySec, Math.floor(Date.now() / 1000) + 5);
  const tx = await new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setWaitForExpiry(true)
    .setExpirationTime(Timestamp.fromDate(new Date(when * 1000)))
    .setScheduleMemo(`byline-work release ${taskId}`)
    .execute(hederaClient(backend.accountId, backend.privateKey));
  const client = hederaClient(backend.accountId, backend.privateKey);
  const receipt = await tx.getReceipt(client);
  const scheduleId = receipt.scheduleId?.toString() ?? "";
  if (scheduleId) {
    run(db, "UPDATE tasks SET schedule_id = ?, updated_at = ? WHERE task_id = ?", scheduleId, Date.now(), Number(taskId));
  }
  return scheduleId || null;
}
