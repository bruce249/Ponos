/** What a licensed off-ramp partner implements. The demo ships only the mock. */

export type Corridor = {
  id: string;
  from: "USD";
  to: string;
  rail: string;
};

export type Quote = {
  id: string;
  corridor: string;
  amountBase: string;
  rate: number;
  localAmount: string;
  currency: string;
  feeBase: string;
  eta: string;
  source: string;
  simulated: true;
};

export type PayoutDest = { name: string; account: string };

export type PayoutStatus = {
  id: string;
  status: "credited";
  text: string;
  simulated: true;
  burnTxId: string;
};

export interface OffRampProvider {
  id: string;
  corridors(): Promise<Corridor[]>;
  quote(amountBase: bigint, corridor: string): Promise<Quote>;
  payout(quoteId: string, burnTxId: string, dest: PayoutDest): Promise<PayoutStatus>;
  status(payoutId: string): Promise<PayoutStatus>;
}
