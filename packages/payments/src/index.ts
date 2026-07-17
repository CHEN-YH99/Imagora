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

/**
 * 主动反查一笔订单在支付方处的真实状态。
 * 用于 webhook 丢失（网络中断/重试耗尽）时的兜底对账：不依赖本地是否收到过事件，
 * 直接问支付方“这单到底付没付”。
 */
export interface RetrieveOrderPaymentInput {
  orderId: string;
  orderNo: string;
  /** 下单时 createPayment 返回的 paymentIntentId（Stripe 下即 checkout session id）。 */
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
}

export interface OrderPaymentStatus {
  /**
   * paid   -> 支付方确认已收款，可安全补发积分
   * unpaid -> 明确未支付（会话仍开放/已过期/被取消）
   * unknown-> 无法判定（缺 session id、反查失败等），调用方应保持 PENDING 不动、等下轮重试
   */
  status: "paid" | "unpaid" | "unknown";
  /** status===paid 时携带，供调用方做金额/币种/orderNo 三重校验，语义对齐 verifyWebhook。 */
  event: VerifiedPaymentEvent | null;
  /** 供日志/告警的补充说明。 */
  detail?: string;
}

/**
 * 订单退款输入。管理员发起退款时，由调用方传入订单快照关键字段。
 */
export interface RefundOrderInput {
  orderId: string;
  orderNo: string;
  /** 下单时 createPayment 返回的 paymentIntentId（Stripe 下即 checkout session id，退款前需反查真实 payment_intent）。 */
  paymentIntentId: string | null;
  /** 退款金额（分）。当前只支持全额退款，取订单原始 amountCents。 */
  amountCents: number;
  currency: string;
  /** 退款原因，透传给支付方并记入审计。 */
  reason?: string | null;
}

export interface RefundOrderResult {
  /**
   * refunded -> 支付方确认已退款，调用方可安全置 REFUNDED + 回收积分
   * failed   -> 退款失败（支付方拒绝、网络异常等），调用方必须保持订单状态不动
   */
  status: "refunded" | "failed";
  /** 支付方返回的退款单号，记入 paymentEvents 供追溯。 */
  refundId: string | null;
  /** 实际退款金额（分），正常应等于请求金额。 */
  refundedAmountCents: number | null;
  /** 供日志/告警/审计的补充说明。 */
  detail?: string;
}

export interface PaymentProvider {
  name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyWebhook(payload: unknown, signature: string | undefined): Promise<VerifiedPaymentEvent>;
  /**
   * 主动向支付方反查订单状态。webhook 丢失兜底用。
   * 实现约定：任何网络/解析异常都应捕获后返回 status:"unknown"，绝不抛错——
   * 兜底对账在后台定时器里跑，抛错会中断整轮维护。
   */
  retrieveOrderPaymentStatus(input: RetrieveOrderPaymentInput): Promise<OrderPaymentStatus>;
  /**
   * 向支付方发起退款。管理员退款路由用。
   * 实现约定：任何网络/解析异常都应捕获后返回 status:"failed"，绝不抛错——
   * 调用方拿到 failed 会保持订单状态不动（钱先退、状态后改），抛错会让路由层难以区分
   * 「已退成功但响应丢了」和「压根没退」。
   */
  refundOrder(input: RefundOrderInput): Promise<RefundOrderResult>;
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

  // 测试兜底对账用：MOCK_RECONCILE_PAID_ORDERS 里列出的 orderId（逗号分隔）会被判定为已支付。
  async retrieveOrderPaymentStatus(input: RetrieveOrderPaymentInput): Promise<OrderPaymentStatus> {
    const paidOrders = (process.env.MOCK_RECONCILE_PAID_ORDERS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!paidOrders.includes(input.orderId)) {
      return { status: "unpaid", event: null, detail: "mock order not marked paid" };
    }
    return {
      status: "paid",
      event: {
        provider: this.name,
        providerEventId: `mock_reconcile_${input.orderId}`,
        orderId: input.orderId,
        orderNo: input.orderNo,
        eventType: "payment.succeeded",
        amountCents: input.amountCents,
        currency: input.currency.toUpperCase(),
        paymentIntentId: input.paymentIntentId ?? `mock_pi_${input.orderId}`
      }
    };
  }

  // mock 退款恒成功：本地/测试环境不接支付方，管理员退款流程照样能端到端跑通。
  async refundOrder(input: RefundOrderInput): Promise<RefundOrderResult> {
    return {
      status: "refunded",
      refundId: `mock_re_${input.orderId}`,
      refundedAmountCents: input.amountCents,
      detail: "mock refund"
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

  // TODO(verify-with-live-stripe): 以下反查逻辑需用真实 STRIPE_SECRET_KEY 联网验证一次。
  // 验证方式：造一笔已支付订单，手动删掉本地对应 payment.succeeded 事件模拟 webhook 丢失，
  // 跑后台订单维护，确认能反查到 paid 并补发积分（幂等键 order-grant:{id} 保证不重复发）。
  async retrieveOrderPaymentStatus(input: RetrieveOrderPaymentInput): Promise<OrderPaymentStatus> {
    // Stripe 下 paymentIntentId 存的是 createPayment 返回的 checkout session id（见 createPayment）。
    const sessionId = input.paymentIntentId;
    if (!sessionId) {
      return { status: "unknown", event: null, detail: "missing stripe checkout session id" };
    }
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.secretKey}`
        }
      });
    } catch (error) {
      // 网络异常绝不抛出——保持 PENDING，等下一轮定时器重试。
      return {
        status: "unknown",
        event: null,
        detail: `stripe session retrieve failed: ${error instanceof Error ? error.message : "network error"}`
      };
    }
    const object = (await response.json().catch(() => ({}))) as StripeSessionRetrieveResponse;
    if (!response.ok) {
      return {
        status: "unknown",
        event: null,
        detail: object.error?.message ?? `stripe session retrieve returned ${response.status}`
      };
    }
    // 与 verifyWebhook 同款防资损校验：延迟支付方式下会话可能仍非 paid。
    const paymentStatus = stringValue(object.payment_status);
    if (paymentStatus !== "paid") {
      return {
        status: "unpaid",
        event: null,
        detail: `stripe payment_status=${paymentStatus ?? "unknown"}`
      };
    }
    const orderId = stringValue(object.metadata?.orderId) ?? stringValue(object.client_reference_id);
    const orderNo = stringValue(object.metadata?.orderNo);
    const amountCents = numberValue(object.amount_total) ?? numberValue(object.amount_received);
    const currency = stringValue(object.currency)?.toUpperCase();
    const paymentIntentId = stringValue(object.payment_intent) ?? sessionId;
    if (!orderId || !orderNo || amountCents === null || !currency) {
      return {
        status: "unknown",
        event: null,
        detail: "stripe session missing order identity, amount, or currency"
      };
    }
    // providerEventId 用 session id 派生一个稳定值，供上层按 provider+eventId 幂等去重，
    // 避免与真实 webhook 事件 id 冲突时重复入账。
    return {
      status: "paid",
      event: {
        provider: this.name,
        providerEventId: `reconcile_${sessionId}`,
        orderId,
        orderNo,
        eventType: "payment.succeeded",
        amountCents,
        currency,
        paymentIntentId
      }
    };
  }

  // TODO(verify-with-live-stripe): 以下退款逻辑需用真实 STRIPE_SECRET_KEY 联网验证一次。
  // 验证方式：造一笔已支付订单，走 admin 退款路由，确认 Stripe 侧真实退款成功、
  // 订单转 REFUNDED、积分被回收（幂等键 order-refund:{id} 保证不重复回收）。
  async refundOrder(input: RefundOrderInput): Promise<RefundOrderResult> {
    // Stripe 下 paymentIntentId 存的是 createPayment 返回的 checkout session id（见 createPayment），
    // 退款接口要的是真实 payment_intent，需先反查 session 拿到它。
    const sessionId = input.paymentIntentId;
    if (!sessionId) {
      return {
        status: "failed",
        refundId: null,
        refundedAmountCents: null,
        detail: "missing stripe checkout session id"
      };
    }

    let paymentIntent: string | null;
    try {
      paymentIntent = await this.resolvePaymentIntentId(sessionId);
    } catch (error) {
      return {
        status: "failed",
        refundId: null,
        refundedAmountCents: null,
        detail: `stripe session retrieve failed: ${error instanceof Error ? error.message : "network error"}`
      };
    }
    if (!paymentIntent) {
      return {
        status: "failed",
        refundId: null,
        refundedAmountCents: null,
        detail: "stripe session has no payment_intent (session may be unpaid or expired)"
      };
    }

    // 幂等：以订单号派生 Idempotency-Key，Stripe 侧对同一 key 的重复退款请求只执行一次，
    // 双保险叠加上层 applyPaymentRefunded 的账本幂等（order-refund:{id}）。
    const body = new URLSearchParams({
      payment_intent: paymentIntent,
      amount: String(input.amountCents),
      "metadata[orderId]": input.orderId,
      "metadata[orderNo]": input.orderNo
    });
    if (input.reason) {
      body.set("metadata[reason]", input.reason);
    }

    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/v1/refunds`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `refund_${input.orderNo}`
        },
        body
      });
    } catch (error) {
      // 网络异常绝不抛出——返回 failed，调用方保持订单状态不动。
      return {
        status: "failed",
        refundId: null,
        refundedAmountCents: null,
        detail: `stripe refund request failed: ${error instanceof Error ? error.message : "network error"}`
      };
    }

    const payload = (await response.json().catch(() => ({}))) as StripeRefundResponse;
    if (!response.ok) {
      return {
        status: "failed",
        refundId: null,
        refundedAmountCents: null,
        detail: payload.error?.message ?? `stripe refund returned ${response.status}`
      };
    }
    // Stripe refund 成功后 status 为 succeeded / pending（银行渠道异步到账），两者都视为已受理；
    // failed / canceled 视为退款失败。
    const refundStatus = stringValue(payload.status);
    if (refundStatus !== "succeeded" && refundStatus !== "pending") {
      return {
        status: "failed",
        refundId: stringValue(payload.id),
        refundedAmountCents: null,
        detail: `stripe refund status=${refundStatus ?? "unknown"}`
      };
    }
    return {
      status: "refunded",
      refundId: stringValue(payload.id),
      refundedAmountCents: numberValue(payload.amount) ?? input.amountCents,
      detail: `stripe refund ${refundStatus}`
    };
  }

  // 反查 checkout session 拿真实 payment_intent。网络/HTTP 异常抛出，由 refundOrder 捕获转 failed。
  private async resolvePaymentIntentId(sessionId: string): Promise<string | null> {
    const response = await fetch(`${this.apiBaseUrl}/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.secretKey}`
      }
    });
    const object = (await response.json().catch(() => ({}))) as StripeSessionRetrieveResponse;
    if (!response.ok) {
      throw new Error(object.error?.message ?? `stripe session retrieve returned ${response.status}`);
    }
    return stringValue(object.payment_intent);
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

  async retrieveOrderPaymentStatus(_input: RetrieveOrderPaymentInput): Promise<OrderPaymentStatus> {
    // TODO: 实现微信支付订单查询 GET /v3/pay/transactions/out-trade-no/{out_trade_no}
    throw new Error("WechatPayProvider order status query not implemented yet.");
  }

  async refundOrder(_input: RefundOrderInput): Promise<RefundOrderResult> {
    // TODO: 实现微信支付退款 POST /v3/refund/domestic/refunds
    throw new Error("WechatPayProvider refund not implemented yet.");
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

  async retrieveOrderPaymentStatus(_input: RetrieveOrderPaymentInput): Promise<OrderPaymentStatus> {
    // TODO: 实现支付宝交易查询 alipay.trade.query
    throw new Error("AlipayProvider order status query not implemented yet.");
  }

  async refundOrder(_input: RefundOrderInput): Promise<RefundOrderResult> {
    // TODO: 实现支付宝退款 alipay.trade.refund
    throw new Error("AlipayProvider refund not implemented yet.");
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

interface StripeSessionRetrieveResponse {
  error?: { message?: string };
  payment_status?: unknown;
  metadata?: Record<string, unknown>;
  client_reference_id?: unknown;
  amount_total?: unknown;
  amount_received?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
}

interface StripeRefundResponse {
  error?: { message?: string };
  id?: unknown;
  status?: unknown;
  amount?: unknown;
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
