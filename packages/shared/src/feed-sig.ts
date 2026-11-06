/**
 * Signed x402 feed responses. EIP-191 (viem signMessage / recoverMessageAddress)
 * over a canonical statement. A buyer checks the signer and the hash of the body.
 */
import { keccak256, recoverMessageAddress, stringToBytes, type Hex } from "viem";

export type FeedKind = "reserve" | "nav" | "fx" | "stats";

export type FeedStatement = {
  feed: FeedKind;
  /** keccak256 of the canonical JSON body, without the signature fields. */
  bodyHash: Hex;
  ts: number;
};

export function canonicalFeed(f: FeedStatement): string {
  return ["Byline Work feed v1", `feed=${f.feed}`, `bodyHash=${f.bodyHash.toLowerCase()}`, `ts=${Math.floor(f.ts)}`].join("\n");
}

/** Stable JSON: keys sorted, no signature fields. Hash this, then sign the statement. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (k === "signature" || k === "signer" || k === "canonical" || k === "hcsSequence" || k === "hcsTopic" || k === "hcsTx") continue;
      out[k] = sortValue(src[k]);
    }
    return out;
  }
  return value;
}

export function hashFeedBody(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

export type FeedCheck = { ok: true; signer: Hex } | { ok: false; reason: string };

export async function verifyFeed(statement: FeedStatement, signature: Hex, trustedSigners: string[]): Promise<FeedCheck> {
  let signer: Hex;
  try {
    signer = await recoverMessageAddress({ message: canonicalFeed(statement), signature });
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  const trusted = trustedSigners.map((a) => a.toLowerCase());
  if (!trusted.includes(signer.toLowerCase())) return { ok: false, reason: "signer is not the feed key" };
  return { ok: true, signer };
}
