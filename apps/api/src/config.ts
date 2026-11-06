/**
 * The server boots with a partial environment. A feature whose keys are missing
 * answers 503 with the variable names, instead of crashing the process.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { HederaNetwork } from "@byline-work/shared";

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();

function bool(k: string, d: boolean): boolean {
  const v = env(k);
  if (!v) return d;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(k: string, d: number): number {
  const v = env(k);
  if (!v) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number, got ${v}`);
  return n;
}

const network = env("HEDERA_NETWORK", "hedera:testnet");
if (network !== "hedera:testnet" && network !== "hedera:mainnet") {
  throw new Error(`HEDERA_NETWORK must be hedera:testnet or hedera:mainnet, got ${network}`);
}

const scheduling = env("ESCROW_SCHEDULING", "hip1215");
if (scheduling !== "hip1215" && scheduling !== "sdk" && scheduling !== "keeper") {
  throw new Error(`ESCROW_SCHEDULING must be hip1215, sdk, or keeper, got ${scheduling}`);
}

/** Thresholds are whole bUSD in .env (100). A value that is already base units (>= 1e6) is kept. */
export function busdThresholdBase(name: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer, got ${raw}`);
  const n = BigInt(raw);
  return n >= 1_000_000n ? n : n * 1_000_000n;
}

function pair(prefix: string): { accountId: string; privateKey: string } {
  return { accountId: env(`${prefix}_ACCOUNT_ID`), privateKey: env(`${prefix}_PRIVATE_KEY`) };
}

function csv(k: string): string[] {
  return env(k).split(",").map((s) => s.trim()).filter(Boolean);
}

const feedKey = env("FEED_SIGNER_KEY") as Hex;

export const config = {
  port: num("PORT", 8787),
  apiPublicUrl: env("API_PUBLIC_URL", "http://localhost:8787").replace(/\/+$/, ""),
  webOrigin: env("WEB_ORIGIN", "http://localhost:3000").replace(/\/+$/, ""),
  dbPath: env("DB_PATH", "data/byline-work.db"),
  sessionSecure: bool("SESSION_SECURE", false),
  demoMockWorld: bool("DEMO_MOCK_WORLD", false),

  hedera: {
    network: network as HederaNetwork,
    jsonRpc: env("HEDERA_JSON_RPC", "https://testnet.hashio.io/api"),
    operatorAccountId: env("OPERATOR_ACCOUNT_ID"),
    operatorPrivateKey: env("OPERATOR_PRIVATE_KEY"),
    topicId: env("HCS_TOPIC_ID"),
    facilitatorUrl: env("X402_FACILITATOR_URL", "https://api.testnet.blocky402.com"),
    agentAccountId: env("AGENT_ACCOUNT_ID"),
    agentPrivateKey: env("AGENT_PRIVATE_KEY"),
  },

  escrow: {
    contractId: env("ESCROW_CONTRACT_ID"),
    address: env("ESCROW_ADDRESS"),
    scheduling: scheduling as "hip1215" | "sdk" | "keeper",
    hitlBase: busdThresholdBase("HITL_THRESHOLD", env("HITL_THRESHOLD", "100")),
    /** Above this, approve needs two distinct reviewers on-chain. 0 turns the tier off. */
    dualReviewBase: busdThresholdBase("DUAL_REVIEW_THRESHOLD", env("DUAL_REVIEW_THRESHOLD", "1000")),
    feeBps: BigInt(env("PLATFORM_FEE_BPS", "300")),
    qaBps: BigInt(env("QA_POOL_SHARE_BPS", "3333")),
    minWindow: num("MIN_WINDOW_SEC", 120),
    maxWindow: num("MAX_WINDOW_SEC", 2_592_000),
    disputeWindow: num("DISPUTE_WINDOW_SEC", 600),
    keeperSec: num("KEEPER_INTERVAL_SEC", 15),
    indexerSec: num("INDEXER_INTERVAL_SEC", 3),
    hbarLowTinybar: BigInt(env("HBAR_LOW_TINYBAR", "500000000")),
  },

  token: {
    id: env("BUSD_TOKEN_ID"),
    proxy: env("BUSD_SCS_PROXY"),
    reserve: env("BUSD_RESERVE_ADDRESS"),
    evm: env("BUSD_TOKEN_EVM"),
  },

  prices: {
    dataTinybar: BigInt(env("PRICE_RESERVE_TINYBAR", "100000")),
    statsTinybar: BigInt(env("PRICE_STATS_TINYBAR", "500000")),
  },

  fx: {
    url: env("FX_API_URL", "https://open.er-api.com/v6/latest/USD"),
    source: "open.er-api.com public FX rates",
    pairs: ["USD-INR", "USD-PHP", "USD-NGN"] as const,
  },

  world: {
    issuer: env("WORLD_ISSUER", "https://auth.world.org"),
    clientId: env("WORLD_CLIENT_ID"),
    clientSecret: env("WORLD_CLIENT_SECRET"),
    redirectUri: env("WORLD_REDIRECT_URI", "http://localhost:3000/api/world/callback"),
    stepUpMaxAgeSec: num("WORLD_STEPUP_MAX_AGE_SEC", 120),
    approvalTtlSec: num("WORLD_APPROVAL_TTL_SEC", 120),
    requireAcr: bool("WORLD_REQUIRE_ACR", true),
    acrValues: env("WORLD_ACR_VALUES"),
  },

  zg: {
    baseUrl: env("ZG_BASE_URL", "https://router-api.0g.ai/v1"),
    apiKey: env("ZG_API_KEY"),
    model: env("ZG_MODEL", "0gm-1.0-35b-a3b"),
    trustMode: env("ZG_TRUST_MODE", "private") as "private" | "verified" | "standard",
    disableThinking: bool("ZG_DISABLE_THINKING", true),
  },

  caps: {
    dailyClaims: num("DAILY_CLAIM_CAP", 10),
    inFlightNew: num("IN_FLIGHT_CAP_NEW", 2),
  },

  roles: {
    operator: pair("OPERATOR"),
    scsAdmin: pair("SCS_ADMIN"),
    cashin: pair("CASHIN"),
    burn: pair("BURN"),
    compliance: pair("COMPLIANCE"),
    treasury: pair("TREASURY"),
    qaPool: pair("QA_POOL"),
    escrowAdmin: pair("ESCROW_ADMIN"),
    backend: pair("BACKEND"),
    qaOracle: pair("QA_ORACLE"),
    reviewer: pair("REVIEWER"),
    /** Optional second reviewer for the dual-review tier. */
    reviewerB: pair("REVIEWER_B"),
    lab: pair("LAB"),
    workerA: pair("WORKER_A"),
    workerB: pair("WORKER_B"),
    workerRented: pair("WORKER_RENTED"),
    agent: pair("AGENT"),
  },

  labAllow: csv("LAB_ALLOWLIST"),
  reviewerAllow: csv("REVIEWER_ALLOWLIST"),
  feedSigner: feedKey ? privateKeyToAccount(feedKey) : null,
};

export type RoleName = keyof typeof config.roles;

export function labAllowlist(): string[] {
  if (config.labAllow.length) return config.labAllow;
  return config.roles.lab.accountId ? [config.roles.lab.accountId] : [];
}

export function reviewerAllowlist(): string[] {
  if (config.reviewerAllow.length) return config.reviewerAllow;
  return [config.roles.reviewer.accountId, config.roles.reviewerB.accountId].filter(Boolean);
}

/** Role accounts a worker may never bind as a payout wallet, redeem from, or have frozen by the desk. */
export const PLATFORM_ROLES = ["operator", "scsAdmin", "cashin", "burn", "compliance", "treasury", "qaPool", "escrowAdmin", "backend", "qaOracle", "reviewer", "reviewerB", "lab", "agent"] as const;
/** Demo worker wallets whose keys the server holds (demo custody). */
export const WORKER_ROLES = ["workerA", "workerB", "workerRented"] as const;

export function isPlatformAccount(accountId: string): boolean {
  const id = accountId.trim();
  if (!id) return false;
  if (id === config.escrow.contractId || id === config.token.id) return true;
  return PLATFORM_ROLES.some((r) => config.roles[r].accountId === id);
}

/** Server-held key for a demo worker wallet. Never returns a platform role key. */
export function workerKeyFor(accountId: string): string | null {
  for (const r of WORKER_ROLES) {
    const role = config.roles[r];
    if (role.accountId && role.accountId === accountId && role.privateKey) return role.privateKey;
  }
  return null;
}

export const ready = {
  hcs: () => !!(config.hedera.operatorAccountId && config.hedera.operatorPrivateKey && config.hedera.topicId),
  world: () => !!(config.world.clientId && config.world.clientSecret),
  feed: () => !!config.feedSigner,
  zg: () => !!config.zg.apiKey,
  x402: () => !!(config.hedera.operatorAccountId && config.hedera.operatorPrivateKey && config.feedSigner && config.token.id),
  agent: () => !!(config.hedera.agentAccountId && config.hedera.agentPrivateKey),
  escrow: () => !!(config.escrow.contractId && config.roles.backend.accountId && config.roles.backend.privateKey),
  chain: () => !!(config.escrow.contractId && config.token.id),
};
