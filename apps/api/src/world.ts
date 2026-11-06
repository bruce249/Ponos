/**
 * World ID (auth.world.org) as an OIDC provider, with step-up.
 *
 * Login binds one worker to (iss, sub). A second login with the same World ID
 * returns that same worker. Step-up actions are `claim_high` (target: batch id)
 * and `payout_wallet` (target: the Hedera account being bound). Approvals are
 * single-use and expire. The World `sub` stays in this database.
 */
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config";
import { get, run, type ApprovalRow, type Db, type OidcRow, type WorkerRow } from "./db";

export type StepUpAction = "claim_high" | "payout_wallet";

export type DenialReason =
  | "cancelled"
  | "timeout"
  | "expired_code"
  | "sub_mismatch"
  | "stale_auth"
  | "unverified"
  | "invalid_token"
  | "state_mismatch"
  | "already_used"
  | "wrong_action"
  | "cap_reached"
  | "banned"
  | "error";

export const DENIAL_TEXT: Record<DenialReason, string> = {
  cancelled: "Verification cancelled in World. Nothing was changed.",
  timeout: "Verification timed out. Nothing was changed. Start again.",
  expired_code: "The World approval code expired or was rejected. Nothing was changed.",
  sub_mismatch: "A different World ID approved this. Only the World ID bound to this worker can approve. Nothing was changed.",
  stale_auth: "World did not perform a fresh verification just now. Nothing was changed.",
  unverified: "This World account is not verified as a unique human. Nothing was changed.",
  invalid_token: "The World ID token failed validation. Nothing was changed.",
  state_mismatch: "This approval does not belong to this session or was already used. Nothing was changed.",
  already_used: "That approval was already used. Each approval works once.",
  wrong_action: "That approval was for a different action. Nothing was changed.",
  cap_reached: "Daily claim limit for this World ID is reached. Try again tomorrow.",
  banned: "This World ID is banned. One person has one World ID, so a new account does not help.",
  error: "World verification failed. Nothing was changed.",
};

const TXN_TTL_SEC = 600;
const now = () => Math.floor(Date.now() / 1000);

let cfgPromise: Promise<oidc.Configuration> | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function oidcConfig(): Promise<oidc.Configuration> {
  if (!config.world.clientId || !config.world.clientSecret) throw new Error("WORLD_CLIENT_ID / WORLD_CLIENT_SECRET not set");
  if (!cfgPromise) {
    cfgPromise = oidc
      .discovery(new URL(config.world.issuer), config.world.clientId, undefined, oidc.ClientSecretBasic(config.world.clientSecret))
      .catch((e) => {
        cfgPromise = null;
        throw e;
      });
  }
  const c = await cfgPromise;
  if (!jwks) jwks = createRemoteJWKSet(new URL(c.serverMetadata().jwks_uri!));
  return c;
}

export async function buildAuthUrl(db: Db, sessionId: string, purpose: "login" | "stepup", action?: StepUpAction, target?: string): Promise<string> {
  const c = await oidcConfig();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  run(
    db,
    "INSERT INTO oidc (state, session_id, purpose, action, target, nonce, code_verifier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    state, sessionId, purpose, action ?? null, target ?? null, nonce, codeVerifier, now(),
  );
  const params: Record<string, string> = {
    redirect_uri: config.world.redirectUri,
    scope: "openid",
    response_type: "code",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (purpose === "stepup") {
    params.max_age = "0";
    params.prompt = "login";
  }
  if (config.world.acrValues) params.acr_values = config.world.acrValues;
  return oidc.buildAuthorizationUrl(c, params).href;
}

export type CallbackResult =
  | { ok: true; purpose: "login"; workerId: string }
  | { ok: true; purpose: "stepup"; workerId: string; approvalId: string; action: StepUpAction; target: string }
  | { ok: false; purpose: "login" | "stepup" | null; reason: DenialReason; detail: string; action?: string | null; target?: string | null };

export async function handleCallback(db: Db, sessionId: string | null, search: string): Promise<CallbackResult> {
  const params = new URLSearchParams(search);
  const state = params.get("state") ?? "";
  const txn = state ? get<OidcRow>(db, "SELECT * FROM oidc WHERE state = ?", state) : undefined;

  const deny = (reason: DenialReason, detail: string): CallbackResult => {
    const workerId = sessionId ? get<{ worker_id: string | null }>(db, "SELECT worker_id FROM sessions WHERE id = ?", sessionId)?.worker_id ?? null : null;
    run(
      db,
      "INSERT INTO denials (worker_id, session_id, action, target, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      workerId, sessionId, txn?.action ?? (txn?.purpose === "login" ? "login" : null), txn?.target ?? null, reason, detail, now(),
    );
    return { ok: false, purpose: txn?.purpose ?? null, reason, detail, action: txn?.action, target: txn?.target };
  };

  if (!txn) return deny("state_mismatch", "unknown state");
  if (txn.consumed_at) return deny("state_mismatch", "state already used");
  if (!sessionId || txn.session_id !== sessionId) return deny("state_mismatch", "state belongs to another browser session");
  run(db, "UPDATE oidc SET consumed_at = ? WHERE state = ?", now(), state);

  const err = params.get("error");
  if (err) {
    const desc = params.get("error_description") ?? err;
    if (err === "access_denied") return deny("cancelled", desc);
    if (err === "login_required" || err === "interaction_required") return deny("stale_auth", desc);
    return deny("error", desc);
  }
  if (now() - txn.created_at > TXN_TTL_SEC) return deny("timeout", `World flow took longer than ${TXN_TTL_SEC}s`);

  let c: oidc.Configuration;
  try {
    c = await oidcConfig();
  } catch (e: unknown) {
    return deny("error", `discovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const currentUrl = new URL(config.world.redirectUri);
  currentUrl.search = search.startsWith("?") ? search : `?${search}`;

  let idToken: string;
  try {
    const tokens = await oidc.authorizationCodeGrant(c, currentUrl, {
      pkceCodeVerifier: txn.code_verifier,
      expectedState: txn.state,
      expectedNonce: txn.nonce,
      idTokenExpected: true,
    });
    if (!tokens.id_token) return deny("invalid_token", "no id_token returned");
    idToken = tokens.id_token;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/invalid_grant|expired/i.test(msg)) return deny("expired_code", msg);
    return deny("invalid_token", msg);
  }

  let claims: JWTPayload & { nonce?: string; auth_time?: number; acr?: string };
  try {
    const verified = await jwtVerify(idToken, jwks!, {
      issuer: c.serverMetadata().issuer,
      audience: config.world.clientId,
      algorithms: ["RS256"],
      clockTolerance: 10,
    });
    claims = verified.payload as typeof claims;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny("invalid_token", `jwt verify: ${msg}`);
  }
  if (claims.nonce !== txn.nonce) return deny("invalid_token", "nonce mismatch");
  if (!claims.sub || !claims.iss) return deny("invalid_token", "missing sub/iss");

  if (txn.purpose === "login") {
    let worker = get<WorkerRow>(db, "SELECT * FROM workers WHERE world_iss = ? AND world_sub = ?", claims.iss, claims.sub);
    if (!worker) {
      const id = randomUUID();
      run(
        db,
        "INSERT INTO workers (id, kind, world_iss, world_sub, world_acr, created_at) VALUES (?, 'world', ?, ?, ?, ?)",
        id, claims.iss, claims.sub, claims.acr ?? null, Date.now(),
      );
      worker = get<WorkerRow>(db, "SELECT * FROM workers WHERE id = ?", id)!;
    } else if (claims.acr) {
      run(db, "UPDATE workers SET world_acr = ? WHERE id = ?", claims.acr, worker.id);
    }
    run(db, "UPDATE sessions SET worker_id = ? WHERE id = ?", worker.id, sessionId);
    return { ok: true, purpose: "login", workerId: worker.id };
  }

  const session = get<{ worker_id: string | null }>(db, "SELECT worker_id FROM sessions WHERE id = ?", sessionId);
  const worker = session?.worker_id ? get<WorkerRow>(db, "SELECT * FROM workers WHERE id = ?", session.worker_id) : undefined;
  if (!worker || worker.kind !== "world") return deny("state_mismatch", "no logged-in World ID worker for this session");
  if (worker.world_sub !== claims.sub || worker.world_iss !== claims.iss) return deny("sub_mismatch", "ID token sub differs from the worker's bound World ID");
  if (typeof claims.auth_time !== "number") return deny("stale_auth", "ID token has no auth_time");
  const age = now() - claims.auth_time;
  if (age > config.world.stepUpMaxAgeSec) return deny("stale_auth", `auth_time is ${age}s old (max ${config.world.stepUpMaxAgeSec}s)`);
  if (age < -30) return deny("invalid_token", "auth_time is in the future");
  if (config.world.requireAcr && !claims.acr) return deny("unverified", "ID token has no acr claim");
  if (!txn.action || !txn.target) return deny("wrong_action", "step-up has no action");

  const approvalId = randomUUID();
  run(
    db,
    "INSERT INTO approvals (id, worker_id, action, target, auth_time, acr, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    approvalId, worker.id, txn.action, txn.target, claims.auth_time, claims.acr ?? null, now(), now() + config.world.approvalTtlSec,
  );
  return { ok: true, purpose: "stepup", workerId: worker.id, approvalId, action: txn.action as StepUpAction, target: txn.target };
}

/** Consumes a step-up approval exactly once. The UPDATE ... WHERE used_at IS NULL is the atomic check. */
export function consumeApproval(
  db: Db,
  approvalId: string,
  workerId: string,
  action: StepUpAction,
  target: string,
): { ok: true; approval: ApprovalRow } | { ok: false; reason: DenialReason; detail: string } {
  const a = get<ApprovalRow>(db, "SELECT * FROM approvals WHERE id = ?", approvalId);
  const deny = (reason: DenialReason, detail: string) => {
    run(db, "INSERT INTO denials (worker_id, action, target, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)", workerId, action, target, reason, detail, now());
    return { ok: false as const, reason, detail };
  };
  if (!a || a.worker_id !== workerId) return deny("state_mismatch", "unknown approval");
  if (a.action !== action || a.target !== target) return deny("wrong_action", `approval is for ${a.action}:${a.target}`);
  if (a.used_at) return deny("already_used", "approval already used");
  if (now() > a.expires_at) return deny("timeout", `approval expired ${now() - a.expires_at}s ago`);
  const res = run(db, "UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL", now(), approvalId);
  if (Number(res.changes) !== 1) return deny("already_used", "approval already used");
  return { ok: true, approval: a };
}
