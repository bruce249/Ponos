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
import { clientStats, escrowStats } from "./stats";

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

function reserveFromMeta(db: Db): { amount: bigint; tx: string | null } {
  return { amount: BigInt(metaGet(db, "busd_reserve") ?? "0"), tx: metaGet(db, "busd_reserve_tx") ?? null };
}

/** "0.0.N" or "0x…" to the EVM address the JSON-RPC relay accepts. */
function evmOf(id: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) return id;
  const m = /^0\.0\.(\d+)$/.exec(id);
  return m ? `0x${BigInt(m[1]!).toString(16).padStart(40, "0")}` : null;
}

let chainReserve: { at: number; amount: bigint } | null = null;

/**
 * The Stablecoin Studio reserve is a Chainlink-style feed: latestRoundData().answer at decimals().
 * Read it on-chain so every server shows the real reserve, not only the one that ran a deposit.
 * Cached 30 s. Returns null when the address is unset or the relay fails.
 */
async function reserveOnChain(): Promise<bigint | null> {
  if (chainReserve && Date.now() - chainReserve.at < 30_000) return chainReserve.amount;
  const to = evmOf(config.token.reserve);
  if (!to) return null;
  const call = async (data: string) => {
    const res = await fetch(config.hedera.jsonRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: string };
    if (!body.result || body.result === "0x") throw new Error("empty eth_call result");
    return body.result.slice(2);
  };
  try {
    const decimals = Number(BigInt(`0x${await call("0x313ce567")}`));
    const round = await call("0xfeaf968c");
    const answer = BigInt(`0x${round.slice(64, 128)}`);
    const amount = decimals <= 6 ? answer * 10n ** BigInt(6 - decimals) : answer / 10n ** BigInt(decimals - 6);
    chainReserve = { at: Date.now(), amount };
    return amount;
  } catch {
    return null;
  }
}

async function reserveOf(db: Db): Promise<{ amount: bigint; tx: string | null }> {
  const meta = reserveFromMeta(db);
  const onChain = await reserveOnChain();
  return { amount: onChain ?? meta.amount, tx: meta.tx };
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
  const reserve = await reserveOf(db);
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
  const reserve = await reserveOf(db);
  const nav = navRatio(reserve.amount, supply) ?? "0";
  run(db, "INSERT INTO nav_history (nav, supply, reserve, tx, created_at) VALUES (?, ?, ?, ?, ?)", nav, supply.toString(), reserve.amount.toString(), reserve.tx, Date.now());
  const history = all<{ nav: string; supply: string; reserve: string; tx: string | null; created_at: number }>(
    db,
    "SELECT nav, supply, reserve, tx, created_at FROM nav_history ORDER BY id DESC LIMIT 20",
  );
  return { feed: "nav" as const, nav, supply: supply.toString(), reserve: reserve.amount.toString(), history, ts: Math.floor(Date.now() / 1000) };
}

export function statsView(db: Db) {
  return escrowStats(db);
}

export { clientStats };

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
    amount: (path.includes("/escrow/stats") ? config.prices.statsTinybar : config.prices.dataTinybar).toString(),
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
    "GET /x402/client/:id/stats": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/escrow/stats"), maxTimeoutSeconds: 120 },
      description: "A lab's funding history, median seconds to pay, share paid, and hold rate.",
      mimeType: "application/json",
    },
    "GET /x402/escrow/stats": {
      accepts: { scheme: "exact" as const, network, payTo, price: price("/x402/escrow/stats"), maxTimeoutSeconds: 120 },
      description: "Escrow value locked, task states, auto-release share, dispute rate.",
      mimeType: "application/json",
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  return { middleware: paymentMiddlewareFromHTTPServer(httpServer), db };
}
