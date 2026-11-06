/**
 * An outside agent pays 0.001 HBAR for the NAV feed, then checks the EIP-191
 * signature and the HCS feed anchor.
 *   npm run buy-nav
 */
import { hashFeedBody, hashscanTx, verifyFeed, type Hex } from "@byline-work/shared";
import { createPayer } from "@byline-work/shared";
import { privateKeyToAccount } from "viem/accounts";
import { readTopic } from "../apps/api/src/hcs";
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

const topic = await readTopic(30);
const anchor = topic.find((m) => m.kind === "feed" && m.feed === "nav" && m.hash.toLowerCase() === hashFeedBody(body).toLowerCase());
if (!anchor) die("no HCS feed anchor matches this NAV response");
console.log(`hcs feed anchor #${anchor.sequence}`);
console.log(`nav ${body.nav ?? ""}`);
