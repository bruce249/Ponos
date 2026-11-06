/**
 * Indexer (~3s), keeper (15s), auto-QA retry, score tiers (60s), and the agent that buys FX over x402
 * when its keys exist. All four are idempotent and safe to restart.
 */
import { createPayer } from "@byline-work/shared";
import { config, ready } from "./config";
import type { Db } from "./db";
import { indexerTick } from "./indexer";
import { keeperTick } from "./keeper";
import { qaTick } from "./qa/loop";
import { tierTick } from "./tiers";
import { isFxPair, rememberFx } from "./oracle/fx";

export function startLoops(db: Db) {
  const indexer = setInterval(() => {
    indexerTick(db).catch((e) => console.error("[indexer]", e instanceof Error ? e.message : e));
  }, config.escrow.indexerSec * 1000);
  const keeper = setInterval(() => {
    keeperTick(db).catch((e) => console.error("[keeper]", e instanceof Error ? e.message : e));
  }, config.escrow.keeperSec * 1000);
  const qa = setInterval(() => {
    qaTick(db).catch((e) => console.error("[qa]", e instanceof Error ? e.message : e));
  }, 10_000);
  const tiers = setInterval(() => {
    tierTick(db).catch((e) => console.error("[tiers]", e instanceof Error ? e.message : e));
  }, 60_000);
  let fx: ReturnType<typeof setInterval> | undefined;
  if (ready.agent() && ready.x402()) {
    const buy = () => buyFx(db).catch((e) => console.error("[fx]", e instanceof Error ? e.message : e));
    // Each purchase anchors a feed message on HCS. Every minute buried the task log under feed anchors.
    fx = setInterval(buy, Math.max(60, Number(process.env.FX_BUY_SEC || 600)) * 1000);
    setTimeout(buy, 2_000);
  } else {
    console.log("[fx] agent buyer idle (AGENT_ACCOUNT_ID / AGENT_PRIVATE_KEY or the x402 feed is not configured)");
  }
  indexerTick(db).catch((e) => console.error("[indexer]", e instanceof Error ? e.message : e));
  return () => {
    clearInterval(indexer);
    clearInterval(keeper);
    clearInterval(qa);
    clearInterval(tiers);
    if (fx) clearInterval(fx);
  };
}

async function buyFx(db: Db) {
  const payer = createPayer({
    accountId: config.hedera.agentAccountId,
    privateKey: config.hedera.agentPrivateKey,
    network: config.hedera.network,
    maxTinybar: config.prices.dataTinybar,
  });
  for (const pair of config.fx.pairs) {
    if (!isFxPair(pair)) continue;
    const paid = await payer.pay(
      `${config.apiPublicUrl}/x402/fx/${pair}`,
      { method: "GET", headers: { accept: "application/json" } },
      { payTo: config.hedera.operatorAccountId, maxTinybar: config.prices.dataTinybar },
    );
    const body = paid.body as { rate?: number; source?: string; ts?: number };
    if (typeof body.rate === "number" && body.source) {
      rememberFx(db, { pair, rate: body.rate, source: body.source, ts: body.ts ?? Math.floor(Date.now() / 1000), cached: false, txId: paid.txId }, paid.txId);
    }
  }
}
