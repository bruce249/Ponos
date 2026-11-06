/**
 * x402 resource server for bUSD data. Prices are tinybars. The payee is the operator.
 * Unpaid calls get 402. The handler signs the body (EIP-191) and anchors kind "feed" when HCS is configured.
 */
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  toFacilitatorHederaSigner,
} from "@x402/hedera";
import { ExactHederaScheme as ExactHederaServer } from "@x402/hedera/exact/server";
import { ExactHederaScheme as ExactHederaFacilitator } from "@x402/hedera/exact/facilitator";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { canonicalFeed, feedMessage, HBAR_ASSET, hashFeedBody, type FeedKind } from "@byline-work/shared";
import { parseHederaKey } from "@byline-work/shared";
import { config, ready } from "../config";
import type { Db } from "../db";
import { all, get, metaGet, run } from "../db";
import { mirrorGet } from "../chain";
import { submitHcs } from "../hcs";

class LocalFacilitatorClient implements FacilitatorClient {
  constructor(private readonly f: x402Facilitator) {}
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.f.verify(p, r);
  }
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.f.settle(p, r);
  }
  async getSupported(): Promise<SupportedResponse> {
    return this.f.getSupported() as SupportedResponse;
  }
}

function facilitatorClient(): FacilitatorClient {
  const url = config.hedera.facilitatorUrl;
  if (url !== "local") return new HTTPFacilitatorClient({ url });
  const { operatorAccountId, operatorPrivateKey } = config.hedera;
  if (!operatorAccountId || !operatorPrivateKey) throw new Error("X402_FACILITATOR_URL=local needs OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY");
  const signer = toFacilitatorHederaSigner({
    getAddresses: () => [operatorAccountId],
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction((network) => createHederaClient(network), parseHederaKey(operatorPrivateKey)),
    verifyPayerSignature: createHederaVerifyPayerSignature(),
    preflightTransfer: createHederaPreflightTransfer(),
  });
  const f = new x402Facilitator().register(config.hedera.network, new ExactHederaFacilitator(signer));
  return new LocalFacilitatorClient(f);
}

async function supplyOf(): Promise<bigint> {
  const data = (await mirrorGet(`/api/v1/tokens/${config.token.id}`)) as { total_supply?: string | number };
  return BigInt(data.total_supply ?? 0);
}

function reserveOf(db: Db): { amount: bigint; tx: string | null } {
  return { amount: BigInt(metaGet(db, "busd_reserve") ?? "0"), tx: metaGet(db, "busd_reserve_tx") ?? null };
}

/** NAV with 6 decimal places, integer division. Null when supply is zero. */
export function navRatio(reserve: bigint, supply: bigint): string | null {
  if (supply === 0n) return null;
  const scaled = (reserve * 1_000_000n) / supply;
  const whole = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function reserveView(db: Db) {
  const supply = await supplyOf();
  const reserve = reserveOf(db);
  const ratio = navRatio(reserve.amount, supply);
  return {
    feed: "reserve" as const,
    token: config.token.id,
    supply: supply.toString(),
    reserve: reserve.amount.toString(),
    ratio,
    lastUpdateTx: reserve.tx,
    ts: Math.floor(Date.now() / 1000),
  };
}

export async function navView(db: Db) {
  const supply = await supplyOf();
  const reserve = reserveOf(db);
  const nav = navRatio(reserve.amount, supply) ?? "0";
  run(db, "INSERT INTO nav_history (nav, supply, reserve, tx, created_at) VALUES (?, ?, ?, ?, ?)", nav, supply.toString(), reserve.amount.toString(), reserve.tx, Date.now());
  const history = all<{ nav: string; supply: string; reserve: string; tx: string | null; created_at: number }>(
    db,
    "SELECT nav, supply, reserve, tx, created_at FROM nav_history ORDER BY id DESC LIMIT 20",
  );
  return { feed: "nav" as const, nav, supply: supply.toString(), reserve: reserve.amount.toString(), history, ts: Math.floor(Date.now() / 1000) };
}

/** Mirror-node consensus timestamp "1700000000.123456789" -> seconds. */
function consensusSec(ts: string | null): number | null {
  if (!ts) return null;
  const n = Number(ts.split(".")[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Lower median. Null for an empty list. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Seconds from the first on-chain submit to the release, per released task, from
 * consensus timestamps. `batchFilter` limits it to one client's batches.
 */
function secondsToPay(db: Db, batchIds?: string[]): number[] {
  const where = batchIds ? `AND batch_id IN (${batchIds.map(() => "?").join(",") || "NULL"})` : "";
  const rows = all<{ task_id: number; name: string; consensus_ts: string | null }>(
    db,
    `SELECT task_id, name, consensus_ts FROM task_events WHERE name IN ('TaskSubmitted','TaskReleased') AND task_id IS NOT NULL ${where} ORDER BY consensus_ts ASC`,
    ...(batchIds ?? []),
  );
  const firstSubmit = new Map<number, number>();
  const out: number[] = [];
  for (const r of rows) {
    const at = consensusSec(r.consensus_ts);
    if (at === null) continue;
    if (r.name === "TaskSubmitted" && !firstSubmit.has(r.task_id)) firstSubmit.set(r.task_id, at);
    if (r.name === "TaskReleased") {
      const start = firstSubmit.get(r.task_id);
      if (start !== undefined && at >= start) out.push(at - start);
    }
  }
  return out;
}

export function statsView(db: Db) {
  const byState = all<{ state: string; n: number }>(db, "SELECT state, COUNT(*) AS n FROM tasks GROUP BY state");
  const locked = all<{ pay_per_task: string; unclaimed: number }>(db, "SELECT pay_per_task, unclaimed FROM batches");
  let value = 0n;
  for (const b of locked) value += BigInt(b.pay_per_task) * BigInt(b.unclaimed);
  const open = all<{ pay_base: string | null }>(db, "SELECT pay_base FROM tasks WHERE state NOT IN ('Released','Refunded','Resolved','Expired')");
  for (const t of open) if (t.pay_base) value += BigInt(t.pay_base);
  const released = all<{ path: string | null }>(db, "SELECT path FROM tasks WHERE state = 'Released'");
  const auto = released.filter((t) => t.path === "timeout" || t.path === "instant" || t.path === "dispute_timeout").length;
  const submitted = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM task_events WHERE name = 'TaskSubmitted'")?.n ?? 0;
  const disputed = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM task_events WHERE name IN ('TaskHeld','TaskDisputed')")?.n ?? 0;
  return {
    feed: "stats" as const,
    valueLocked: value.toString(),
    tasksByState: Object.fromEntries(byState.map((r) => [r.state, r.n])),
    medianSecondsToPay: median(secondsToPay(db)),
    autoReleaseShare: released.length ? auto / released.length : 0,
    disputeRate: submitted ? disputed / submitted : 0,
    ts: Math.floor(Date.now() / 1000),
  };
}

/**
 * One lab's record, for freelancers deciding which batches to take: funding history,
 * time to pay, how often the lab holds, and how disputes ended. `client` is a Hedera
 * account id or the lab's EVM address.
 */
export function clientStatsView(db: Db, client: string) {
  const batches = all<{ id: string; pay_per_task: string; task_count: number; created_at: number }>(
    db,
    "SELECT id, pay_per_task, task_count, created_at FROM batches WHERE client_account_id = ? OR lower(client_evm) = lower(?) ORDER BY created_at ASC",
    client, client,
  );
  const ids = batches.map((b) => b.id);
  let funded = 0n;
  for (const b of batches) funded += BigInt(b.pay_per_task) * BigInt(b.task_count);
  const count = (names: string) =>
    ids.length
      ? get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM task_events WHERE name IN (${names}) AND batch_id IN (${ids.map(() => "?").join(",")})`, ...ids)?.n ?? 0
      : 0;
  const submitted = count("'TaskSubmitted'");
  const holds = count("'TaskHeld'");
  const resolved = ids.length
    ? all<{ payload: string }>(db, `SELECT payload FROM task_events WHERE name = 'TaskResolved' AND batch_id IN (${ids.map(() => "?").join(",")})`, ...ids)
    : [];
  const workerLost = resolved.filter((r) => (JSON.parse(r.payload) as { workerBps?: string }).workerBps === "0").length;
  return {
    feed: "client" as const,
    client,
    batches: batches.length,
    tasksFunded: batches.reduce((n, b) => n + b.task_count, 0),
    fundedBase: funded.toString(),
    firstFundedAt: batches[0] ? Math.floor(batches[0].created_at / 1000) : null,
    medianSecondsToPay: median(secondsToPay(db, ids)),
    holdRate: submitted ? holds / submitted : 0,
    disputesResolved: resolved.length,
    disputesWorkerLost: workerLost,
    ts: Math.floor(Date.now() / 1000),
  };
}

export async function signFeedBody(feed: FeedKind, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config.feedSigner) throw new Error("FEED_SIGNER_KEY not set");
  const ts = typeof body.ts === "number" ? body.ts : Math.floor(Date.now() / 1000);
  const statement = { feed, bodyHash: hashFeedBody(body), ts };
  const signature = await config.feedSigner.signMessage({ message: canonicalFeed(statement) });
  let hcsSequence: number | null = null;
  let hcsTopic: string | null = null;
  if (ready.hcs()) {
    const anchored = await submitHcs(feedMessage({ feed, hash: statement.bodyHash, pair: typeof body.pair === "string" ? body.pair : undefined, ts }));
    hcsSequence = anchored.sequence;
    hcsTopic = anchored.topicId;
  }
  return { ...body, signature, signer: config.feedSigner.address, canonical: canonicalFeed(statement), hcsSequence, hcsTopic };
}

export function createX402(db: Db) {
  const network = config.hedera.network;
  const payTo = config.hedera.operatorAccountId;
  const resourceServer = new x402ResourceServer(facilitatorClient()).register(network, new ExactHederaServer());
  const price = (path: string) => ({
    asset: HBAR_ASSET,
    amount: (path.endsWith("/stats") ? config.prices.statsTinybar : config.prices.dataTinybar).toString(),
  });
  const routes = {
    "GET /x402/busd/reserve": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/busd/reserve"), maxTimeoutSeconds: 120 },
      description: "bUSD supply, reserve, ratio, and the last reserve update.",
      mimeType: "application/json",
    },
    "GET /x402/busd/nav": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/busd/nav"), maxTimeoutSeconds: 120 },
      description: "bUSD net asset value (reserve / supply) and recent history.",
      mimeType: "application/json",
    },
    "GET /x402/fx/:pair": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/fx"), maxTimeoutSeconds: 120 },
      description: "Public FX rate. USD-INR, USD-PHP, USD-NGN.",
      mimeType: "application/json",
    },
    "GET /x402/escrow/stats": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/escrow/stats"), maxTimeoutSeconds: 120 },
      description: "Escrow value locked, task states, median time to pay, auto-release share, dispute rate.",
      mimeType: "application/json",
    },
    "GET /x402/client/:id/stats": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/escrow/stats"), maxTimeoutSeconds: 120 },
      description: "One lab's funding history, median time to pay, hold rate and dispute outcomes.",
      mimeType: "application/json",
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  return { middleware: paymentMiddlewareFromHTTPServer(httpServer), db };
}
