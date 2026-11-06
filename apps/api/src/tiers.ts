/**
 * SCR-05. Raises a worker's in-flight cap on the escrow as their Contributor Score rises.
 * Banned workers are skipped: registerWorker also sets active = true, so re-registering one
 * would undo a fraud suspension.
 */
import { inFlightCapForScore } from "@byline-work/shared";
import { config } from "./config";
import { all, chainEvm, metaGet, metaSet, type Db, type WorkerRow } from "./db";
import { registerWorker } from "./escrow";
import { publicScores } from "./routes";
import type { Hex } from "viem";

export async function tierTick(db: Db): Promise<number> {
  if (!config.escrow.contractId || !config.roles.backend.privateKey) return 0;
  const base = config.caps.inFlightNew;
  const scores = publicScores(db);
  const workers = all<WorkerRow>(db, "SELECT * FROM workers WHERE banned_at IS NULL AND evm_address IS NOT NULL");
  let changed = 0;
  for (const w of workers) {
    const chain = chainEvm(w);
    if (!chain || !w.evm_address) continue;
    const row = scores.find((s) => s.worker.toLowerCase() === chain.toLowerCase());
    const want = inFlightCapForScore(row?.score ?? 0, base);
    const key = `tier_cap:${chain.toLowerCase()}`;
    if (want === Number(metaGet(db, key) ?? base)) continue;
    await registerWorker(chain as Hex, w.evm_address as Hex, want);
    metaSet(db, key, String(want));
    changed += 1;
  }
  return changed;
}
