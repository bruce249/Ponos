/**
 * x402 client for the bUSD data service. Pays HBAR on Hedera.
 * The caller names the payee and the maximum tinybar amount; a server cannot redirect either.
 */
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, hederaAccountIdsEqual, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { HederaNetwork } from "./hedera";

export const HBAR_ASSET_ID = "0.0.0";

export function parseHederaKey(key: string): PrivateKey {
  const k = key.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(k)) return PrivateKey.fromStringECDSA(k.replace(/^0x/, ""));
  if (/^30[0-9a-fA-F]+$/.test(k)) return PrivateKey.fromStringDer(k);
  return PrivateKey.fromString(k);
}

export type PayerConfig = {
  accountId: string;
  privateKey: string;
  network: HederaNetwork;
  /** Hard cap for a single payment, in tinybars. */
  maxTinybar: bigint;
};

export type PaidResponse = {
  status: number;
  body: unknown;
  txId: string;
  payer: string | null;
  amountTinybar: bigint;
  payTo: string;
};

export class PaymentRefused extends Error {}

export function createPayer(cfg: PayerConfig) {
  const signer = createClientHederaSigner(cfg.accountId, parseHederaKey(cfg.privateKey), { network: cfg.network });

  async function pay(url: string, init: RequestInit, expect: { payTo: string; maxTinybar: bigint }): Promise<PaidResponse> {
    let chosen: PaymentRequirements | null = null;
    let rejection = "no acceptable payment option";
    let policyEmptied = false;
    const cap = cfg.maxTinybar < expect.maxTinybar ? cfg.maxTinybar : expect.maxTinybar;

    const client = new x402Client((_v, reqs) => {
      chosen = reqs[0];
      return reqs[0];
    })
      .register(cfg.network, new ExactHederaScheme(signer))
      .setSpendControls({ allowedAssets: [{ network: cfg.network, asset: HBAR_ASSET_ID, maxAmountPerPayment: cap.toString() }] })
      .registerPolicy((_v, reqs) => {
        const ok = reqs.filter((r) => {
          if (r.network !== cfg.network) return (rejection = `network ${r.network} not allowed`), false;
          if (r.asset !== HBAR_ASSET_ID) return (rejection = `asset ${r.asset} not allowed`), false;
          if (!hederaAccountIdsEqual(r.payTo, expect.payTo)) return (rejection = `payTo ${r.payTo} is not the operator`), false;
          const amt = BigInt(r.amount);
          if (amt > expect.maxTinybar) return (rejection = `amount ${amt} above expected ${expect.maxTinybar}`), false;
          if (amt > cfg.maxTinybar) return (rejection = `amount ${amt} above cap ${cfg.maxTinybar}`), false;
          return true;
        });
        if (ok.length === 0) policyEmptied = true;
        return ok;
      });

    const payingFetch = wrapFetchWithPayment(fetch, client);
    let res: Response;
    try {
      res = await payingFetch(url, init);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (chosen === null && (policyEmptied || /filtered out|spend|maxAmount|not allowed|cap/i.test(msg))) {
        throw new PaymentRefused(policyEmptied ? rejection : msg);
      }
      throw e;
    }

    const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const detail = typeof body === "object" && body && "error" in (body as object) ? (body as { error: unknown }).error : text.slice(0, 200);
      throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    if (!header) throw new Error("paid response had no PAYMENT-RESPONSE header");
    const settle = decodePaymentResponseHeader(header);
    if (!settle.success || !settle.transaction) throw new Error(`settlement failed: ${settle.errorReason ?? "unknown"}`);
    const req = chosen as PaymentRequirements | null;
    return {
      status: res.status,
      body,
      txId: settle.transaction,
      payer: settle.payer ?? null,
      amountTinybar: req ? BigInt(req.amount) : 0n,
      payTo: req?.payTo ?? expect.payTo,
    };
  }

  return { pay, accountId: cfg.accountId };
}

export type Payer = ReturnType<typeof createPayer>;
