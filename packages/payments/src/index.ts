import { createHmac, timingSafeEqual } from "node:crypto";

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
  orderNo: string;
  eventType: "payment.succeeded";
  amountCents: number;
  currency: string;
  paymentIntentId: string | null;
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
    const parsedPayload = typeof payload === "string" ? parseJson(payload) : payload;
    if (!isMockWebhook(parsedPayload)) {
      throw new Error("Invalid mock webhook payload");
    }
    return {
      provider: this.name,
      providerEventId: parsedPayload.providerEventId,
      orderId: parsedPayload.orderId,
      orderNo: parsedPayload.orderNo,
      eventType: "payment.succeeded",
      amountCents: parsedPayload.amountCents,
      currency: parsedPayload.currency.toUpperCase(),
      paymentIntentId: `mock_pi_${parsedPayload.orderId}`
    };
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  private readonly secretKey = requiredEnv("STRIPE_SECRET_KEY");
  private readonly webhookSecret = requiredEnv("STRIPE_WEBHOOK_SECRET");
  private readonly successUrl = process.env.STRIPE_SUCCESS_URL ?? "http://127.0.0.1:3100/orders?paid=1";
  private readonly cancelUrl = process.env.STRIPE_CANCEL_URL ?? "http://127.0.0.1:3100/pricing?canceled=1";
  private readonly timeoutMs = envNumber("STRIPE_TIMEOUT_MS", 15_000);
  private readonly apiBaseUrl = (process.env.STRIPE_API_BASE_URL ?? "https://api.stripe.com").replace(/\/$/, "");

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const body = new URLSearchParams({
      mode: "payment",
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
      client_reference_id: input.orderId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(input.amountCents),
      "line_items[0][price_data][product_data][name]": `Imagora credits ${input.orderNo}`,
      "metadata[orderId]": input.orderId,
      "metadata[orderNo]": input.orderNo,
      "payment_intent_data[metadata][orderId]": input.orderId,
      "payment_intent_data[metadata][orderNo]": input.orderNo
    });
    const response = await fetch(`${this.apiBaseUrl}/v1/checkout/sessions`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const payload = (await response.json().catch(() => ({}))) as StripeCheckoutSession;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Stripe checkout session failed with ${response.status}`);
    }
    if (!payload.id || !payload.url) {
      throw new Error("Stripe checkout session did not include id or url");
    }
    return {
      provider: this.name,
      paymentIntentId: payload.id,
      checkoutUrl: payload.url
    };
  }

  async verifyWebhook(payload: unknown, signature: string | undefined): Promise<VerifiedPaymentEvent> {
    if (!signature) {
      throw new Error("Missing Stripe webhook signature");
    }
    const rawPayload = typeof payload === "string" ? payload : JSON.stringify(payload);
    verifyStripeSignature(rawPayload, signature, this.webhookSecret);
    const event = typeof payload === "string" ? (JSON.parse(payload) as StripeEvent) : (payload as StripeEvent);
    if (event.type !== "checkout.session.completed" && event.type !== "payment_intent.succeeded") {
      throw new Error(`Unsupported Stripe event type: ${event.type}`);
    }
    const object = event.data?.object ?? {};
    // 防资损：checkout.session.completed 在延迟支付方式（SEPA/银行转账等）下会先以 unpaid 触发，
    // 必须校验 payment_status === "paid" 才发积分。异步支付真正到账走 async_payment_succeeded。
    // payment_intent.succeeded 本身即收款成功事件，无此字段，不参与该校验。
    if (event.type === "checkout.session.completed") {
      const paymentStatus = stringValue(object.payment_status);
      if (paymentStatus !== "paid") {
        throw new Error(`Stripe checkout session is not paid (payment_status=${paymentStatus ?? "unknown"})`);
      }
    }
    const orderId = stringValue(object.metadata?.orderId) ?? stringValue(object.client_reference_id);
    const orderNo = stringValue(object.metadata?.orderNo);
    const amountCents = numberValue(object.amount_total) ?? numberValue(object.amount_received);
    const currency = stringValue(object.currency)?.toUpperCase();
    const paymentIntentId = stringValue(object.payment_intent) ?? stringValue(object.id);
    if (!event.id || !orderId || !orderNo || amountCents === null || !currency) {
      throw new Error("Stripe webhook payload is missing order identity, amount, or currency");
    }
    return {
      provider: this.name,
      providerEventId: event.id,
      orderId,
      orderNo,
      eventType: "payment.succeeded",
      amountCents,
      currency,
      paymentIntentId
    };
  }
}

/**
 * 预留扩展接口：微信支付
 *
 * 当前发行路线只交付 mock / stripe。
 * 这个类不会由 createPaymentProvider 返回，直接启用前必须先补齐实现与测试。
 */
export class WechatPayProvider implements PaymentProvider {
  readonly name = "wechat";
  private readonly appId = requiredEnv("WECHAT_PAY_APP_ID");
  private readonly mchId = requiredEnv("WECHAT_PAY_MCH_ID");
  private readonly apiKey = requiredEnv("WECHAT_PAY_API_KEY");
  private readonly apiVersion = process.env.WECHAT_PAY_API_VERSION ?? "v3";
  private readonly notifyUrl = requiredEnv("WECHAT_PAY_NOTIFY_URL");

  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // TODO: 实现微信支付统一下单
    // V3 API 参考: https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_1_1.shtml
    throw new Error(
      "WechatPayProvider not implemented yet. Install wechatpay-node-v3 SDK:\n" +
        `  AppID: ${this.appId}, MchID: ${this.mchId}, Version: ${this.apiVersion}\n` +
        "  Reference: https://pay.weixin.qq.com/wiki/doc/apiv3/open/pay/chapter2_1.shtml"
    );
  }

  async verifyWebhook(_payload: unknown, _signature: string | undefined): Promise<VerifiedPaymentEvent> {
    // TODO: 实现微信支付回调验证
    // V3 需要验证签名和解密报文
    throw new Error(
      "WechatPayProvider webhook verification not implemented yet.\n" +
        `  Notify URL: ${this.notifyUrl}\n` +
        "  V3 signature verification: https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay4_1.shtml"
    );
  }
}

/**
 * 预留扩展接口：支付宝
 *
 * 当前发行路线只交付 mock / stripe。
 * 这个类不会由 createPaymentProvider 返回，直接启用前必须先补齐实现与测试。
 */
export class AlipayProvider implements PaymentProvider {
  readonly name = "alipay";
  private readonly appId = requiredEnv("ALIPAY_APP_ID");
  private readonly privateKey = requiredEnv("ALIPAY_PRIVATE_KEY");
  private readonly publicKey = requiredEnv("ALIPAY_PUBLIC_KEY");
  private readonly gateway = process.env.ALIPAY_GATEWAY ?? "https://openapi.alipay.com/gateway.do";
  private readonly notifyUrl = requiredEnv("ALIPAY_NOTIFY_URL");
  private readonly returnUrl = requiredEnv("ALIPAY_RETURN_URL");

  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // TODO: 实现支付宝电脑网站支付或手机网站支付
    // alipay.trade.page.pay (电脑) 或 alipay.trade.wap.pay (手机)
    throw new Error(
      "AlipayProvider not implemented yet. Install alipay-sdk:\n" +
        `  AppID: ${this.appId}, Gateway: ${this.gateway}\n` +
        `  NotifyURL: ${this.notifyUrl}, ReturnURL: ${this.returnUrl}\n` +
        "  Reference: https://opendocs.alipay.com/open/270/105898"
    );
  }

  async verifyWebhook(_payload: unknown, _signature: string | undefined): Promise<VerifiedPaymentEvent> {
    // TODO: 实现支付宝异步通知验证
    // 需要验证 RSA2 签名
    throw new Error(
      "AlipayProvider webhook verification not implemented yet.\n" +
        "  Signature algorithm: RSA2\n" +
        "  Reference: https://opendocs.alipay.com/open/270/105902"
    );
  }
}

export function createPaymentProvider(name = process.env.PAYMENT_PROVIDER ?? "mock"): PaymentProvider {
  switch (name) {
    case "mock":
      return new MockPaymentProvider();
    case "stripe":
      return new StripePaymentProvider();
    default:
      throw new Error(`Unsupported payment provider: ${name}. Implemented providers: mock, stripe`);
  }
}

interface StripeCheckoutSession {
  id?: string;
  url?: string;
  error?: { message?: string };
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: {
    object?: {
      amount_received?: unknown;
      amount_total?: unknown;
      client_reference_id?: unknown;
      currency?: unknown;
      id?: unknown;
      metadata?: Record<string, unknown>;
      payment_intent?: unknown;
      payment_status?: unknown;
    };
  };
}

function verifyStripeSignature(payload: string, header: string, secret: string): void {
  const { timestamp, signatures } = parseStripeSignatureHeader(header);
  if (!timestamp || signatures.length === 0) {
    throw new Error("Invalid Stripe signature header");
  }
  const toleranceSeconds = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? 300);
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) {
    throw new Error("Stripe webhook signature timestamp is outside tolerance");
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  if (!signatures.some((signature) => safeEqualHex(expected, signature))) {
    throw new Error("Invalid Stripe webhook signature");
  }
}

function parseStripeSignatureHeader(header: string): { timestamp?: string; signatures: string[] } {
  const result: { timestamp?: string; signatures: string[] } = { signatures: [] };
  for (const part of header.split(",")) {
    const [key, ...valueParts] = part.split("=");
    const value = valueParts.join("=").trim();
    if (key.trim() === "t") {
      result.timestamp = value;
    }
    if (key.trim() === "v1" && value) {
      result.signatures.push(value);
    }
  }
  return result;
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isMockWebhook(value: unknown): value is {
  providerEventId: string;
  orderId: string;
  orderNo: string;
  amountCents: number;
  currency: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerEventId === "string" &&
    typeof record.orderId === "string" &&
    typeof record.orderNo === "string" &&
    typeof record.amountCents === "number" &&
    typeof record.currency === "string"
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
