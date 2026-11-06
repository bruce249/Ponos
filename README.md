# Byline Work

A freelancer in Pune reviews work for an AI lab. The lab locks **bUSD** in an escrow before anyone starts. Silence pays the worker. Every transition is a public HCS message, and any agent can buy a signed reserve, NAV, or FX feed over x402.

bUSD is a testnet USD stablecoin from Hedera Stablecoin Studio (6 decimals, KYC, freeze, pause, wipe, a demo reserve, and a 1-tinybar HBAR custom fee). The 3% platform fee stays inside `EscrowVault`: it is charged only on the worker's share, and a refund returns pay plus fee. The HBAR fee cannot skim the escrow's bUSD balance.

This repo is testnet only. The lab key, the relayer, and the reviewer key are **demo custody**: the server holds them, and responses say so.

## Run

Node 24. From this folder:

```bash
npm install
cp .env.example .env
npm run preflight     # what is configured, and what each testnet step still needs
npm run keys          # FEED_SIGNER_KEY
npm run accounts      # ECDSA accounts, EVM alias, unlimited auto-association
npm run topic         # HCS topic, operator submit key, no admin key
```

Fill `OPERATOR_ACCOUNT_ID` / `OPERATOR_PRIVATE_KEY` from the Hedera portal before `accounts` and `topic`. Paste the printed lines into `.env`. Do not commit `.env`.

Stablecoin Studio needs the testnet factory and resolver (`SCS_FACTORY_ADDRESS`, `SCS_RESOLVER_ADDRESS`). Those are deployment addresses, not a token id.

```bash
npm run busd          # prints BUSD_TOKEN_ID, BUSD_SCS_PROXY, BUSD_RESERVE_ADDRESS from the SDK
```

Build the escrow first: `cd contracts && forge build` writes `contracts/out`, which `deploy:escrow` reads.

```bash
npm run deploy:escrow # ContractCreateFlow, constructor args with no selector
npm run lifecycle -- kyc 0.0.xxxx
npm run demo-seed     # 1000 bUSD deposit, batches A/B/C, claim+submit the timeout task
npm run dev:api       # indexer ~3s, keeper 15s. Do not start it if the web app needs the port.
npm run e2e           # instant, approved, timeout. Exact balances. HCS per transition.
npm run buy-nav       # pays 0.001 HBAR, checks the signature and the HCS anchor
npm run score         # Contributor Score from the mirror node only
npm run demo:frozen-transfer   # fraud scene: a frozen account's transfer is refused
npm test
npm run typecheck
```

`demo-seed`, `e2e`, `buy-nav`, and `busd` stop with the missing variable names when Hedera keys or the token are not set. They do not invent a token id.

Lifecycle (`npm run lifecycle -- …`):

| Command | Who signs | What |
|---|---|---|
| `deposit <account> <bUSD>` | admin, then cash-in | reserve up, then mint |
| `kyc <account>` | compliance | grant KYC |
| `freeze` / `unfreeze <account>` | compliance | token freeze |
| `pause` / `unpause` | admin | whole token |
| `redeem <account> <bUSD>` | holder, then burn | transfer to treasury, burn, reserve down |

Redeem wipes only if the SDK burn throws. The API route then quotes the FX cache and returns the text **₹ credited (simulated)**.

## What was reused from Byline v2

v2 lives in `../ETHGM/Build`. These shapes were ported and renamed for workers, tasks, and feeds:

| v2 | here |
|---|---|
| `apps/api/src/config.ts`, `db.ts` | same boot-on-partial-env pattern, new tables |
| `apps/api/src/world.ts` | worker login, step-up actions `claim_high` and `payout_wallet` |
| `apps/api/src/hcs.ts` | generic submit plus a v3 reader |
| `apps/api/src/payments.ts` | `apps/api/src/oracle/x402.ts` (static tinybar prices, operator payee) |
| `packages/agent/src/payer.ts` | `packages/shared/src/x402-payer.ts` |
| `packages/agent/src/zg.ts` | `apps/api/src/qa/zg.ts` |
| `packages/shared/src/attestation.ts` | `packages/shared/src/feed-sig.ts` (EIP-191 feed statement) |
| `packages/shared/src/hedera.ts`, `units.ts` | same, plus bUSD base units and contract, schedule, and token links |
| `apps/api/src/moderation.ts` | `apps/api/src/caps.ts` (daily claim cap and bans) |
| `scripts/gen-keys.ts`, `create-accounts.ts`, `create-topic.ts`, `pay-once.ts` | `scripts/`, with `pay-once` becoming `buy-nav` |

Not brought over: Arkiv, the ask pipeline, budget, citations, and authenticity.

New in this repo: the escrow contract, the escrow client, the mirror-node indexer, the keeper, SDK scheduling, gold-question QA, the Contributor Score and score tiers, the mock off-ramp, and the Stablecoin Studio scripts.

## Status

Live on Hedera testnet. bUSD is token `0.0.11340549`, and the escrow `0.0.11341621` is deployed and **verified** ([HashScan](https://hashscan.io/testnet/contract/0.0.11341621)). The web app is at https://ponos-byline-web.onrender.com and the API is at https://ponos-byline-api.onrender.com.

Proven on testnet (2026-11-06, tx ids in `BYLINE_WORK_BUILD.md` section 2):

- `npm run e2e` passes the instant, approved ($250 with the `claim_high` step-up gate) and timeout paths, with exact bUSD deltas and one HCS message per transition. The timeout task was paid by its HIP-1215 schedule, not the keeper. `e2e` fails, rather than passing quietly, if only the keeper paid.
- `npm run buy-nav`: x402 payment through the Blocky402 facilitator, signature verified, response anchored on HCS.
- Freeze: a frozen account's bUSD transfer is refused with `ACCOUNT_FROZEN_FOR_TOKEN`.
- Redeem: transfer to the treasury, then wipe and a reserve decrease. The SDK burn fails on testnet, so the wipe fallback is the path in use.

`forge test` (44 tests across the unit, fuzz and invariant suites), `npm test` (41) and `npm run typecheck` pass. World ID login redirects correctly in production. A full login with `acr` needs the World App and has not been run headless.

## Reviewers and large payouts

Above `HITL_THRESHOLD` (100 bUSD) a payout waits for a reviewer, and a reviewer can only stop it with an on-chain hold and a reason. Silence still pays the worker at the deadline. Above `DUAL_REVIEW_THRESHOLD` (1,000 bUSD) an early payout needs two distinct reviewers: set `REVIEWER2_*` and `deploy:escrow` grants the role and sets the threshold. The second approval comes from the second reviewer account (`x-byline-account` header).

The lab and review desks are demo desks. Without that header they use the first allowlisted account, so **do not expose this API publicly**. The `/api/fraud` and `/api/compliance/freeze` routes have no login at all.

## x402 data service

| Route | Returns |
|---|---|
| `/x402/busd/reserve` | supply, reserve, ratio, last update |
| `/x402/busd/nav` | reserve ÷ supply, with history |
| `/x402/fx/:pair` | USD-INR, USD-PHP, USD-NGN from a public FX source |
| `/x402/escrow/stats` | value locked, tasks by state, median seconds to pay, auto-release share, dispute rate |
| `/x402/client/:id/stats` | a lab's funding history, median seconds to pay, share paid, hold rate |

Every response is EIP-191 signed and its hash is anchored on HCS.

## Architecture

```mermaid
flowchart LR
  Lab[Lab key, demo custody] -->|fundBatch| Escrow[EscrowVault]
  Worker[Worker] -->|World ID| API[Hono API]
  API -->|claimFor submitFor| Escrow
  Escrow -->|HIP-1215 or keeper| Release[release]
  Release --> bUSD[(bUSD)]
  Escrow --> Indexer[Indexer]
  Indexer --> HCS[(HCS v3)]
  HCS --> Score[Contributor Score]
  Agent[Any agent] -->|x402| Feed[Reserve NAV FX stats]
  Feed --> HCS
  Worker -->|redeem| Burn[Treasury then burn]
  Burn --> Mock[Mock off-ramp]
```

The keeper runs every 15 seconds in every scheduling mode. It expires claims, refunds closed revision windows, pays unresolved disputes to the worker, and retries a release that reverted. `apps/api/src/schedule.ts` sends `ScheduleCreate` with `waitForExpiry` only when `ESCROW_SCHEDULING=sdk`.

Direct `claim` on the contract is only valid at or below 100 bUSD (`100_000_000` base units). The API always uses the relayer. Above 100 bUSD the relayer also requires a single-use `claim_high` approval whose target is the batch id. The payout address is stored on the task at claim. A later wallet change applies to new claims only.

Auto QA grades gold answers and a rubric checklist immediately. Manual batches are never auto-passed. 0G is called only when `ZG_API_KEY` is set. It is advisory: its verdict, request id and `teeVerified` (copied from the provider trace, never set to true by this server) are stored in the report, and a disagreement is flagged, but the outcome comes from the deterministic grade alone.

A World ID `sub` is stored in SQLite and rejected by the HCS schema. It is not written to events or public JSON. `DEMO_MOCK_WORLD=1` can create a worker labelled **demo human**. That row is not a World ID.

## HashScan

Live testnet deployment:

| What | Env | Id | HashScan |
|---|---|---|---|
| bUSD | `BUSD_TOKEN_ID` | `0.0.11340549` | [token](https://hashscan.io/testnet/token/0.0.11340549) |
| Stablecoin proxy | `BUSD_SCS_PROXY` | `0.0.11340548` (`0x6f0ad3a58548e1d327e6896116784beb4ddff4f3`) | [contract](https://hashscan.io/testnet/contract/0.0.11340548) |
| Reserve | `BUSD_RESERVE_ADDRESS` | `0.0.11340547` | [contract](https://hashscan.io/testnet/contract/0.0.11340547) |
| Escrow (verified) | `ESCROW_CONTRACT_ID` | `0.0.11341621` (`0x…ad0f35`) | [contract](https://hashscan.io/testnet/contract/0.0.11341621) |
| HCS topic | `HCS_TOPIC_ID` | `0.0.11339787` | [topic](https://hashscan.io/testnet/topic/0.0.11339787) |
| Operator | `OPERATOR_ACCOUNT_ID` | `0.0.11334686` | [account](https://hashscan.io/testnet/account/0.0.11334686) |
| Lab | `LAB_ACCOUNT_ID` | `0.0.11339173` | [account](https://hashscan.io/testnet/account/0.0.11339173) |
| Worker A | `WORKER_A_ACCOUNT_ID` | `0.0.11339174` | [account](https://hashscan.io/testnet/account/0.0.11339174) |
| Rented worker (fraud scene) | `WORKER_RENTED_ACCOUNT_ID` | `0.0.11339176` | [account](https://hashscan.io/testnet/account/0.0.11339176) |
| Reviewer | `REVIEWER_ACCOUNT_ID` | `0.0.11339172` | [account](https://hashscan.io/testnet/account/0.0.11339172) |
| Treasury | `TREASURY_ACCOUNT_ID` | `0.0.11339164` | [account](https://hashscan.io/testnet/account/0.0.11339164) |
| QA pool | `QA_POOL_ACCOUNT_ID` | `0.0.11339165` | [account](https://hashscan.io/testnet/account/0.0.11339165) |
| x402 agent | `AGENT_ACCOUNT_ID` | `0.0.11339178` | [account](https://hashscan.io/testnet/account/0.0.11339178) |

A message is `https://hashscan.io/testnet/topic/0.0.11339787/message/<sequence>`, a schedule is `https://hashscan.io/testnet/schedule/<schedule-id>`.

`EscrowVault` is **verified** (Sourcify `exact_match`, chain 296), so HashScan shows the source on the [contract page](https://hashscan.io/testnet/contract/0.0.11341621). Token `0.0.11340685` is an unused duplicate from a second `busd` run. Do not point `BUSD_TOKEN_ID` at it.

## Gap 9: a release can revert and stay due

`release` pays the worker and the fee split in one transaction. If the worker is frozen or not KYC'd, or if bUSD is paused, the token transfer reverts. The escrow state does not change: the task stays `Submitted`, `AwaitingApproval`, or `Disputed`, and the locked bUSD stays put. The scheduled call uses `releaseIfDue`, which catches that revert and returns false so the schedule itself succeeds. The keeper retries on its next 15 second tick. Timeouts resume once the account is unfrozen or the token is unpaused. On confirmed fraud a reviewer resolves the task as a refund instead of waiting on a frozen payout. The escrow, the treasury, and the QA pool are not frozen.

## What we do not claim

| We do not say | Because | We say instead |
|---|---|---|
| "Instant cash in your bank account" | The demo off-ramp is simulated, and real ones depend on licensed partners | "Paid in dollars in seconds. Converting to local currency plugs in through partners." |
| "Fully trustless" | The QA oracle and reviewers are trusted roles | "Funds are locked on-chain, every decision is public, and timeouts favour the worker." |
| "Human-made data" | World ID proves an accountable person, not that they did it without AI | "A real, accountable human did and stands behind every task." |
| "No regulation needed" | Issuing a stablecoin, KYC and cross-border payouts are regulated activities | "Built with the compliance controls a regulated issuer would need." |
| "Tax-free" | Many countries tax crypto payouts. India, for example, has specific rules for virtual digital assets | "Freelancers get a full HCS record of every payment for their tax filings." |

## Layout

`packages/shared` holds units, fee math, the escrow ABI, HCS v3 schemas, the score, feed signatures, and the x402 payer. `apps/api` is the Hono server, indexer, keeper, QA, and x402 resource server. `stablecoin/` creates bUSD and runs the issuer lifecycle. `scripts/` is the testnet toolchain. `contracts/` is the Foundry project (`EscrowVault.sol` and mocks). `apps/web/` is the Next app (`/lab`, `/work`, `/review`, `/transparency`).
