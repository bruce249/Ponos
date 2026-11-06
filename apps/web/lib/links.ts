/** HashScan testnet links. Local copy so this app typechecks without @byline/shared. */

const ROOT = "https://hashscan.io/testnet";

export type ChainRefs = {
  txId?: string | null;
  scheduleId?: string | null;
  topicId?: string | null;
  sequence?: number | null;
  tokenId?: string | null;
  contractId?: string | null;
  accountId?: string | null;
};

/** SDK id "0.0.123@1700000000.123456789" -> mirror id "0.0.123-1700000000-123456789". */
export function toMirrorTxId(txId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId.trim());
  if (!m) return txId.trim();
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function hashscanTx(txId: string): string {
  if (txId.startsWith("https://")) return txId;
  return `${ROOT}/transaction/${encodeURIComponent(toMirrorTxId(txId))}`;
}

export function hashscanAccount(accountId: string): string {
  return `${ROOT}/account/${accountId}`;
}

export function hashscanToken(tokenId: string): string {
  return `${ROOT}/token/${tokenId}`;
}

export function hashscanContract(contractId: string): string {
  return `${ROOT}/contract/${contractId}`;
}

export function hashscanTopic(topicId: string): string {
  return `${ROOT}/topic/${topicId}`;
}

export function hashscanTopicMessage(topicId: string, sequence: number): string {
  return `${ROOT}/topic/${topicId}/message/${sequence}`;
}

export function hashscanSchedule(scheduleId: string): string {
  return `${ROOT}/schedule/${scheduleId}`;
}

export type RefKind = "tx" | "schedule" | "message" | "topic" | "token" | "contract" | "account";

export type RefLink = { kind: RefKind; href: string; label: string; title: string };

export function refLinks(refs: ChainRefs): RefLink[] {
  const out: RefLink[] = [];
  if (refs.txId) out.push({ kind: "tx", href: hashscanTx(refs.txId), label: "transaction", title: refs.txId });
  if (refs.scheduleId) out.push({ kind: "schedule", href: hashscanSchedule(refs.scheduleId), label: "schedule", title: refs.scheduleId });
  if (refs.topicId && refs.sequence != null && refs.sequence > 0) {
    out.push({
      kind: "message",
      href: hashscanTopicMessage(refs.topicId, refs.sequence),
      label: `HCS #${refs.sequence}`,
      title: `${refs.topicId} #${refs.sequence}`,
    });
  } else if (refs.topicId) {
    out.push({ kind: "topic", href: hashscanTopic(refs.topicId), label: "topic", title: refs.topicId });
  }
  if (refs.tokenId) out.push({ kind: "token", href: hashscanToken(refs.tokenId), label: "token", title: refs.tokenId });
  if (refs.contractId) out.push({ kind: "contract", href: hashscanContract(refs.contractId), label: "contract", title: refs.contractId });
  if (refs.accountId) out.push({ kind: "account", href: hashscanAccount(refs.accountId), label: refs.accountId, title: refs.accountId });
  return out;
}

const ORDER: RefKind[] = ["tx", "schedule", "message", "topic", "token", "contract", "account"];

export function primaryHref(refs: ChainRefs, prefer?: RefKind): string | null {
  const links = refLinks(refs);
  if (!links.length) return null;
  if (prefer) {
    const hit = links.find((l) => l.kind === prefer);
    if (hit) return hit.href;
  }
  for (const kind of ORDER) {
    const hit = links.find((l) => l.kind === kind);
    if (hit) return hit.href;
  }
  return links[0]?.href ?? null;
}

export function stepUpHref(action: "payout_wallet" | "claim_high", target: string): string {
  return `/api/world/stepup?${new URLSearchParams({ action, target })}`;
}
