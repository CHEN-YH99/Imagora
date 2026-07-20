import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { MockPaymentProvider, StripePaymentProvider, createPaymentProvider } from "../packages/payments/dist/index.js";

test("mock payment provider covers checkout, webhook, reconciliation and refund", async () => {
  const provider = new MockPaymentProvider();
  const input = { orderId: "order-1", orderNo: "NO-1", amountCents: 990, currency: "CNY" };
  const payment = await provider.createPayment(input);
  assert.match(payment.checkoutUrl, /mock-checkout/);
  const event = await provider.verifyWebhook({
    providerEventId: "event-1",
    ...input,
    paymentIntentId: payment.paymentIntentId
  });
  assert.equal(event.orderId, input.orderId);
  assert.equal((await provider.retrieveOrderPaymentStatus({ ...input, paymentIntentId: null })).status, "unpaid");
  process.env.MOCK_RECONCILE_PAID_ORDERS = input.orderId;
  assert.equal(
    (await provider.retrieveOrderPaymentStatus({ ...input, paymentIntentId: payment.paymentIntentId })).status,
    "paid"
  );
  assert.equal((await provider.refundOrder({ ...input, paymentIntentId: payment.paymentIntentId })).status, "refunded");
  await assert.rejects(provider.verifyWebhook({ invalid: true }), /Invalid mock webhook payload/);
  assert.equal(createPaymentProvider("mock").name, "mock");
  assert.throws(() => createPaymentProvider("wechat"), /Unsupported payment provider/);
});

test("stripe webhook verifies a signed payment event", async () => {
  const secret = "whsec_core_coverage";
  process.env.STRIPE_SECRET_KEY = "sk_test_core_coverage";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  const payload = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        amount_total: 990,
        currency: "cny",
        payment_status: "paid",
        payment_intent: "pi_1",
        metadata: { orderId: "order-1", orderNo: "NO-1" }
      }
    }
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const provider = new StripePaymentProvider();
  const event = await provider.verifyWebhook(payload, `t=${timestamp},v1=${signature}`);
  assert.equal(event.paymentIntentId, "pi_1");
  await assert.rejects(provider.verifyWebhook(payload, `t=${timestamp},v1=invalid`), /signature/i);
});
