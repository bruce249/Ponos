/** Hedera helpers shared by the API, scripts and web. Pure functions, no SDK import. */

export type HederaNetwork = "hedera:testnet" | "hedera:mainnet";

export const MIRROR_NODE: Record<HederaNetwork, string> = {
  "hedera:testnet": "https://testnet.mirrornode.hedera.com",
  "hedera:mainnet": "https://mainnet-public.mirrornode.hedera.com",
};

export const ACCOUNT_ID_RE = /^0\.0\.\d+$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAccountId(v: unknown): v is string {
  return typeof v === "string" && ACCOUNT_ID_RE.test(v);
}

export function isEvmAddress(v: unknown): v is string {
  return typeof v === "string" && EVM_ADDRESS_RE.test(v);
}

export function networkSlug(network: HederaNetwork): "testnet" | "mainnet" {
  return network === "hedera:mainnet" ? "mainnet" : "testnet";
}

/**
 * SDK transaction id "0.0.123@1700000000.123456789" -> mirror node id "0.0.123-1700000000-123456789".
 * Already-dashed ids are returned unchanged.
 */
export function toMirrorTxId(txId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId.trim());
  if (!m) return txId.trim();
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function base(network: HederaNetwork): string {
  return `https://hashscan.io/${networkSlug(network)}`;
}

export function hashscanTx(txId: string, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/transaction/${encodeURIComponent(toMirrorTxId(txId))}`;
}

export function hashscanAccount(accountId: string, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/account/${accountId}`;
}

export function hashscanTopic(topicId: string, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/topic/${topicId}`;
}

export function hashscanTopicMessage(topicId: string, sequence: number, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/topic/${topicId}/message/${sequence}`;
}

export function hashscanContract(contractIdOrAddress: string, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/contract/${contractIdOrAddress}`;
}

export function hashscanSchedule(scheduleId: string, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/schedule/${scheduleId}`;
}

export function hashscanToken(tokenId: string, network: HederaNetwork = "hedera:testnet"): string {
  return `${base(network)}/token/${tokenId}`;
}
