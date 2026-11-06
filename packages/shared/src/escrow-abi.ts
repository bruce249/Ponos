/**
 * EscrowVault ABI, copied from contracts/src/EscrowVault.sol.
 * Keep in sync with the contract: packages/shared/test/abi.test.ts diffs this against contracts/out.
 * Event indexed flags match the contract so the indexer can decode mirror-node logs.
 */
import { parseAbi } from "viem";

export const escrowAbi = parseAbi([
  "error Paused()",
  "error UnknownBatch()",
  "error BatchExists()",
  "error BadWindow()",
  "error ZeroTasks()",
  "error ZeroPay()",
  "error WorkerInactive()",
  "error InFlightCap()",
  "error DirectClaimTooLarge()",
  "error NoPayout()",
  "error NoneLeft()",
  "error NotWorker()",
  "error BadState()",
  "error NotDue()",
  "error NotClient()",
  "error NotAdmin()",
  "error NotRole(bytes32 role)",
  "error TransferFailed()",
  "error ScheduleFailed(int64 rc)",
  "error ScheduleUnavailable()",
  "error BadBps()",
  "error Reentrancy()",
  "error ZeroAddress()",
  "error BadConfig()",
  "error MissingReason()",
  "error SameReviewer()",

  "event BatchFunded(bytes32 indexed batchId, address indexed client, uint32 taskCount, uint64 payPerTask, uint256 feePerTask, uint256 total, uint32 reviewWindow, uint32 workWindow, uint32 revisionWindow)",
  "event TaskClaimed(uint256 indexed taskId, bytes32 indexed batchId, address indexed worker, address payout, uint64 workDeadline, uint256 pay)",
  "event ClaimExpired(uint256 indexed taskId, bytes32 indexed batchId, address worker)",
  "event TaskSubmitted(uint256 indexed taskId, bytes32 indexed batchId, bytes32 workHash, uint64 reviewDeadline, address schedule, bool resubmitted)",
  "event QaPassed(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reportHash, bool awaitingApproval, uint256 pay)",
  "event QaFailed(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reasonHash, uint8 failCount, uint64 actionDeadline)",
  "event TaskApproved(uint256 indexed taskId, bytes32 indexed batchId)",
  "event TaskFirstApproval(uint256 indexed taskId, bytes32 indexed batchId, address reviewer)",
  "event TaskHeld(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reasonHash, uint64 disputeDeadline)",
  "event TaskDisputed(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reasonHash, uint64 disputeDeadline)",
  "event TaskReleased(uint256 indexed taskId, bytes32 indexed batchId, address payout, uint256 pay, uint256 fee, bytes32 path)",
  "event TaskRefunded(uint256 indexed taskId, bytes32 indexed batchId, address client, uint256 amount)",
  "event TaskResolved(uint256 indexed taskId, bytes32 indexed batchId, uint16 workerBps, uint256 workerAmount, uint256 clientAmount, uint256 feeAmount)",
  "event UnclaimedWithdrawn(bytes32 indexed batchId, address indexed client, uint32 count, uint256 amount)",
  "event WorkerRegistered(address indexed worker, address payout, uint32 inFlightCap)",
  "event WorkerStatusSet(address indexed worker, bool active)",
  "event WorkerPayoutSet(address indexed worker, address payout)",
  "event RoleGranted(bytes32 indexed role, address indexed account)",
  "event RoleRevoked(bytes32 indexed role, address indexed account)",
  "event PausedSet(bool paused)",
  "event HbarLow(uint256 balance)",
  "event ScheduleCapacityDeferred(uint256 indexed taskId, uint64 expiry)",
  "event TokenAssociated(uint256 responseCode)",

  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function setPaused(bool next)",
  "function setHbarLowWatermark(uint256 next)",
  "function transferAdmin(address next)",
  "function registerWorker(address worker, address payout, uint32 inFlightCap)",
  "function setWorkerStatus(address worker, bool active)",
  "function setWorkerPayout(address worker, address payout)",
  "function fundBatch(bytes32 batchId, uint32 taskCount, uint64 payPerTask, uint32 reviewWindow, uint32 workWindow, uint32 revisionWindow)",
  "function withdrawUnclaimed(bytes32 batchId, uint32 count)",
  "function claim(bytes32 batchId) returns (uint256 taskId)",
  "function claimFor(bytes32 batchId, address worker) returns (uint256 taskId)",
  "function expireClaim(uint256 taskId)",
  "function submit(uint256 taskId, bytes32 workHash)",
  "function submitFor(uint256 taskId, bytes32 workHash)",
  "function resubmit(uint256 taskId, bytes32 workHash)",
  "function resubmitFor(uint256 taskId, bytes32 workHash)",
  "function qaPass(uint256 taskId, bytes32 reportHash)",
  "function qaFail(uint256 taskId, bytes32 reasonHash)",
  "function approve(uint256 taskId)",
  "function hold(uint256 taskId, bytes32 reasonHash)",
  "function dispute(uint256 taskId, bytes32 reasonHash)",
  "function disputeFor(uint256 taskId, bytes32 reasonHash)",
  "function resolve(uint256 taskId, uint16 workerBps)",
  "function release(uint256 taskId)",
  "function releaseIfDue(uint256 taskId) returns (bool released)",
  "function refund(uint256 taskId)",
  "function associateToken()",

  "function token() view returns (address)",
  "function treasury() view returns (address)",
  "function qaPool() view returns (address)",
  "function hitlThreshold() view returns (uint64)",
  "function dualReviewThreshold() view returns (uint64)",
  "function firstApprover(uint256 taskId) view returns (address)",
  "function platformFeeBps() view returns (uint16)",
  "function qaPoolShareBps() view returns (uint16)",
  "function minWindow() view returns (uint32)",
  "function maxWindow() view returns (uint32)",
  "function disputeWindow() view returns (uint32)",
  "function schedulingEnabled() view returns (bool)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function hbarLowWatermark() view returns (uint256)",
  "function obligations() view returns (uint256)",
  "function taskSeq() view returns (uint256)",
  "function roles(address account, bytes32 role) view returns (bool)",
  "function batches(bytes32) view returns (address client, uint64 payPerTask, uint32 taskCount, uint32 unclaimed, uint32 reviewWindow, uint32 workWindow, uint32 revisionWindow, bool exists)",
  "function tasks(uint256) view returns (bytes32 batchId, uint8 state, address worker, address payout, uint64 workDeadline, uint64 reviewDeadline, uint64 actionDeadline, uint64 disputeDeadline, uint64 firstSubmittedAt, bytes32 workHash, bytes32 reportHash, bytes32 reasonHash, uint8 failCount, address schedule)",
  "function workers(address) view returns (bool registered, bool active, address payout, uint32 inFlight, uint32 inFlightCap)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** TaskState enum order in EscrowVault. */
export const TASK_STATE = [
  "None",
  "Claimed",
  "Submitted",
  "AwaitingApproval",
  "Revising",
  "Failed",
  "Disputed",
  "Released",
  "Refunded",
  "Resolved",
  "Expired",
] as const;

export type TaskStateName = (typeof TASK_STATE)[number];

export const TERMINAL_STATES = new Set<TaskStateName>(["Released", "Refunded", "Resolved", "Expired"]);

/** bytes32 path constants are the ASCII string, right-padded, as Solidity stores a short string. */
export function pathBytes32(path: "instant" | "approved" | "timeout" | "dispute_timeout"): `0x${string}` {
  const hex = Buffer.from(path, "utf8").toString("hex").padEnd(64, "0");
  return `0x${hex}`;
}

/** Decode a bytes32 short-string (right-padded with zeros) back to ASCII. */
export function bytes32ToAscii(value: string): string {
  const hex = value.toLowerCase().replace(/^0x/, "").replace(/(00)+$/, "");
  if (!hex) return "";
  return Buffer.from(hex, "hex").toString("utf8");
}
