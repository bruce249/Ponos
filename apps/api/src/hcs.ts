/**
 * HCS task log. The operator key is the topic submit key. Messages are v3
 * and retried. A World `sub` cannot be passed through `submitHcs`: the schema rejects it.
 */
import { TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { MIRROR_NODE, parseHcsMessage, type HcsMessage, type HederaNetwork } from "@byline-work/shared";
import { config } from "./config";
import { hederaClient, NotConfigured } from "./chain";

export async function submitHcs(msg: HcsMessage): Promise<{ topicId: string; sequence: number; txId: string }> {
  const checked = parseHcsMessage(msg);
  if (!config.hedera.topicId || !config.hedera.operatorAccountId || !config.hedera.operatorPrivateKey) {
    throw new NotConfigured("hcs", ["HCS_TOPIC_ID", "OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY"].filter((k) => !process.env[k]));
  }
  const json = JSON.stringify(checked);
  const client = hederaClient(config.hedera.operatorAccountId, config.hedera.operatorPrivateKey);
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(config.hedera.topicId)).setMessage(json).execute(client);
      const receipt = await resp.getReceipt(client);
      return { topicId: config.hedera.topicId, sequence: Number(receipt.topicSequenceNumber?.toString() ?? "0"), txId: resp.transactionId.toString() };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export type TopicEntry = HcsMessage & { sequence: number; consensusTimestamp: string };

/**
 * Public mirror-node read. Drops anything that is not a v3 message.
 * `order: "asc"` pages from sequence 1 (the whole history, for recomputing scores). `"desc"` returns the newest
 * messages first; use it for anything that shows recent activity, or a busy topic only ever shows its oldest entries.
 */
export async function readTopic(
  limit = 100,
  topicId = config.hedera.topicId,
  order: "asc" | "desc" = "asc",
  opts: { keep?: (m: HcsMessage) => boolean; maxPages?: number } = {},
): Promise<TopicEntry[]> {
  if (!topicId) return [];
  const base = MIRROR_NODE[config.hedera.network as HederaNetwork];
  const out: TopicEntry[] = [];
  // With a filter, ask for full pages: the matches can be sparse among other message kinds.
  let url: string | null = `${base}/api/v1/topics/${topicId}/messages?order=${order}&limit=${opts.keep ? 100 : Math.min(limit, 100)}`;
  let pages = 0;
  while (url && out.length < limit && pages++ < (opts.maxPages ?? Infinity)) {
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`mirror node ${res.status}`);
    const data = (await res.json()) as { messages?: { message: string; sequence_number: number; consensus_timestamp: string }[]; links?: { next?: string } };
    for (const m of data.messages ?? []) {
      try {
        const parsed = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
        const msg = parseHcsMessage(parsed);
        if (opts.keep && !opts.keep(msg)) continue;
        out.push({ ...msg, sequence: m.sequence_number, consensusTimestamp: m.consensus_timestamp });
      } catch {
        /* someone else's message, or a message that carries a World sub */
      }
    }
    url = data.links?.next ? `${base}${data.links.next}` : null;
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
