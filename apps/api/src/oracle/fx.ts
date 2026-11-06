/**
 * Public FX rates for USD-INR, USD-PHP and USD-NGN.
 * Cached for 60 seconds. The source is labelled on every response.
 * The x402 buyer (when agent keys exist) refreshes this cache by paying for it.
 */
import { config } from "../config";
import { get, run, type Db } from "../db";

export type FxQuote = {
  pair: string;
  rate: number;
  source: string;
  ts: number;
  cached: boolean;
  txId: string | null;
};

const memory = new Map<string, { rate: number; source: string; at: number; txId: string | null }>();

export function isFxPair(pair: string): boolean {
  return (config.fx.pairs as readonly string[]).includes(pair);
}

export async function fetchPublicFx(pair: string): Promise<FxQuote> {
  if (!isFxPair(pair)) throw new Error(`unsupported FX pair ${pair}`);
  const hit = memory.get(pair);
  if (hit && Date.now() - hit.at < 60_000) {
    return { pair, rate: hit.rate, source: hit.source, ts: Math.floor(hit.at / 1000), cached: true, txId: hit.txId };
  }
  const code = pair.slice(4);
  const res = await fetch(config.fx.url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FX source ${res.status}`);
  const data = (await res.json()) as { rates?: Record<string, number>; time_last_update_unix?: number };
  const rate = data.rates?.[code];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error(`FX source has no ${code} rate`);
  const at = (data.time_last_update_unix ?? Math.floor(Date.now() / 1000)) * 1000;
  memory.set(pair, { rate, source: config.fx.source, at: Date.now(), txId: null });
  return { pair, rate, source: config.fx.source, ts: Math.floor(at / 1000), cached: false, txId: null };
}

export function rememberFx(db: Db, quote: FxQuote, txId: string | null) {
  memory.set(quote.pair, { rate: quote.rate, source: quote.source, at: Date.now(), txId });
  run(
    db,
    "INSERT INTO fx_cache (pair, rate, source, tx_id, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, source = excluded.source, tx_id = excluded.tx_id, fetched_at = excluded.fetched_at",
    quote.pair, String(quote.rate), quote.source, txId, Date.now(),
  );
}

export function cachedFx(db: Db, pair: string): FxQuote | null {
  const mem = memory.get(pair);
  if (mem && Date.now() - mem.at < 60_000) {
    return { pair, rate: mem.rate, source: mem.source, ts: Math.floor(mem.at / 1000), cached: true, txId: mem.txId };
  }
  const row = get<{ rate: string; source: string; tx_id: string | null; fetched_at: number }>(db, "SELECT rate, source, tx_id, fetched_at FROM fx_cache WHERE pair = ?", pair);
  if (!row) return null;
  if (Date.now() - row.fetched_at > 60_000) return { pair, rate: Number(row.rate), source: row.source, ts: Math.floor(row.fetched_at / 1000), cached: false, txId: row.tx_id };
  memory.set(pair, { rate: Number(row.rate), source: row.source, at: row.fetched_at, txId: row.tx_id });
  return { pair, rate: Number(row.rate), source: row.source, ts: Math.floor(row.fetched_at / 1000), cached: true, txId: row.tx_id };
}
