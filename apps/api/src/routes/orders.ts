import type { VerifiedPaymentEvent } from "@imagora/payments";
import type { Order } from "@imagora/shared";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerOrderRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    AppError,
    applyPaymentSucceeded,
    assertFeatureEnabled,
    assertMockPaymentAllowed,
    assertPaymentProviderEnabled,
    createOrderSchema,
    descCreated,
    envelope,
    ensureCheckoutUrl,
    findCheckoutUrl,
    findOrderByClientRequestId,
    mustFindCreditAccount,
    mustFindOwnOrder,
    optionalPaginationSchema,
    orderParamSchema,
    payloadRecord,
    paymentProvider,
    paymentWebhookParamSchema,
    randomUUID,
    requireAuth,
    routeLabel,
    runOrderMaintenance,
    store,
    webhookSignature
  } = context;

  app.get("/api/plans", async (request) => {
    const data = await store.read();
    return envelope(request, {
      plans: data.plans.filter((plan) => plan.status === "ACTIVE").sort((a, b) => a.sortOrder - b.sortOrder)
    });
  });

  app.post("/api/orders", async (request, reply) => {
    assertFeatureEnabled("payments");
    const { user } = await requireAuth(request);
    const input = createOrderSchema.parse(request.body);
    assertPaymentProviderEnabled(input.paymentProvider);
    return store.update(async (data) => {
      runOrderMaintenance(data);
      const duplicate = input.clientRequestId ? findOrderByClientRequestId(data, user.id, input.clientRequestId) : null;
      if (duplicate) {
        if (duplicate.planId !== input.planId || duplicate.paymentProvider !== input.paymentProvider) {
          throw new AppError("CONFLICT", "clientRequestId has already been used for another order", 409);
        }
        const duplicatePlan = data.plans.find((item) => item.id === duplicate.planId);
        if (!duplicatePlan) {
          throw new AppError("PLAN_UNAVAILABLE", "Plan is not available", 404);
        }
        return envelope(request, {
          order: duplicate,
          plan: duplicatePlan,
          checkoutUrl: findCheckoutUrl(data, duplicate)
        });
      }
      const plan = data.plans.find((item) => item.id === input.planId && item.status === "ACTIVE");
      if (!plan) {
        throw new AppError("PLAN_UNAVAILABLE", "Plan is not available", 404);
      }
      const now = new Date().toISOString();
      const order: Order = {
        id: randomUUID(),
        userId: user.id,
        planId: plan.id,
        orderNo: `IM${Date.now()}${Math.floor(Math.random() * 900 + 100)}`,
        amountCents: plan.priceCents,
        currency: plan.currency,
        paymentProvider: input.paymentProvider,
        paymentIntentId: null,
        status: "PENDING",
        paidAt: null,
        createdAt: now,
        updatedAt: now
      };
      let checkoutUrl: string | null = null;
      if (input.paymentProvider === paymentProvider.name) {
        const payment = await paymentProvider.createPayment({
          orderId: order.id,
          orderNo: order.orderNo,
          amountCents: order.amountCents,
          currency: order.currency
        });
        order.paymentIntentId = payment.paymentIntentId;
        checkoutUrl = payment.checkoutUrl;
        data.paymentEvents.push({
          id: randomUUID(),
          provider: payment.provider,
          providerEventId: `checkout:${payment.paymentIntentId}`,
          orderId: order.id,
          eventType: "checkout.created",
          payload: {
            checkoutUrl: payment.checkoutUrl,
            paymentIntentId: payment.paymentIntentId,
            orderId: order.id,
            orderNo: order.orderNo,
            amountCents: order.amountCents,
            currency: order.currency,
            clientRequestId: input.clientRequestId ?? null
          },
          processedAt: now,
          createdAt: now
        });
      }
      data.orders.push(order);
      reply.status(201);
      return envelope(request, { order, plan, checkoutUrl });
    });
  });

  app.get("/api/orders", async (request) => {
    const { user } = await requireAuth(request);
    return store.update((data) => {
      const maintenance = runOrderMaintenance(data);
      const query = optionalPaginationSchema.parse(request.query);
      const orders = data.orders
        .filter((order) => order.userId === user.id)
        .sort(descCreated)
        .slice(0, query.limit ?? Number.POSITIVE_INFINITY);
      return envelope(request, { orders, maintenance });
    });
  });

  app.get("/api/orders/:orderId", async (request) => {
    const { user } = await requireAuth(request);
    const { orderId } = orderParamSchema.parse(request.params);
    return store.update((data) => {
      const maintenance = runOrderMaintenance(data);
      const order = mustFindOwnOrder(data, user.id, orderId);
      const plan = data.plans.find((item) => item.id === order.planId);
      return envelope(request, { order, plan, maintenance });
    });
  });

  app.post("/api/orders/:orderId/pay", async (request) => {
    assertFeatureEnabled("payments");
    const { user } = await requireAuth(request);
    const { orderId } = orderParamSchema.parse(request.params);
    return store.update(async (data) => {
      runOrderMaintenance(data);
      const order = mustFindOwnOrder(data, user.id, orderId);
      if (order.status === "PAID") {
        return envelope(request, {
          order,
          balanceAfter: mustFindCreditAccount(data, user.id).balance,
          checkoutUrl: null
        });
      }
      if (order.status !== "PENDING") {
        throw new AppError("ORDER_NOT_PAYABLE", "Order is not payable", 400);
      }
      if (order.paymentProvider !== paymentProvider.name) {
        throw new AppError("VALIDATION_ERROR", "Payment provider is not enabled", 400);
      }
      if (order.paymentProvider !== "mock") {
        const checkoutUrl = await ensureCheckoutUrl(data, order);
        return envelope(request, { order, checkoutUrl });
      }
      assertMockPaymentAllowed();
      const result = applyPaymentSucceeded(data, {
        provider: order.paymentProvider,
        providerEventId: `mock:${order.id}:paid`,
        orderId: order.id,
        orderNo: order.orderNo,
        eventType: "payment.succeeded",
        amountCents: order.amountCents,
        currency: order.currency,
        paymentIntentId: order.paymentIntentId,
        requestId: request.requestId ?? null,
        route: routeLabel(request),
        payload: {
          mock: true,
          orderId: order.id,
          orderNo: order.orderNo,
          amountCents: order.amountCents,
          currency: order.currency
        }
      });
      return envelope(request, { order: result.order, balanceAfter: result.balanceAfter, checkoutUrl: null });
    });
  });

  app.post("/api/payments/webhooks/:provider", async (request) => {
    const { provider } = paymentWebhookParamSchema.parse(request.params);
    if (provider === "mock") {
      assertMockPaymentAllowed();
    }
    if (provider !== paymentProvider.name) {
      throw new AppError("VALIDATION_ERROR", "Payment provider is not enabled", 400);
    }

    let event: VerifiedPaymentEvent;
    try {
      event = await paymentProvider.verifyWebhook(request.body, webhookSignature(request));
    } catch (error) {
      throw new AppError(
        "VALIDATION_ERROR",
        error instanceof Error ? error.message : "Invalid payment webhook payload",
        400
      );
    }

    return store.update((data) => {
      const result = applyPaymentSucceeded(data, {
        provider: event.provider,
        providerEventId: event.providerEventId,
        orderId: event.orderId,
        orderNo: event.orderNo,
        eventType: event.eventType,
        amountCents: event.amountCents,
        currency: event.currency,
        paymentIntentId: event.paymentIntentId,
        requestId: request.requestId ?? null,
        route: routeLabel(request),
        payload: payloadRecord(request.body)
      });
      return envelope(request, result);
    });
  });
}
