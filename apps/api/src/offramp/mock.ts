/**
 * Simulated off-ramp. The rate comes from the FX cache. Nothing is sent to a bank.
 * INR payouts say "₹ credited (simulated)".
 */
import { randomUUID } from "node:crypto";
import { baseToDecimal } from "@byline-work/shared";
import type { Corridor, OffRampProvider, PayoutDest, PayoutStatus, Quote } from "./types";

const CURRENCY: Record<string, string> = { "USD-INR": "INR", "USD-PHP": "PHP", "USD-NGN": "NGN" };

export class MockOffRamp implements OffRampProvider {
  readonly id = "mock";
  private readonly quotes = new Map<string, Quote>();
  private readonly payouts = new Map<string, PayoutStatus>();

  constructor(private readonly rateFor: (pair: string) => Promise<{ rate: number; source: string }>) {}

  async corridors(): Promise<Corridor[]> {
    return [
      { id: "USD-INR", from: "USD", to: "INR", rail: "UPI (simulated)" },
      { id: "USD-PHP", from: "USD", to: "PHP", rail: "simulated" },
      { id: "USD-NGN", from: "USD", to: "NGN", rail: "simulated" },
    ];
  }

  async quote(amountBase: bigint, corridor: string): Promise<Quote> {
    const currency = CURRENCY[corridor];
    if (!currency) throw new Error(`unsupported corridor ${corridor}`);
    const fx = await this.rateFor(corridor);
    const usd = Number(baseToDecimal(amountBase));
    const local = usd * fx.rate;
    const quote: Quote = {
      id: randomUUID(),
      corridor,
      amountBase: amountBase.toString(),
      rate: fx.rate,
      localAmount: local.toFixed(2),
      currency,
      feeBase: "0",
      eta: "simulated",
      source: fx.source,
      simulated: true,
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  async payout(quoteId: string, burnTxId: string, _dest: PayoutDest): Promise<PayoutStatus> {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new Error("unknown quote");
    const text = quote.currency === "INR" ? "₹ credited (simulated)" : `${quote.localAmount} ${quote.currency} credited (simulated)`;
    const status: PayoutStatus = { id: randomUUID(), status: "credited", text, simulated: true, burnTxId };
    this.payouts.set(status.id, status);
    return status;
  }

  async status(payoutId: string): Promise<PayoutStatus> {
    const found = this.payouts.get(payoutId);
    if (!found) throw new Error("unknown payout");
    return found;
  }
}
