/**
 * Contributor Score from the public HCS topic only. No database.
 *   npm run score
 */
import { busdFromBase, scoresFromEvents, type PublicTaskEvent } from "@byline-work/shared";
import { readTopic } from "../apps/api/src/hcs";
import { die, need } from "./lib";

need("HCS_TOPIC_ID");
const now = Math.floor(Date.now() / 1000);
let messages;
try {
  messages = await readTopic(500);
} catch (e: unknown) {
  die(`mirror node read failed: ${e instanceof Error ? e.message : e}`);
}
const events: PublicTaskEvent[] = [];
for (const m of messages) {
  if (m.kind !== "task" || !m.worker) continue;
  const amount = "amount" in m && m.amount ? BigInt(m.amount) : 0n;
  const ageDays = Math.max(0, (now - m.ts) / 86_400);
  events.push({
    worker: m.worker,
    event: m.event,
    valueBusd: m.event === "released" || m.event === "resolved" ? busdFromBase(amount) : undefined,
    ageDays,
    disputeLost: m.event === "resolved" && m.workerBps === 0,
  });
}
const rows = scoresFromEvents(events);
if (!rows.length) console.log("No task messages on the topic yet.");
for (const row of rows) {
  console.log(`${row.score.toFixed(2).padStart(8)}  ${row.worker}  passes ${row.passes}/${row.submissions}  on-time ${row.onTimeSubmits}/${row.claimed}  disputes lost ${row.disputesLost}  volume ${row.volume.toFixed(2)} bUSD`);
}
