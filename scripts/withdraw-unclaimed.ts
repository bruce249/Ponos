/**
 * The lab takes back tasks nobody has claimed (ESC-14). Claimed tasks cannot be touched.
 * Signed by LAB (the batch's client). Returns pay + fee for each task withdrawn.
 *
 *   npm run withdraw -- <batchId> all        every unclaimed task in that batch
 *   npm run withdraw -- <batchId> 3          three of them
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { baseToDecimal, escrowAbi } from "@byline-work/shared";
import { executeContract, mirrorBase, requireRole } from "../apps/api/src/chain";
import { config } from "../apps/api/src/config";
import { die, missing } from "./lib";

const [batchId, countArg] = process.argv.slice(2);
if (!batchId || !/^0x[0-9a-fA-F]{64}$/.test(batchId) || !countArg) die("usage: npm run withdraw -- <0x…batchId> <count|all>");
const absent = missing(["LAB_ACCOUNT_ID", "LAB_PRIVATE_KEY", "ESCROW_CONTRACT_ID", "ESCROW_ADDRESS"]);
if (absent.length) die(`withdraw is not configured. Missing: ${absent.join(", ")}`);

/** Read the batch from the chain, not the local database, which can hold rows for batches that never got funded. */
async function onChainBatch(id: Hex): Promise<{ client: string; payPerTask: bigint; unclaimed: number; exists: boolean }> {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: "batches", args: [id] });
  const res = await fetch(`${mirrorBase()}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block: "latest", to: config.escrow.address, data }),
  });
  const body = (await res.json()) as { result?: Hex; _status?: { messages?: { message: string }[] } };
  if (!body.result) die(`could not read the batch: ${body._status?.messages?.[0]?.message ?? res.status}`);
  const [client, payPerTask, , unclaimed, , , , exists] = decodeFunctionResult({ abi: escrowAbi, functionName: "batches", data: body.result });
  return { client, payPerTask, unclaimed, exists };
}

const batch = await onChainBatch(batchId as Hex);
if (!batch.exists) die("That batch is not on this escrow (it may have been created before a redeploy, or never funded).");
const count = countArg === "all" ? batch.unclaimed : Number(countArg);
if (!Number.isInteger(count) || count <= 0) die(`Nothing to withdraw: ${batch.unclaimed} unclaimed task(s) in this batch.`);
if (count > batch.unclaimed) die(`Only ${batch.unclaimed} unclaimed task(s) in this batch, asked for ${count}.`);

const lab = requireRole("lab");
const sent = await executeContract({ ...lab, contractId: config.escrow.contractId, abi: escrowAbi, functionName: "withdrawUnclaimed", args: [batchId as Hex, count], gas: 1_500_000 });
const fee = (batch.payPerTask * config.escrow.feeBps) / 10_000n;
console.log(`withdrew ${count} task(s) = ${baseToDecimal(BigInt(count) * (batch.payPerTask + fee))} bUSD back to the lab`);
console.log(`https://hashscan.io/testnet/transaction/${sent.txId}`);
process.exit(0);
