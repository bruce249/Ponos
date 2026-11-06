/**
 * EscrowVault calls. The relayer (BACKEND) sends claimFor, submitFor, resubmitFor
 * and disputeFor. Direct claim stays in the contract for pay <= 100 bUSD; this
 * server always uses the relayer so a freelancer needs no HBAR.
 */
import { erc20Abi, escrowAbi, platformFee, type Hex } from "@byline-work/shared";
import { config } from "./config";
import { executeContract, NotConfigured, requireEscrow, requireRole } from "./chain";

function escrowId(): string {
  requireEscrow();
  return config.escrow.contractId;
}

function asBig(n: bigint | number): bigint {
  return typeof n === "bigint" ? n : BigInt(n);
}

export async function approveBusd(owner: { accountId: string; privateKey: string }, spender: Hex, amount: bigint) {
  if (!config.token.id) throw new NotConfigured("bUSD", ["BUSD_TOKEN_ID"]);
  return executeContract({
    ...owner,
    contractId: config.token.id,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
    gas: 400_000,
  });
}

export async function transferBusd(owner: { accountId: string; privateKey: string }, to: Hex, amount: bigint) {
  if (!config.token.id) throw new NotConfigured("bUSD", ["BUSD_TOKEN_ID"]);
  return executeContract({
    ...owner,
    contractId: config.token.id,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
    gas: 400_000,
  });
}

export async function fundBatch(opts: {
  batchId: Hex;
  taskCount: number;
  payPerTask: bigint;
  reviewWindow: number;
  workWindow: number;
  revisionWindow: number;
}) {
  const lab = requireRole("lab");
  const unit = opts.payPerTask + platformFee(opts.payPerTask, config.escrow.feeBps);
  const total = unit * BigInt(opts.taskCount);
  if (!config.escrow.address) throw new NotConfigured("escrow", ["ESCROW_ADDRESS"]);
  const approval = await approveBusd(lab, config.escrow.address as Hex, total);
  const funded = await executeContract({
    ...lab,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "fundBatch",
    args: [opts.batchId, opts.taskCount, opts.payPerTask, opts.reviewWindow, opts.workWindow, opts.revisionWindow],
    gas: 800_000,
  });
  return { approvalTx: approval.txId, txId: funded.txId, total };
}

export async function registerWorker(worker: Hex, payout: Hex, inFlightCap: number) {
  const backend = requireRole("backend");
  return executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "registerWorker",
    args: [worker, payout, inFlightCap],
    gas: 300_000,
  });
}

export async function setWorkerStatus(worker: Hex, active: boolean) {
  const backend = requireRole("backend");
  return executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "setWorkerStatus",
    args: [worker, active],
    gas: 200_000,
  });
}

export async function setWorkerPayout(worker: Hex, payout: Hex) {
  const backend = requireRole("backend");
  return executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "setWorkerPayout",
    args: [worker, payout],
    gas: 200_000,
  });
}

export async function claimFor(batchId: Hex, worker: Hex): Promise<{ txId: string; taskId: bigint }> {
  const backend = requireRole("backend");
  const res = await executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "claimFor",
    args: [batchId, worker],
    gas: 500_000,
  });
  const taskId = asBig(res.result as bigint | number);
  return { txId: res.txId, taskId };
}

export async function submitFor(taskId: bigint, workHash: Hex) {
  const backend = requireRole("backend");
  return executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "submitFor",
    args: [taskId, workHash],
    gas: 2_000_000,
  });
}

export async function resubmitFor(taskId: bigint, workHash: Hex) {
  const backend = requireRole("backend");
  return executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "resubmitFor",
    args: [taskId, workHash],
    gas: 2_000_000,
  });
}

export async function disputeFor(taskId: bigint, reasonHash: Hex) {
  const backend = requireRole("backend");
  return executeContract({
    ...backend,
    contractId: escrowId(),
    abi: escrowAbi,
    functionName: "disputeFor",
    args: [taskId, reasonHash],
    gas: 400_000,
  });
}

export async function qaPass(taskId: bigint, reportHash: Hex) {
  const qa = requireRole("qaOracle");
  return executeContract({ ...qa, contractId: escrowId(), abi: escrowAbi, functionName: "qaPass", args: [taskId, reportHash], gas: 800_000 });
}

export async function qaFail(taskId: bigint, reasonHash: Hex) {
  const qa = requireRole("qaOracle");
  return executeContract({ ...qa, contractId: escrowId(), abi: escrowAbi, functionName: "qaFail", args: [taskId, reasonHash], gas: 400_000 });
}

export async function approveTask(taskId: bigint) {
  const reviewer = requireRole("reviewer");
  return executeContract({ ...reviewer, contractId: escrowId(), abi: escrowAbi, functionName: "approve", args: [taskId], gas: 800_000 });
}

export async function holdTask(taskId: bigint, reasonHash: Hex) {
  const reviewer = requireRole("reviewer");
  return executeContract({ ...reviewer, contractId: escrowId(), abi: escrowAbi, functionName: "hold", args: [taskId, reasonHash], gas: 400_000 });
}

export async function resolveTask(taskId: bigint, workerBps: number) {
  const reviewer = requireRole("reviewer");
  return executeContract({ ...reviewer, contractId: escrowId(), abi: escrowAbi, functionName: "resolve", args: [taskId, workerBps], gas: 800_000 });
}

export async function expireClaim(taskId: bigint) {
  const backend = requireRole("backend");
  return executeContract({ ...backend, contractId: escrowId(), abi: escrowAbi, functionName: "expireClaim", args: [taskId], gas: 300_000 });
}

export async function releaseTask(taskId: bigint) {
  const backend = requireRole("backend");
  return executeContract({ ...backend, contractId: escrowId(), abi: escrowAbi, functionName: "release", args: [taskId], gas: 800_000 });
}

export async function refundTask(taskId: bigint) {
  const backend = requireRole("backend");
  return executeContract({ ...backend, contractId: escrowId(), abi: escrowAbi, functionName: "refund", args: [taskId], gas: 500_000 });
}

export async function associateEscrowToken() {
  const admin = requireRole("escrowAdmin");
  return executeContract({ ...admin, contractId: escrowId(), abi: escrowAbi, functionName: "associateToken", args: [], gas: 800_000 });
}

export async function grantRole(role: Hex, account: Hex) {
  const admin = requireRole("escrowAdmin");
  return executeContract({ ...admin, contractId: escrowId(), abi: escrowAbi, functionName: "grantRole", args: [role, account], gas: 200_000 });
}
