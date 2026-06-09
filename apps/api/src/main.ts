import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import { createStore, hashPassword, verifyPassword, withoutPassword } from "@imagora/database";
import { createPaymentProvider } from "@imagora/payments";
import { createGenerationQueue } from "@imagora/queue";
import { createSafetyProvider } from "@imagora/safety";
import {
  AppError,
  type AdminAuditLog,
  type ApiEnvelope,
  type AspectRatio,
  aspectRatioDimensions,
  calculateCreditCost,
  type GeneratedImage,
  type GenerationTask,
  maxPromptLength,
  maxQuantity,
  type Order,
  type Plan,
  publicUser,
  type Quality,
  type SourceType,
  type StoreData,
  type StyleId,
  type User,
  type SafetyRule
} from "@imagora/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

const store = createStore();
const safetyProvider = createSafetyProvider();
const paymentProvider = createPaymentProvider();
const generationQueue = createGenerationQueue();
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true,
  credentials: true
});

app.addHook("onRequest", async (request) => {
  request.requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
});

app.setErrorHandler((error, request, reply) => {
  const requestId = request.requestId ?? randomUUID();
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
      requestId
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: "Invalid request payload", details: error.flatten() },
      requestId
    });
  }
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Request failed";
    return reply.status(statusCode).send({
      error: { code: statusCode === 401 ? "UNAUTHORIZED" : "VALIDATION_ERROR", message },
      requestId
    });
  }
  request.log.error(error);
  return reply.status(500).send({
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    requestId
  });
});

app.get("/health", async () => ({
  status: "ok",
  service: "imagora-api",
  time: new Date().toISOString()
}));

app.post("/api/auth/register", async (request, reply) => {
  const input = registerSchema.parse(request.body);
  return store.update(async (data) => {
    const email = input.email.toLowerCase();
    if (data.users.some((user) => user.email === email)) {
      throw new AppError("CONFLICT", "Email is already registered", 409);
    }
    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      email,
      passwordHash: hashPassword(input.password),
      nickname: input.nickname ?? email.split("@")[0] ?? "Creator",
      avatarUrl: null,
      role: "USER",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now
    };
    const token = randomUUID();
    data.users.push(user);
    data.sessions.push({ token, userId: user.id, createdAt: now, expiresAt: addDays(now, 14) });
    data.creditAccounts.push({ userId: user.id, balance: 120, totalEarned: 120, totalSpent: 0, updatedAt: now });
    data.creditLedgerEntries.push({
      id: randomUUID(),
      userId: user.id,
      type: "GRANT",
      amount: 120,
      balanceAfter: 120,
      sourceType: "SYSTEM",
      sourceId: "welcome",
      idempotencyKey: `welcome:${user.id}`,
      remark: "Welcome credits",
      createdAt: now
    });
    reply.status(201);
    return envelope(request, { token, user: publicUser(user) });
  });
});

app.post("/api/auth/login", async (request) => {
  const input = loginSchema.parse(request.body);
  return store.update(async (data) => {
    const user = data.users.find((item) => item.email === input.email.toLowerCase());
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new AppError("UNAUTHORIZED", "Invalid email or password", 401);
    }
    if (user.status !== "ACTIVE") {
      throw new AppError("FORBIDDEN", "User is not active", 403);
    }
    const now = new Date().toISOString();
    const token = randomUUID();
    user.lastLoginAt = now;
    user.updatedAt = now;
    data.sessions.push({ token, userId: user.id, createdAt: now, expiresAt: addDays(now, 14) });
    return envelope(request, { token, user: publicUser(user) });
  });
});

app.post("/api/auth/logout", async (request) => {
  const token = bearerToken(request);
  await store.update((data) => {
    data.sessions = data.sessions.filter((session) => session.token !== token);
  });
  return envelope(request, { ok: true });
});

app.get("/api/auth/me", async (request) => {
  const { user } = await requireAuth(request);
  return envelope(request, { user: publicUser(user) });
});

app.get("/api/users/me", async (request) => {
  const { user } = await requireAuth(request);
  return envelope(request, { user: publicUser(user) });
});

app.patch("/api/users/me", async (request) => {
  const { user } = await requireAuth(request);
  const input = updateProfileSchema.parse(request.body);
  return store.update(async (data) => {
    const current = mustFindUser(data, user.id);
    current.nickname = input.nickname ?? current.nickname;
    current.avatarUrl = input.avatarUrl ?? current.avatarUrl;
    current.updatedAt = new Date().toISOString();
    return envelope(request, { user: publicUser(current) });
  });
});

app.get("/api/users/me/credits", async (request) => {
  const { user, data } = await requireAuth(request);
  const account = mustFindCreditAccount(data, user.id);
  return envelope(request, { account });
});

app.get("/api/users/me/credit-ledger", async (request) => {
  const { user, data } = await requireAuth(request);
  const query = paginationSchema.parse(request.query);
  const entries = data.creditLedgerEntries
    .filter((entry) => entry.userId === user.id)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { entries });
});

app.post("/api/generation/quote", async (request) => {
  await requireAuth(request);
  const input = generationInputSchema.parse(request.body);
  return envelope(request, { creditCost: quote(input), balanceRequired: quote(input) });
});

app.post("/api/generation/tasks", async (request, reply) => {
  const { user } = await requireAuth(request);
  const input = generationInputSchema.parse(request.body);
  const result = await store.update(async (data) => {
    const duplicate = data.generationTasks.find(
      (task) => task.userId === user.id && task.clientRequestId === input.clientRequestId
    );
    if (duplicate) {
      return {
        task: duplicate,
        balanceAfter: mustFindCreditAccount(data, user.id).balance,
        enqueue: false,
        requestedAt: duplicate.createdAt
      };
    }
    const safety = await safetyProvider.checkText({
      text: [input.prompt, input.negativePrompt ?? ""].join("\n"),
      blockedTerms: data.safetyRules
        .filter((rule) => rule.status === "ACTIVE" && rule.action === "BLOCK")
        .map((rule) => rule.term)
    });
    if (safety.status === "BLOCKED") {
      data.safetyEvents.push({
        id: randomUUID(),
        userId: user.id,
        targetType: "PROMPT",
        targetId: input.clientRequestId,
        status: "BLOCKED",
        reasonCode: safety.reasonCode,
        reasonMessage: safety.reasonMessage,
        provider: safety.provider,
        createdAt: new Date().toISOString()
      });
      throw new AppError("CONTENT_BLOCKED", "Prompt was blocked by safety rules", 400, { ...safety });
    }
    const cost = quote(input);
    const account = mustFindCreditAccount(data, user.id);
    if (account.balance < cost) {
      throw new AppError("INSUFFICIENT_CREDITS", "Credit balance is not enough", 402, {
        balance: account.balance,
        required: cost
      });
    }
    const now = new Date().toISOString();
    const dimension = aspectRatioDimensions[input.aspectRatio];
    const task: GenerationTask = {
      id: randomUUID(),
      userId: user.id,
      clientRequestId: input.clientRequestId,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt ?? null,
      style: input.style,
      aspectRatio: input.aspectRatio,
      width: dimension.width,
      height: dimension.height,
      quantity: input.quantity,
      quality: input.quality,
      modelProvider: "mock",
      modelName: "imagora-mock-v1",
      status: "PENDING",
      creditCost: cost,
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };
    data.generationTasks.push(task);
    spendCredits(data, user.id, cost, "TASK", task.id, `task-spend:${task.id}`, "Image generation task");
    return {
      task,
      balanceAfter: mustFindCreditAccount(data, user.id).balance,
      enqueue: true,
      requestedAt: now
    };
  });
  if (result.enqueue) {
    await generationQueue.enqueueGenerationTask({ taskId: result.task.id, userId: user.id, requestedAt: result.requestedAt });
    reply.status(201);
  }
  return envelope(request, { task: result.task, balanceAfter: result.balanceAfter });
});

app.get("/api/generation/tasks", async (request) => {
  const { user, data } = await requireAuth(request);
  const query = taskQuerySchema.parse(request.query);
  const tasks = data.generationTasks
    .filter((task) => task.userId === user.id)
    .filter((task) => (query.status ? task.status === query.status : true))
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { tasks });
});

app.get("/api/generation/tasks/:taskId", async (request) => {
  const { user, data } = await requireAuth(request);
  const { taskId } = idParamSchema.parse(request.params);
  const task = mustFindOwnTask(data, user.id, taskId);
  const images = data.generatedImages.filter((image) => image.taskId === task.id && !image.deletedAt);
  return envelope(request, { task, images });
});

app.post("/api/generation/tasks/:taskId/retry", async (request, reply) => {
  const { user } = await requireAuth(request);
  const { taskId } = idParamSchema.parse(request.params);
  const result = await store.update(async (data) => {
    const previous = mustFindOwnTask(data, user.id, taskId);
    if (!["FAILED", "BLOCKED"].includes(previous.status)) {
      throw new AppError("TASK_NOT_RETRYABLE", "Only failed or blocked tasks can be retried", 400);
    }
    const now = new Date().toISOString();
    const task: GenerationTask = {
      ...previous,
      id: randomUUID(),
      clientRequestId: `retry:${previous.id}:${now}`,
      status: "PENDING",
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };
    const account = mustFindCreditAccount(data, user.id);
    if (account.balance < task.creditCost) {
      throw new AppError("INSUFFICIENT_CREDITS", "Credit balance is not enough", 402);
    }
    data.generationTasks.push(task);
    spendCredits(data, user.id, task.creditCost, "TASK", task.id, `task-spend:${task.id}`, "Retry image generation task");
    return { task, balanceAfter: mustFindCreditAccount(data, user.id).balance };
  });
  await generationQueue.enqueueGenerationTask({
    taskId: result.task.id,
    userId: user.id,
    requestedAt: result.task.createdAt
  });
  reply.status(201);
  return envelope(request, { task: result.task, balanceAfter: result.balanceAfter });
});

app.get("/api/images", async (request) => {
  const { user, data } = await requireAuth(request);
  const query = paginationSchema.parse(request.query);
  const images = data.generatedImages
    .filter((image) => image.userId === user.id && !image.deletedAt && image.visibility !== "HIDDEN")
    .sort(descCreated)
    .slice(0, query.limit)
    .map((image) => withFavorite(data, user.id, image));
  return envelope(request, { images });
});

app.get("/api/images/:imageId", async (request) => {
  const { user, data } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const image = mustFindOwnImage(data, user.id, imageId);
  const task = data.generationTasks.find((item) => item.id === image.taskId);
  return envelope(request, { image: withFavorite(data, user.id, image), task });
});

app.post("/api/images/:imageId/favorite", async (request) => {
  const { user } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  return store.update(async (data) => {
    mustFindOwnImage(data, user.id, imageId);
    if (!data.imageFavorites.some((favorite) => favorite.userId === user.id && favorite.imageId === imageId)) {
      data.imageFavorites.push({ userId: user.id, imageId, createdAt: new Date().toISOString() });
    }
    return envelope(request, { imageId, favorite: true });
  });
});

app.delete("/api/images/:imageId/favorite", async (request) => {
  const { user } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  return store.update((data) => {
    data.imageFavorites = data.imageFavorites.filter(
      (favorite) => !(favorite.userId === user.id && favorite.imageId === imageId)
    );
    return envelope(request, { imageId, favorite: false });
  });
});

app.post("/api/images/:imageId/download-url", async (request) => {
  const { user, data } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const image = mustFindOwnImage(data, user.id, imageId);
  return envelope(request, { url: image.publicUrl, expiresAt: addMinutes(new Date().toISOString(), 15) });
});

app.delete("/api/images/:imageId", async (request) => {
  const { user } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  return store.update((data) => {
    const image = mustFindOwnImage(data, user.id, imageId);
    image.deletedAt = new Date().toISOString();
    return envelope(request, { imageId, deleted: true });
  });
});

app.get("/api/plans", async (request) => {
  const data = await store.read();
  return envelope(request, { plans: data.plans.filter((plan) => plan.status === "ACTIVE").sort((a, b) => a.sortOrder - b.sortOrder) });
});

app.post("/api/orders", async (request, reply) => {
  const { user } = await requireAuth(request);
  const input = createOrderSchema.parse(request.body);
  return store.update(async (data) => {
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
    if (input.paymentProvider === paymentProvider.name) {
      const payment = await paymentProvider.createPayment({
        orderId: order.id,
        orderNo: order.orderNo,
        amountCents: order.amountCents,
        currency: order.currency
      });
      order.paymentIntentId = payment.paymentIntentId;
    }
    data.orders.push(order);
    reply.status(201);
    return envelope(request, { order, plan });
  });
});

app.get("/api/orders", async (request) => {
  const { user, data } = await requireAuth(request);
  const orders = data.orders.filter((order) => order.userId === user.id).sort(descCreated);
  return envelope(request, { orders });
});

app.get("/api/orders/:orderId", async (request) => {
  const { user, data } = await requireAuth(request);
  const { orderId } = orderParamSchema.parse(request.params);
  const order = mustFindOwnOrder(data, user.id, orderId);
  const plan = data.plans.find((item) => item.id === order.planId);
  return envelope(request, { order, plan });
});

app.post("/api/orders/:orderId/pay", async (request) => {
  const { user } = await requireAuth(request);
  const { orderId } = orderParamSchema.parse(request.params);
  return store.update((data) => {
    const order = mustFindOwnOrder(data, user.id, orderId);
    if (order.status !== "PENDING") {
      throw new AppError("ORDER_NOT_PAYABLE", "Order is not payable", 400);
    }
    const plan = data.plans.find((item) => item.id === order.planId);
    if (!plan) {
      throw new AppError("PLAN_UNAVAILABLE", "Plan is not available", 404);
    }
    const now = new Date().toISOString();
    const providerEventId = `mock:${order.id}:paid`;
    if (!data.paymentEvents.some((event) => event.providerEventId === providerEventId)) {
      order.status = "PAID";
      order.paymentIntentId = order.paymentIntentId ?? `mock_pi_${order.id}`;
      order.paidAt = now;
      order.updatedAt = now;
      data.paymentEvents.push({
        id: randomUUID(),
        provider: order.paymentProvider,
        providerEventId,
        orderId: order.id,
        eventType: "payment.succeeded",
        payload: { mock: true, amountCents: order.amountCents },
        processedAt: now,
        createdAt: now
      });
      grantCredits(data, user.id, plan.credits, "ORDER", order.id, `order-grant:${order.id}`, `Purchased ${plan.name}`);
    }
    return envelope(request, { order, balanceAfter: mustFindCreditAccount(data, user.id).balance });
  });
});

app.get("/api/admin/dashboard", async (request) => {
  const { data } = await requireAdmin(request);
  const paidRevenueCents = data.orders
    .filter((order) => order.status === "PAID")
    .reduce((sum, order) => sum + order.amountCents, 0);
  return envelope(request, {
    metrics: {
      users: data.users.length,
      tasks: data.generationTasks.length,
      images: data.generatedImages.length,
      paidOrders: data.orders.filter((order) => order.status === "PAID").length,
      paidRevenueCents,
      blockedSafetyEvents: data.safetyEvents.filter((event) => event.status === "BLOCKED").length
    }
  });
});

app.get("/api/admin/users", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { users: data.users.map(withoutPassword) });
});

app.patch("/api/admin/users/:userId/status", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { userId } = userParamSchema.parse(request.params);
  const input = statusSchema.parse(request.body);
  return store.update((data) => {
    const target = mustFindUser(data, userId);
    if (target.id === admin.id) {
      throw new AppError("VALIDATION_ERROR", "Admin cannot change own status here", 400);
    }
    const before = { status: target.status };
    target.status = input.status;
    target.updatedAt = new Date().toISOString();
    audit(data, admin.id, "user.status.update", "USER", target.id, before, { status: target.status }, request);
    return envelope(request, { user: withoutPassword(target) });
  });
});

app.post("/api/admin/users/:userId/credits/adjust", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { userId } = userParamSchema.parse(request.params);
  const input = adjustCreditSchema.parse(request.body);
  return store.update((data) => {
    mustFindUser(data, userId);
    const account = mustFindCreditAccount(data, userId);
    const before = { balance: account.balance };
    if (input.amount >= 0) {
      grantCredits(data, userId, input.amount, "ADMIN", admin.id, `admin-adjust:${randomUUID()}`, input.reason);
    } else {
      spendCredits(data, userId, Math.abs(input.amount), "ADMIN", admin.id, `admin-adjust:${randomUUID()}`, input.reason);
    }
    audit(data, admin.id, "user.credits.adjust", "USER", userId, before, { balance: account.balance }, request);
    return envelope(request, { account });
  });
});

app.get("/api/admin/generation/tasks", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { tasks: data.generationTasks.sort(descCreated) });
});

app.get("/api/admin/images", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { images: data.generatedImages.sort(descCreated) });
});

app.patch("/api/admin/images/:imageId/visibility", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const input = visibilitySchema.parse(request.body);
  return store.update((data) => {
    const image = data.generatedImages.find((item) => item.id === imageId);
    if (!image) {
      throw new AppError("NOT_FOUND", "Image was not found", 404);
    }
    const before = { visibility: image.visibility };
    image.visibility = input.visibility;
    audit(data, admin.id, "image.visibility.update", "IMAGE", image.id, before, { visibility: image.visibility }, request);
    return envelope(request, { image });
  });
});

app.get("/api/admin/orders", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { orders: data.orders.sort(descCreated) });
});

app.get("/api/admin/plans", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { plans: data.plans.sort((a, b) => a.sortOrder - b.sortOrder) });
});

app.post("/api/admin/plans", async (request, reply) => {
  const { user: admin } = await requireAdmin(request);
  const input = planSchema.parse(request.body);
  return store.update((data) => {
    const now = new Date().toISOString();
    const plan: Plan = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    data.plans.push(plan);
    audit(data, admin.id, "plan.create", "PLAN", plan.id, null, plan as unknown as Record<string, unknown>, request);
    reply.status(201);
    return envelope(request, { plan });
  });
});

app.patch("/api/admin/plans/:planId", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { planId } = planParamSchema.parse(request.params);
  const input = planPatchSchema.parse(request.body);
  return store.update((data) => {
    const plan = data.plans.find((item) => item.id === planId);
    if (!plan) {
      throw new AppError("NOT_FOUND", "Plan was not found", 404);
    }
    const before = { ...plan };
    Object.assign(plan, input, { updatedAt: new Date().toISOString() });
    audit(data, admin.id, "plan.update", "PLAN", plan.id, before, plan as unknown as Record<string, unknown>, request);
    return envelope(request, { plan });
  });
});

app.get("/api/admin/audit-logs", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { logs: data.adminAuditLogs.sort(descCreated) });
});

app.get("/api/admin/safety-rules", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { rules: data.safetyRules.sort(descCreated) });
});

app.post("/api/admin/safety-rules", async (request, reply) => {
  const { user: admin } = await requireAdmin(request);
  const input = safetyRuleSchema.parse(request.body);
  return store.update((data) => {
    const now = new Date().toISOString();
    const rule: SafetyRule = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now
    };
    data.safetyRules.push(rule);
    audit(data, admin.id, "safety-rule.create", "SAFETY_RULE", rule.id, null, { ...rule }, request);
    reply.status(201);
    return envelope(request, { rule });
  });
});

app.patch("/api/admin/safety-rules/:ruleId", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { ruleId } = safetyRuleParamSchema.parse(request.params);
  const input = safetyRulePatchSchema.parse(request.body);
  return store.update((data) => {
    const rule = data.safetyRules.find((item) => item.id === ruleId);
    if (!rule) {
      throw new AppError("NOT_FOUND", "Safety rule was not found", 404);
    }
    const before = { ...rule };
    Object.assign(rule, input, { updatedAt: new Date().toISOString() });
    audit(data, admin.id, "safety-rule.update", "SAFETY_RULE", rule.id, before, { ...rule }, request);
    return envelope(request, { rule });
  });
});

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "127.0.0.1";
await app.listen({ port, host });

declare module "fastify" {
  interface FastifyRequest {
    requestId?: string;
  }
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  nickname: z.string().min(1).max(80).optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional()
});

const generationInputSchema = z.object({
  clientRequestId: z.string().min(8).max(120).default(() => randomUUID()),
  prompt: z.string().min(1).max(maxPromptLength),
  negativePrompt: z.string().max(800).optional(),
  style: z.enum(["realistic", "illustration", "anime", "product_photography", "poster"]),
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]),
  quantity: z.number().int().min(1).max(maxQuantity),
  quality: z.enum(["draft", "standard", "high"])
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const taskQuerySchema = paginationSchema.extend({
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "BLOCKED"]).optional()
});

const idParamSchema = z.object({ taskId: z.string().min(1) });
const imageParamSchema = z.object({ imageId: z.string().min(1) });
const orderParamSchema = z.object({ orderId: z.string().min(1) });
const userParamSchema = z.object({ userId: z.string().min(1) });
const planParamSchema = z.object({ planId: z.string().min(1) });

const createOrderSchema = z.object({
  planId: z.string().min(1),
  paymentProvider: z.enum(["mock", "stripe", "wechat", "alipay"]).default("mock")
});

const statusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]) });
const visibilitySchema = z.object({ visibility: z.enum(["PRIVATE", "PUBLIC", "HIDDEN"]) });
const adjustCreditSchema = z.object({
  amount: z.number().int().refine((value) => value !== 0),
  reason: z.string().min(3).max(240)
});
const planSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  priceCents: z.number().int().min(0),
  currency: z.string().min(3).max(3),
  credits: z.number().int().min(1),
  validDays: z.number().int().min(1).nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  sortOrder: z.number().int()
});
const planPatchSchema = planSchema.partial();
const safetyRuleParamSchema = z.object({ ruleId: z.string().min(1) });
const safetyRuleSchema = z.object({
  term: z.string().min(2).max(120),
  action: z.enum(["BLOCK", "REVIEW"]),
  status: z.enum(["ACTIVE", "INACTIVE"])
});
const safetyRulePatchSchema = safetyRuleSchema.partial();

function envelope<T>(request: FastifyRequest, data: T): ApiEnvelope<T> {
  return { data, requestId: request.requestId ?? randomUUID() };
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError("UNAUTHORIZED", "Missing bearer token", 401);
  }
  return authorization.slice("Bearer ".length);
}

async function requireAuth(request: FastifyRequest): Promise<{ data: StoreData; user: User }> {
  const token = bearerToken(request);
  const data = await store.read();
  const now = new Date();
  data.sessions = data.sessions.filter((session) => new Date(session.expiresAt) > now);
  const session = data.sessions.find((item) => item.token === token);
  if (!session) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired session", 401);
  }
  const user = data.users.find((item) => item.id === session.userId);
  if (!user || user.status !== "ACTIVE") {
    throw new AppError("FORBIDDEN", "User is not active", 403);
  }
  return { data, user };
}

async function requireAdmin(request: FastifyRequest): Promise<{ data: StoreData; user: User }> {
  const session = await requireAuth(request);
  if (session.user.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "Admin role is required", 403);
  }
  return session;
}

function quote(input: { style: StyleId; quality: Quality; quantity: number; aspectRatio: AspectRatio }): number {
  return calculateCreditCost(input);
}

function mustFindUser(data: StoreData, userId: string): User {
  const user = data.users.find((item) => item.id === userId);
  if (!user) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }
  return user;
}

function mustFindCreditAccount(data: StoreData, userId: string) {
  const account = data.creditAccounts.find((item) => item.userId === userId);
  if (!account) {
    throw new AppError("NOT_FOUND", "Credit account was not found", 404);
  }
  return account;
}

function mustFindOwnTask(data: StoreData, userId: string, taskId: string): GenerationTask {
  const task = data.generationTasks.find((item) => item.id === taskId && item.userId === userId);
  if (!task) {
    throw new AppError("NOT_FOUND", "Task was not found", 404);
  }
  return task;
}

function mustFindOwnImage(data: StoreData, userId: string, imageId: string): GeneratedImage {
  const image = data.generatedImages.find((item) => item.id === imageId && item.userId === userId && !item.deletedAt);
  if (!image) {
    throw new AppError("NOT_FOUND", "Image was not found", 404);
  }
  return image;
}

function mustFindOwnOrder(data: StoreData, userId: string, orderId: string): Order {
  const order = data.orders.find((item) => item.id === orderId && item.userId === userId);
  if (!order) {
    throw new AppError("NOT_FOUND", "Order was not found", 404);
  }
  return order;
}

function spendCredits(
  data: StoreData,
  userId: string,
  amount: number,
  sourceType: SourceType,
  sourceId: string,
  idempotencyKey: string,
  remark: string
): void {
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return;
  }
  const account = mustFindCreditAccount(data, userId);
  if (account.balance < amount) {
    throw new AppError("INSUFFICIENT_CREDITS", "Credit balance is not enough", 402);
  }
  const now = new Date().toISOString();
  account.balance -= amount;
  account.totalSpent += amount;
  account.updatedAt = now;
  data.creditLedgerEntries.push({
    id: randomUUID(),
    userId,
    type: "SPEND",
    amount: -amount,
    balanceAfter: account.balance,
    sourceType,
    sourceId,
    idempotencyKey,
    remark,
    createdAt: now
  });
}

function grantCredits(
  data: StoreData,
  userId: string,
  amount: number,
  sourceType: SourceType,
  sourceId: string,
  idempotencyKey: string,
  remark: string
): void {
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return;
  }
  const account = mustFindCreditAccount(data, userId);
  const now = new Date().toISOString();
  account.balance += amount;
  account.totalEarned += amount;
  account.updatedAt = now;
  data.creditLedgerEntries.push({
    id: randomUUID(),
    userId,
    type: "GRANT",
    amount,
    balanceAfter: account.balance,
    sourceType,
    sourceId,
    idempotencyKey,
    remark,
    createdAt: now
  });
}

function withFavorite(data: StoreData, userId: string, image: GeneratedImage): GeneratedImage & { favorite: boolean } {
  return {
    ...image,
    favorite: data.imageFavorites.some((favorite) => favorite.userId === userId && favorite.imageId === image.id)
  };
}

function audit(
  data: StoreData,
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  request: FastifyRequest
): void {
  const log: AdminAuditLog = {
    id: randomUUID(),
    adminUserId,
    action,
    targetType,
    targetId,
    before,
    after,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? "",
    createdAt: new Date().toISOString()
  };
  data.adminAuditLogs.push(log);
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function addMinutes(iso: string, minutes: number): string {
  const date = new Date(iso);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function descCreated<T extends { createdAt: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt);
}
