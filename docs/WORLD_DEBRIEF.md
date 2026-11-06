# World ID integration debrief

Track: **World ID Agent Pass**. Integration: OIDC with step-up against `https://auth.world.org`, confidential client, `openid-client@6.8.9` and `jose@6.2.15`. Code: [apps/api/src/world.ts](../apps/api/src/world.ts), routes in [apps/api/src/routes.ts](../apps/api/src/routes.ts).

> Lines marked **TODO** need the team's own numbers from the event. Everything else was observed while building and running this repo.

## Where a human is needed

Byline Work pays freelancers from an escrow. Two actions move money to a person, so both need a fresh World verification at that moment, not just a login:

| Action | When | Target the approval is bound to | What the approval allows |
|---|---|---|---|
| `claim_high` | Claiming a task that pays over 100 bUSD | The batch id | One claim of that batch |
| `payout_wallet` | Binding or changing the Hedera account that receives pay | The account id | One bind of that account |

The full journey: the worker clicks the action, the API sends them to World with `max_age=0` and `prompt=login`, they verify in World App, World redirects back, the server checks the ID token, writes a single-use approval, and the protected action consumes it. Without a valid approval the claim or bind does not happen.

## Validation on the server

All checks run in the API. The browser never sees the client secret or the ID token.

- PKCE (S256), `state` and `nonce` are checked by `openid-client`.
- The ID token signature is checked again with `jose.jwtVerify` against World's `jwks_uri`.
- **Freshness:** `auth_time` must be present and at most `WORLD_STEPUP_MAX_AGE_SEC` (120 s) old. An `auth_time` more than 30 s in the future is rejected.
- **Assurance:** with `WORLD_REQUIRE_ACR=true`, an ID token without `acr` is denied as `unverified`.
- **Single use:** approvals expire after `WORLD_APPROVAL_TTL_SEC` (120 s). They are consumed with `UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL`, so two requests cannot both use one.
- **Binding:** an approval for one batch cannot claim another.
- The World `sub` stays in SQLite. The HCS schema rejects any message that carries it, and it never appears in public JSON.

## Unsuccessful paths

Each one shows a reason and changes nothing:

| Path | Code | Message shown |
|---|---|---|
| Cancelled in World App | `access_denied`, mapped to `cancelled` | "Verification cancelled in World. Nothing was changed." |
| Approval older than its TTL | `timeout` | "approval expired …" |
| Approval used twice | `already_used` | "approval already used" |
| Verification not fresh | `stale_auth` | "auth_time is …s old" |
| No `acr` in the token | `unverified` | "ID token has no acr claim" |
| Approval for a different batch | refused by the target check | — |

`npm run e2e` exercises the gate on testnet. A claim over 100 bUSD was refused with no approval, refused with an approval for another batch, accepted once, and refused on replay (2026-11-06). The approval rows in `e2e` are inserted and labelled as simulated, because a World App login cannot run headless. The gate that consumes them is the production code.

## Time to first success

- Discovery and the authorize URL: minutes. `/.well-known/openid-configuration` is complete and standard.
- Denied paths: testable early with a dummy client against the live issuer.
- First validated login with the registered client: **TODO (minutes from registering the client to the first validated ID token)**.
- First successful step-up on the deployed site: **TODO**.

## Friction

1. **Cookies and the redirect host on a public-suffix domain.** The site runs on Render, and `onrender.com` is a public suffix, so the API host cannot share the session cookie with the web host. The fix was to proxy `/api/*` through the web origin and register `https://ponos-byline-web.onrender.com/api/world/callback` as the redirect URI. A short note on cookie and redirect setup for apps with a separate API host would save time.
2. **Library default vs our requirement.** `openid-client` v6 validates ID token claims but, per OIDC, does not require checking the signature of a token received directly from the token endpoint over TLS. We verify a second time with `jose`. One sentence in World's docs on this would stop teams assuming either way.
3. **`max_age=0` and `auth_time`.** The docs don't say whether `max_age=0` always forces a new World App verification or can be met by a recent session. We enforce freshness ourselves.
4. **Verification levels.** Tokens for unverified accounts omit `acr`. An example token for each verification level would help.
5. **Mocked proofs.** **TODO: how the mocked identities behaved. Did `acr` appear, and with which value?**
6. **TODO: anything else that slowed the team down.**

## Missing capability or documentation

- A documented way to trigger each denial on purpose (cancel, timeout, wrong identity) with test identities, so teams can demo the failure paths reliably.
- A clear statement of `auth_time` semantics under `max_age=0` with `prompt=login`.

## The one improvement with the most impact

Let the relying party show the action in World App. For example, a signed `binding_message` or `authorization_details` such as "Claim task: Review Python solutions, 250 bUSD". Today we bind the approval to the action through `state` on our own server, so the person approving only sees a generic verification. Showing the action would make the step-up meaningful to the human, not just to the server.
