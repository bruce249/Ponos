import assert from "node:assert/strict";
import { test } from "node:test";
import { MockOffRamp } from "../src/offramp/mock";

test("mock off-ramp quotes from the FX cache and labels the credit as simulated", async () => {
  const ramp = new MockOffRamp(async () => ({ rate: 83.5, source: "open.er-api.com public FX rates" }));
  const quote = await ramp.quote(20_000_000n, "USD-INR");
  assert.equal(quote.simulated, true);
  assert.equal(quote.currency, "INR");
  assert.equal(quote.localAmount, "1670.00");
  assert.equal(quote.source, "open.er-api.com public FX rates");
  const paid = await ramp.payout(quote.id, "0.0.1@1.0", { name: "A", account: "upi@bank" });
  assert.equal(paid.text, "₹ credited (simulated)");
  assert.equal(paid.simulated, true);
  assert.equal((await ramp.status(paid.id)).burnTxId, "0.0.1@1.0");
});
