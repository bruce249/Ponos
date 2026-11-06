/**
 * HTTP shapes the web app builds against. Money fields are base-unit strings.
 * A World ID `sub` is never in these types.
 */

export type QaMode = "auto" | "manual";

type TaskState =
  | "None"
  | "Claimed"
  | "Submitted"
  | "AwaitingApproval"
  | "Revising"
  | "Failed"
  | "Disputed"
  | "Released"
  | "Refunded"
  | "Resolved"
  | "Expired";

export type HashScanLinks = {
  tx?: string;
  account?: string;
  topic?: string;
  topicMessage?: string;
  contract?: string;
  schedule?: string;
  token?: string;
};

export type BatchTaskInput = {
  prompt: string;
  /** Gold answers, kept in the database. Never written on-chain or to HCS. */
  gold: Record<string, string>;
  /** Rubric checklist item ids. A pass requires every item true. */
  checklist: string[];
};

export type BatchCreateRequest = {
  title: string;
  qaMode: QaMode;
  /** Decimal bUSD, for example "40". */
  payPerTask: string;
  taskCount: number;
  reviewWindow: number;
  workWindow: number;
  revisionWindow: number;
  rubric: string[];
  tasks: BatchTaskInput[];
  /** Lab account id. Must be on the allowlist. The server holds the key (demo custody). */
  labAccountId: string;
};

export type BatchCreateResponse = {
  batchId: string;
  txId: string;
  totalBase: string;
  totalDecimal: string;
  custody: "demo";
  custodyNote: string;
  hashscan: HashScanLinks;
};

export type TaskFeedItem = {
  batchId: string;
  title: string;
  qaMode: QaMode;
  unclaimed: number;
  payBase: string;
  payDecimal: string;
  requiresStepUp: boolean;
  workWindow: number;
  reviewWindow: number;
};

export type WorkSubmission = {
  answers: Record<string, string>;
  /** checklist id -> worker marked it done */
  checklist: Record<string, boolean>;
  note?: string;
};

export type ClaimRequest = {
  batchId: string;
  /** Present when pay > 100 bUSD. Single-use World ID step-up for action claim_high. */
  approvalId?: string;
};

export type ClaimResponse = {
  taskId: string;
  txId: string;
  workDeadline: number;
  hashscan: HashScanLinks;
};

export type SubmitResponse = {
  taskId: string;
  workHash: string;
  txId: string;
  reviewDeadline: number | null;
  scheduleId: string | null;
  qa?: { pass: boolean; reportHash: string };
  hashscan: HashScanLinks;
};

export type TaskView = {
  taskId: string;
  batchId: string;
  title: string;
  state: TaskState | string;
  qaMode: QaMode;
  payBase: string;
  payDecimal: string;
  workerAccount: string | null;
  payout: string | null;
  workDeadline: number | null;
  reviewDeadline: number | null;
  actionDeadline: number | null;
  disputeDeadline: number | null;
  serverNow: number;
  /** Seconds until the next automatic money move. Null when nothing is scheduled by the clock. */
  secondsRemaining: number | null;
  countdownTarget: "work" | "review" | "revision" | "dispute" | null;
  workHash: string | null;
  scheduleId: string | null;
  failCount: number;
  hashscan: HashScanLinks;
};

export type ReviewQueueItem = TaskView & {
  reasonText: string | null;
};

export type HoldRequest = { reason: string };
export type ResolveRequest = { workerBps: number };

export type MeResponse = {
  workerId: string;
  kind: "world" | "demo";
  /** Set only for DEMO_MOCK_WORLD workers. Never a World ID. */
  label: string | null;
  worldId: boolean;
  accountId: string | null;
  evmAddress: string | null;
  banned: boolean;
};

export type PayoutBindRequest = {
  accountId: string;
  approvalId: string;
};

export type RedeemRequest = {
  /** Decimal bUSD. */
  amount: string;
  corridor: "USD-INR" | "USD-PHP" | "USD-NGN";
  dest: { name: string; account: string };
};

export type RedeemResponse = {
  simulated: true;
  text: "₹ credited (simulated)" | string;
  path: string[];
  transferTx: string | null;
  burnTx: string | null;
  quote: {
    rate: number;
    localAmount: string;
    currency: string;
    source: string;
    simulated: true;
  };
  hashscan: HashScanLinks;
};

export type FraudRequest = {
  workerId: string;
  accountId: string;
};

export type ConfigResponse = {
  network: string;
  escrow: string | null;
  token: string | null;
  topic: string | null;
  scheduling: "hip1215" | "sdk" | "keeper";
  hitlBase: string;
  demoMockWorld: boolean;
  custody: "demo";
  ready: {
    chain: boolean;
    hcs: boolean;
    world: boolean;
    feed: boolean;
    zg: boolean;
    x402: boolean;
  };
};
