export interface CreatePaymentInput {
  orderId: string;
  orderNo: string;
  amountCents: number;
  currency: string;
}

export interface CreatePaymentResult {
  provider: string;
  paymentIntentId: string;
  checkoutUrl: string;
}

export interface VerifiedPaymentEvent {
  provider: string;
  providerEventId: string;
  orderId: string;
  eventType: "payment.succeeded";
  amountCents: number;
}

export interface PaymentProvider {
  name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyWebhook(payload: unknown, signature: string | undefined): Promise<VerifiedPaymentEvent>;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return {
      provider: this.name,
      paymentIntentId: `mock_pi_${input.orderId}`,
      checkoutUrl: `mock-checkout://${input.orderNo}?amount=${input.amountCents}&currency=${input.currency}`
    };
  }

  async verifyWebhook(payload: unknown): Promise<VerifiedPaymentEvent> {
    if (!isMockWebhook(payload)) {
      throw new Error("Invalid mock webhook payload");
    }
    return {
      provider: this.name,
      providerEventId: payload.providerEventId,
      orderId: payload.orderId,
      eventType: "payment.succeeded",
      amountCents: payload.amountCents
    };
  }
}

export function createPaymentProvider(name = process.env.PAYMENT_PROVIDER ?? "mock"): PaymentProvider {
  switch (name) {
    case "mock":
      return new MockPaymentProvider();
    default:
      throw new Error(`Unsupported payment provider: ${name}`);
  }
}

function isMockWebhook(value: unknown): value is { providerEventId: string; orderId: string; amountCents: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerEventId === "string" &&
    typeof record.orderId === "string" &&
    typeof record.amountCents === "number"
  );
}
