/**
 * An outside agent pays 0.001 HBAR for the NAV feed, then checks the EIP-191
 * signature and the HCS feed anchor.
 *   npm run buy-nav
 */
import { hashFeedBody, hashscanTx, MIRROR_NODE, verifyFeed, type HederaNetwork, type Hex } from "@byline-work/shared";
import { createPayer } from "@byline-work/shared";
import { privateKeyToAccount } from "viem/accounts";
import { die, missing, need } from "./lib";

const absent = missing(["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY", "OPERATOR_ACCOUNT_ID", "FEED_SIGNER_KEY", "HCS_TOPIC_ID"]);
if (absent.length) die(`buy-nav is not configured. Missing: ${absent.join(", ")}`);

const api = (process.env.API_PUBLIC_URL || "http://localhost:8787").replace(/\/+$/, "");
const url = `${api}/x402/busd/nav`;
const first = await fetch(url, { headers: { accept: "application/json" } });
if (first.status !== 402) die(`expected 402, got ${first.status}: ${await first.text()}`);
const required = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED") ?? first.headers.get("payment-required") ?? "", "base64").toString("utf8")) as { accepts: { payTo: string; amount: string }[] };
const option = required.accepts[0];
if (!option) die("402 response had no accepts[]");
if (BigInt(option.amount) !== 100_000n) die(`expected 100000 tinybar, got ${option.amount}`);
console.log(`402 pay ${option.amount} tinybar to ${option.payTo}`);

const payer = createPayer({
  accountId: need("AGENT_ACCOUNT_ID"),
  privateKey: need("AGENT_PRIVATE_KEY"),
  network: (process.env.HEDERA_NETWORK as "hedera:testnet") || "hedera:testnet",
  maxTinybar: 100_000n,
});
const paid = await payer.pay(url, { method: "GET", headers: { accept: "application/json" } }, { payTo: option.payTo, maxTinybar: BigInt(option.amount) });
const body = paid.body as { signature?: Hex; feed?: "nav"; ts?: number; hcsSequence?: number; nav?: string };
if (!body.signature || body.feed !== "nav" || typeof body.ts !== "number") die("paid body is missing feed, ts, or signature");
const signer = privateKeyToAccount(need("FEED_SIGNER_KEY") as Hex);
const check = await verifyFeed({ feed: "nav", bodyHash: hashFeedBody(body), ts: body.ts }, body.signature, [signer.address]);
if (!check.ok) die(`signature rejected: ${check.reason}`);
console.log(`signature ok ${check.signer}`);
console.log(`tx ${paid.txId}`);
console.log(hashscanTx(paid.txId));

// readTopic pages from sequence 1, so a short read never reaches a fresh anchor on a busy topic. Fetch the
// sequence the response names, retrying while the mirror node catches up with consensus.
if (typeof body.hcsSequence !== "number") die("paid body has no hcsSequence, so the response was not anchored");
const mirror = MIRROR_NODE[((process.env.HEDERA_NETWORK as HederaNetwork) || "hedera:testnet")];
let anchor: { sequence: number } | null = null;
for (let i = 0; i < 15 && !anchor; i++) {
  const res = await fetch(`${mirror}/api/v1/topics/${need("HCS_TOPIC_ID")}/messages/${body.hcsSequence}`, { signal: AbortSignal.timeout(20_000) });
  if (res.ok) {
    const m = (await res.json()) as { message: string; sequence_number: number };
    const msg = JSON.parse(Buffer.from(m.message, "base64").toString("utf8")) as { kind?: string; feed?: string; hash?: string };
    if (msg.kind !== "feed" || msg.feed !== "nav" || msg.hash?.toLowerCase() !== hashFeedBody(body).toLowerCase()) die(`HCS #${m.sequence_number} does not anchor this NAV response`);
    anchor = { sequence: m.sequence_number };
  } else await new Promise((r) => setTimeout(r, 2000));
}
if (!anchor) die("no HCS feed anchor matches this NAV response");
console.log(`hcs feed anchor #${anchor.sequence}`);
console.log(`nav ${body.nav ?? ""}`);
