/**
 * HCS v3 messages. Three kinds: task, feed, receipt.
 * A message must fit in 1024 bytes. A World ID `sub` is never a field, at any depth.
 */
import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const HCS_VERSION = 3 as const;
export const HCS_MAX_BYTES = 1024;

export const TASK_EVENTS = [
  "funded",
  "claimed",
  "expired",
  "submitted",
  "qa_pass",
  "qa_fail",
  "approved",
  "held",
  "disputed",
  "released",
  "refunded",
  "resolved",
  "withdrawn",
  "fraud",
] as const;

export type TaskEventName = (typeof TASK_EVENTS)[number];

export const RELEASE_PATHS = ["instant", "approved", "timeout", "dispute_timeout"] as const;
export type ReleasePath = (typeof RELEASE_PATHS)[number];

/** Keys that would publish a World ID subject. Rejected anywhere in the tree. */
const FORBIDDEN_KEYS = new Set(["sub", "worldsub", "world_sub", "worldiss", "world_iss"]);

export type TaskMessage = {
  v: 3;
  kind: "task";
  event: TaskEventName;
  batchId?: string;
  taskId?: number;
  /** Hedera account id or EVM address. Never a World ID subject. */
  worker?: string;
  client?: string;
  /** Base units, decimal string. */
  amount?: string;
  token?: string;
  workHash?: string;
  reportHash?: string;
  reasonHash?: string;
  path?: ReleasePath;
  tx?: string;
  scheduleId?: string;
  workerBps?: number;
  ts: number;
};

export type FeedMessage = {
  v: 3;
  kind: "feed";
  feed: "reserve" | "nav" | "fx" | "stats";
  hash: string;
  pair?: string;
  tx?: string;
  ts: number;
};

export type ReceiptMessage = {
  v: 3;
  kind: "receipt";
  batchId: string;
  taskHashes?: string[];
  /** keccak256 of the hash list, used when the full list would exceed 1024 bytes. */
  hashesRoot?: string;
  verifiedHumans: number;
  totalPaid: string;
  termsHash: string;
  ts: number;
};

export type HcsMessage = TaskMessage | FeedMessage | ReceiptMessage;

export class HcsSchemaError extends Error {}

function walkForbidden(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkForbidden(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
        throw new HcsSchemaError(`World ID subject is not allowed on HCS (${path}.${k})`);
      }
      walkForbidden(v, `${path}.${k}`);
    }
  }
}

export function assertNoWorldSub(value: unknown): void {
  walkForbidden(value, "$");
}

export function messageBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertHcsSize(value: unknown): void {
  const n = messageBytes(value);
  if (n > HCS_MAX_BYTES) throw new HcsSchemaError(`HCS message is ${n} bytes (limit ${HCS_MAX_BYTES})`);
}

function isHex32(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}

function isAccountOrAddress(v: unknown): v is string {
  return typeof v === "string" && (/^0\.0\.\d+$/.test(v) || /^0x[0-9a-fA-F]{40}$/.test(v));
}

/** Validates and returns the message. Throws HcsSchemaError on a World sub, a bad shape, or oversize. */
export function parseHcsMessage(input: unknown): HcsMessage {
  assertNoWorldSub(input);
  if (!input || typeof input !== "object") throw new HcsSchemaError("message is not an object");
  const m = input as Record<string, unknown>;
  if (m.v !== 3) throw new HcsSchemaError("v must be 3");
  if (m.kind === "task") parseTask(m);
  else if (m.kind === "feed") parseFeed(m);
  else if (m.kind === "receipt") parseReceipt(m);
  else throw new HcsSchemaError("kind must be task, feed, or receipt");
  assertHcsSize(input);
  return input as HcsMessage;
}

function parseTask(m: Record<string, unknown>): void {
  if (typeof m.event !== "string" || !(TASK_EVENTS as readonly string[]).includes(m.event)) {
    throw new HcsSchemaError("unknown task event");
  }
  if (typeof m.ts !== "number") throw new HcsSchemaError("ts required");
  if (m.worker !== undefined && !isAccountOrAddress(m.worker)) throw new HcsSchemaError("worker must be an account id or EVM address");
  if (m.client !== undefined && !isAccountOrAddress(m.client)) throw new HcsSchemaError("client must be an account id or EVM address");
  if (m.batchId !== undefined && !isHex32(m.batchId)) throw new HcsSchemaError("batchId must be bytes32");
  if (m.path !== undefined && !(RELEASE_PATHS as readonly string[]).includes(m.path as string)) throw new HcsSchemaError("unknown path");
  if (m.amount !== undefined && (typeof m.amount !== "string" || !/^\d+$/.test(m.amount))) throw new HcsSchemaError("amount must be a base-unit string");
}

function parseFeed(m: Record<string, unknown>): void {
  if (m.feed !== "reserve" && m.feed !== "nav" && m.feed !== "fx" && m.feed !== "stats") throw new HcsSchemaError("unknown feed");
  if (typeof m.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.hash)) throw new HcsSchemaError("feed hash required");
  if (typeof m.ts !== "number") throw new HcsSchemaError("ts required");
}

function parseReceipt(m: Record<string, unknown>): void {
  if (!isHex32(m.batchId)) throw new HcsSchemaError("receipt batchId required");
  if (typeof m.verifiedHumans !== "number") throw new HcsSchemaError("verifiedHumans required");
  if (typeof m.totalPaid !== "string") throw new HcsSchemaError("totalPaid required");
  if (!isHex32(m.termsHash)) throw new HcsSchemaError("termsHash required");
  if (typeof m.ts !== "number") throw new HcsSchemaError("ts required");
  if (m.taskHashes !== undefined && !Array.isArray(m.taskHashes)) throw new HcsSchemaError("taskHashes must be an array");
}

/** Build a task message, dropping undefined fields so the JSON stays small. */
export function taskMessage(fields: Omit<TaskMessage, "v" | "kind">): TaskMessage {
  const msg: TaskMessage = { v: 3, kind: "task", event: fields.event, ts: fields.ts };
  const copy = { ...fields } as Record<string, unknown>;
  for (const k of Object.keys(copy)) {
    if (copy[k] === undefined || copy[k] === "") delete copy[k];
  }
  const full = { v: 3, kind: "task" as const, ...copy } as TaskMessage;
  return parseHcsMessage(full) as TaskMessage;
}

export function feedMessage(fields: Omit<FeedMessage, "v" | "kind">): FeedMessage {
  return parseHcsMessage({ v: 3, kind: "feed", ...fields }) as FeedMessage;
}

export function receiptMessage(fields: Omit<ReceiptMessage, "v" | "kind">): ReceiptMessage {
  const full = { v: 3 as const, kind: "receipt" as const, ...fields };
  try {
    return parseHcsMessage(full) as ReceiptMessage;
  } catch (e) {
    if (e instanceof HcsSchemaError && /1024/.test(e.message) && fields.taskHashes) {
      const root = keccak256(encodeAbiParameters(parseAbiParameters("bytes32[]"), [fields.taskHashes as Hex[]]));
      const { taskHashes: _drop, ...rest } = fields;
      return parseHcsMessage({ v: 3, kind: "receipt", ...rest, hashesRoot: root }) as ReceiptMessage;
    }
    throw e;
  }
}
