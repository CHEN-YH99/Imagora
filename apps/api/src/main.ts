import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import cors from "@fastify/cors";
import pino from "pino";
import { createStore, hashPassword, verifyPassword, withoutPassword } from "@imagora/database";
import { createMailer } from "@imagora/mailer";
import { createPaymentProvider, type VerifiedPaymentEvent } from "@imagora/payments";
import { createGenerationQueue } from "@imagora/queue";
import { createSafetyProvider } from "@imagora/safety";
import { createObjectStorage } from "@imagora/storage";
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
  type ReferenceImage,
  type SourceType,
  type StoreData,
  type StyleId,
  type User,
  type SafetyRule
} from "@imagora/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

// Structured logging setup
const isProduction = process.env.NODE_ENV === "production";

validateProductionConfig();

const store = createStore();
const mailer = createMailer();
const safetyProvider = createSafetyProvider();
const paymentProvider = createPaymentProvider();
const generationQueue = createGenerationQueue();
const storage = createObjectStorage();

const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname"
        }
      }
});

const app = Fastify({
  loggerInstance: logger,
  requestTimeout: 30000,
  bodyLimit: envNumber("API_BODY_LIMIT_BYTES", 1024 * 100)
});
const serviceStartedAt = Date.now();
const routeMetrics = new Map<string, RouteMetric>();
const rateLimitBuckets = new Map<string, RateLimitBucket>();
const rateLimitWindowMs = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
const rateLimitRules: RateLimitRule[] = [
  { id: "auth-login", method: "POST", pattern: /^\/api\/auth\/login$/, max: envNumber("RATE_LIMIT_AUTH_MAX", 20) },
  {
    id: "auth-register",
    method: "POST",
    pattern: /^\/api\/auth\/register$/,
    max: envNumber("RATE_LIMIT_AUTH_MAX", 20)
  },
  {
    id: "generation-create",
    method: "POST",
    pattern: /^\/api\/generation\/tasks$/,
    max: envNumber("RATE_LIMIT_GENERATION_MAX", 30)
  },
  {
    id: "reference-upload",
    method: "POST",
    pattern: /^\/api\/uploads\/reference-images$/,
    max: envNumber("RATE_LIMIT_UPLOAD_MAX", 20)
  },
  {
    id: "download-url",
    method: "POST",
    pattern: /^\/api\/images\/[^/]+\/download-url$/,
    max: envNumber("RATE_LIMIT_DOWNLOAD_MAX", 60)
  }
];

app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
  const rawBody = typeof body === "string" ? body : body.toString("utf8");
  if (pathOnly(request.url).startsWith("/api/payments/webhooks/")) {
    done(null, rawBody);
    return;
  }
  try {
    done(null, rawBody ? JSON.parse(rawBody) : null);
  } catch (error) {
    done(error as Error, undefined);
  }
});

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true,
  credentials: true
});

app.addHook("onRequest", async (request, reply) => {
  // Request tracing
  request.requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
  request.startedAt = Date.now();

  // Extract user ID from session if available
  const token = sessionToken(request, true);
  let userId: string | undefined;
  if (token) {
    const data = await store.read();
    const session = data.sessions.find((s) => s.token === token);
    if (session) {
      userId = session.userId;
    }
  }

  // Add child logger with context
  const childLogger = request.log.child({
    requestId: request.requestId,
    userId: userId ?? "anonymous",
    method: request.method,
    path: request.url,
    timestamp: new Date().toISOString()
  });

  request.log = childLogger;
  reply.header("x-request-id", request.requestId);
  applySecurityHeaders(reply);
  enforceWriteOrigin(request);
  await enforceRateLimit(request, reply);
});

app.addHook("onResponse", async (request, reply) => {
  const duration = Date.now() - (request.startedAt ?? Date.now());
  const statusCode = reply.statusCode;

  // Log request completion with metrics
  request.log.info(
    {
      statusCode,
      duration,
      method: request.method,
      path: request.url
    },
    `${request.method} ${request.url} ${statusCode} ${duration}ms`
  );

  recordRequestMetric(request, statusCode);
});

app.setErrorHandler((error, request, reply) => {
  const requestId = request.requestId ?? randomUUID();
  const duration = Date.now() - (request.startedAt ?? Date.now());

  if (error instanceof AppError) {
    request.log.warn(
      {
        errorCode: error.code,
        statusCode: error.statusCode,
        details: error.details,
        duration
      },
      error.message
    );
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
      requestId
    });
  }

  if (error instanceof z.ZodError) {
    request.log.warn({ errorCode: "VALIDATION_ERROR", details: error.flatten(), duration }, "Validation error");
    return reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: "Invalid request payload", details: error.flatten() },
      requestId
    });
  }

  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Request failed";
    request.log.warn({ statusCode, duration }, message);
    return reply.status(statusCode).send({
      error: { code: statusCode === 401 ? "UNAUTHORIZED" : "VALIDATION_ERROR", message },
      requestId
    });
  }

  // Log unhandled errors
  request.log.error(
    {
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
      duration
    },
    "Unhandled error"
  );

  return reply.status(500).send({
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    requestId
  });
});

app.get("/health", async () => ({
  status: "ok",
  service: "imagora-api",
  time: new Date().toISOString(),
  features: featureFlags()
}));

app.get("/api/features", async (request) => envelope(request, { features: featureFlags() }));

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
    setSessionCookie(reply, token, addDays(now, 14));
    reply.status(201);
    return envelope(request, { token, user: publicUser(user) });
  });
});

app.post("/api/auth/login", async (request, reply) => {
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
    setSessionCookie(reply, token, addDays(now, 14));
    return envelope(request, { token, user: publicUser(user) });
  });
});

app.post("/api/auth/logout", async (request, reply) => {
  const token = sessionToken(request);
  await store.update((data) => {
    data.sessions = data.sessions.filter((session) => session.token !== token);
  });
  clearSessionCookie(reply);
  return envelope(request, { ok: true });
});

app.post("/api/auth/request-password-reset", async (request) => {
  const input = requestPasswordResetSchema.parse(request.body);
  const data = await store.read();
  const user = data.users.find((u) => u.email === input.email.toLowerCase());

  // Always return success to prevent email enumeration
  if (!user) {
    return envelope(request, { ok: true, message: "If email exists, reset link will be sent" });
  }

  return store.update(async (data) => {
    const now = new Date().toISOString();
    const ttlMinutes = envNumber("PASSWORD_RESET_TOKEN_TTL_MINUTES", 30);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    const resetToken = randomUUID();
    const tokenHash = createHash("sha256").update(resetToken).digest("hex");

    // Clean up old reset tokens for this user
    data.passwordResetTokens = data.passwordResetTokens.filter(
      (t) => t.userId !== user.id || new Date(t.expiresAt) > new Date()
    );

    // Add new reset token
    data.passwordResetTokens.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: now
    });

    // Send reset email
    const resetUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/reset-password?token=${resetToken}`;
    try {
      await mailer.sendEmail({
        to: user.email,
        subject: "重置您的 Imagora 密码",
        text: `您好，\n\n请点击以下链接重置您的密码（${ttlMinutes} 分钟内有效）：\n\n${resetUrl}\n\n如果您没有请求重置密码，请忽略此邮件。\n\nImagora 团队`,
        html: `
          <p>您好，</p>
          <p>请点击以下链接重置您的密码（${ttlMinutes} 分钟内有效）：</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>如果您没有请求重置密码，请忽略此邮件。</p>
          <p>Imagora 团队</p>
        `
      });
      request.log.info({ userId: user.id }, "Password reset email sent");
    } catch (error) {
      request.log.error({ userId: user.id, error }, "Failed to send password reset email");
      // Don't throw - continue silently to prevent email enumeration
    }

    return envelope(request, { ok: true, message: "If email exists, reset link will be sent" });
  });
});

app.post("/api/auth/reset-password", async (request) => {
  const input = resetPasswordSchema.parse(request.body);

  const data = await store.read();
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const resetToken = data.passwordResetTokens.find((t) => t.tokenHash === tokenHash && !t.usedAt);

  if (!resetToken || new Date(resetToken.expiresAt) < new Date()) {
    throw new AppError("INVALID_RESET_TOKEN", "Invalid or expired reset token", 400);
  }

  return store.update(async (data) => {
    const user = mustFindUser(data, resetToken.userId);
    const now = new Date().toISOString();

    user.passwordHash = hashPassword(input.password);
    user.updatedAt = now;

    // Mark token as used
    const token = data.passwordResetTokens.find((t) => t.tokenHash === tokenHash);
    if (token) {
      token.usedAt = now;
    }

    // Invalidate all existing sessions for security
    data.sessions = data.sessions.filter((s) => s.userId !== user.id);

    request.log.info({ userId: user.id }, "Password reset completed");

    return envelope(request, {
      ok: true,
      message: "Password reset successfully. Please login with your new password."
    });
  });
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
  assertFeatureEnabled("generation");
  await requireAuth(request);
  const input = generationInputSchema.parse(request.body);
  return envelope(request, { creditCost: quote(input), balanceRequired: quote(input) });
});

app.post("/api/generation/tasks", async (request, reply) => {
  assertFeatureEnabled("generation");
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
    const referenceImage = input.referenceImageId
      ? mustFindOwnReferenceImage(data, user.id, input.referenceImageId)
      : null;
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
      referenceImageId: referenceImage?.id ?? null,
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
    await enqueueGenerationTaskOrFail(result.task.id, user.id, result.requestedAt);
    reply.status(201);
  }
  return envelope(request, { task: result.task, balanceAfter: result.balanceAfter });
});

app.post("/api/uploads/reference-images", { bodyLimit: uploadBodyLimitBytes() }, async (request, reply) => {
  assertFeatureEnabled("uploads");
  const { user } = await requireAuth(request);
  const input = referenceUploadSchema.parse(request.body);
  const upload = inspectReferenceUpload(input);
  const safety = await safetyProvider.checkImage({ mimeType: upload.mimeType, bytes: upload.contentBase64 });

  return store.update(async (data) => {
    if (safety.status === "BLOCKED") {
      data.safetyEvents.push({
        id: randomUUID(),
        userId: user.id,
        targetType: "UPLOAD_IMAGE",
        targetId: upload.contentHash,
        status: "BLOCKED",
        reasonCode: safety.reasonCode,
        reasonMessage: safety.reasonMessage,
        provider: safety.provider,
        createdAt: new Date().toISOString()
      });
      throw new AppError("CONTENT_BLOCKED", "Reference image was blocked by safety rules", 400, { ...safety });
    }

    const existing = data.referenceImages.find(
      (image) => image.userId === user.id && image.contentHash === upload.contentHash && !image.deletedAt
    );
    if (existing) {
      return envelope(request, { referenceImage: existing, duplicate: true });
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const stored = await storage.putObject({
      key: `reference/${user.id}/${id}.${extensionForMime(upload.mimeType)}`,
      body: upload.contentBase64,
      bodyEncoding: "base64",
      mimeType: upload.mimeType
    });
    const referenceImage: ReferenceImage = {
      id,
      userId: user.id,
      storageKey: stored.key,
      publicUrl: stored.publicUrl,
      originalFileName: input.fileName,
      mimeType: upload.mimeType,
      fileSize: upload.fileSize,
      width: upload.width,
      height: upload.height,
      contentHash: upload.contentHash,
      safetyStatus: "PASSED",
      createdAt: now,
      expiresAt: addDays(now, envNumber("UPLOAD_REFERENCE_TTL_DAYS", 1)),
      deletedAt: null
    };
    data.referenceImages.push(referenceImage);
    reply.status(201);
    return envelope(request, { referenceImage, duplicate: false });
  });
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
    spendCredits(
      data,
      user.id,
      task.creditCost,
      "TASK",
      task.id,
      `task-spend:${task.id}`,
      "Retry image generation task"
    );
    return { task, balanceAfter: mustFindCreditAccount(data, user.id).balance };
  });
  await enqueueGenerationTaskOrFail(result.task.id, user.id, result.task.createdAt);
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
  assertFeatureEnabled("downloads");
  const { user, data } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const image = mustFindOwnImage(data, user.id, imageId);
  const expiresAt = addMinutes(new Date().toISOString(), envNumber("DOWNLOAD_URL_TTL_MINUTES", 15));
  const expiresInSeconds = Math.max(60, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return envelope(request, {
    url: await storage.getSignedUrl(image.storageKey, expiresInSeconds),
    fileName: `imagora-${image.id}.${extensionForMimeType(image.mimeType)}`,
    expiresAt
  });
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
        payload: { checkoutUrl: payment.checkoutUrl, paymentIntentId: payment.paymentIntentId },
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
    const orders = data.orders.filter((order) => order.userId === user.id).sort(descCreated);
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
  assertMockPaymentAllowed();
  const { user } = await requireAuth(request);
  const { orderId } = orderParamSchema.parse(request.params);
  return store.update((data) => {
    runOrderMaintenance(data);
    const order = mustFindOwnOrder(data, user.id, orderId);
    if (order.status !== "PENDING" && order.status !== "PAID") {
      throw new AppError("ORDER_NOT_PAYABLE", "Order is not payable", 400);
    }
    const result = applyPaymentSucceeded(data, {
      provider: order.paymentProvider,
      providerEventId: `mock:${order.id}:paid`,
      orderId: order.id,
      eventType: "payment.succeeded",
      amountCents: order.amountCents,
      payload: { mock: true, amountCents: order.amountCents }
    });
    return envelope(request, { order: result.order, balanceAfter: result.balanceAfter });
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
      eventType: event.eventType,
      amountCents: event.amountCents,
      payload: payloadRecord(request.body)
    });
    return envelope(request, result);
  });
});

app.get("/api/admin/dashboard", async (request) => {
  await requireAdmin(request);
  return store.update((data) => {
    runOrderMaintenance(data);
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
});

app.get("/api/admin/metrics", async (request) => {
  await requireAdmin(request);
  return store.update((data) => {
    const maintenance = runOrderMaintenance(data);
    const http = httpMetricsSnapshot();
    const domain = domainMetricsSnapshot(data);
    return envelope(request, {
      service: {
        uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1000),
        startedAt: new Date(serviceStartedAt).toISOString(),
        features: featureFlags()
      },
      http,
      domain,
      maintenance,
      alerts: operationalAlertsSnapshot(data, http)
    });
  });
});

app.post("/api/admin/maintenance/reconcile", async (request) => {
  const { user: admin } = await requireAdmin(request);
  return store.update((data) => {
    const maintenance = runOrderMaintenance(data);
    audit(data, admin.id, "maintenance.reconcile", "SYSTEM", "orders", null, { ...maintenance }, request);
    return envelope(request, { maintenance });
  });
});

app.get("/api/admin/users", async (request) => {
  const query = adminUserQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const search = query.search?.toLowerCase();
  const users = data.users
    .filter((user) => !query.status || user.status === query.status)
    .filter((user) => !query.role || user.role === query.role)
    .filter((user) => {
      if (!search) {
        return true;
      }
      return user.email.toLowerCase().includes(search) || user.nickname.toLowerCase().includes(search);
    })
    .sort(descCreated)
    .slice(0, query.limit)
    .map(withoutPassword);
  return envelope(request, { users, total: data.users.length });
});

app.get("/api/admin/users/:userId", async (request) => {
  await requireAdmin(request);
  const { userId } = userParamSchema.parse(request.params);
  const data = await store.read();
  const user = mustFindUser(data, userId);
  const account = data.creditAccounts.find((a) => a.userId === userId);
  const orders = data.orders.filter((o) => o.userId === userId).sort(descCreated).slice(0, 10);
  const tasks = data.generationTasks.filter((t) => t.userId === userId).sort(descCreated).slice(0, 10);
  const images = data.generatedImages.filter((img) => img.userId === userId).length;

  return envelope(request, {
    user: withoutPassword(user),
    account,
    stats: {
      totalOrders: data.orders.filter((o) => o.userId === userId).length,
      paidOrders: data.orders.filter((o) => o.userId === userId && o.status === "PAID").length,
      totalTasks: data.generationTasks.filter((t) => t.userId === userId).length,
      succeededTasks: data.generationTasks.filter((t) => t.userId === userId && t.status === "SUCCEEDED").length,
      totalImages: images
    },
    recentOrders: orders,
    recentTasks: tasks
  });
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
    adjustCredits(data, userId, input.amount, admin.id, `admin-adjust:${randomUUID()}`, input.reason);
    audit(data, admin.id, "user.credits.adjust", "USER", userId, before, { balance: account.balance }, request);
    return envelope(request, { account });
  });
});

app.get("/api/admin/generation/tasks", async (request) => {
  const query = adminTaskQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const tasks = data.generationTasks
    .filter((task) => !query.status || task.status === query.status)
    .filter((task) => !query.userId || task.userId === query.userId)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { tasks });
});

app.get("/api/admin/images", async (request) => {
  const query = adminImageQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const images = data.generatedImages
    .filter((image) => !query.visibility || image.visibility === query.visibility)
    .filter((image) => !query.userId || image.userId === query.userId)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { images });
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
    audit(
      data,
      admin.id,
      "image.visibility.update",
      "IMAGE",
      image.id,
      before,
      { visibility: image.visibility },
      request
    );
    return envelope(request, { image });
  });
});

app.get("/api/admin/orders", async (request) => {
  const query = adminOrderQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const orders = data.orders
    .filter((order) => !query.status || order.status === query.status)
    .filter((order) => !query.userId || order.userId === query.userId)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { orders });
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

const port = Number(process.env.API_PORT ?? 4100);
const host = process.env.API_HOST ?? "127.0.0.1";
await app.listen({ port, host });

declare module "fastify" {
  interface FastifyRequest {
    requestId?: string;
    startedAt?: number;
  }
}

interface RouteMetric {
  requests: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitRule {
  id: string;
  method: string;
  pattern: RegExp;
  max: number;
}

type FeatureName = "generation" | "payments" | "uploads" | "downloads";

interface FeatureFlags {
  generation: boolean;
  payments: boolean;
  uploads: boolean;
  downloads: boolean;
}

type UploadMimeType = ReferenceImage["mimeType"];

interface InspectedReferenceUpload {
  contentBase64: string;
  contentHash: string;
  fileSize: number;
  mimeType: UploadMimeType;
  width: number | null;
  height: number | null;
}

interface OrderMaintenanceResult {
  closedExpiredOrders: number;
  reconciledPaidOrders: number;
  reconciledPaymentEvents: number;
}

type OperationalAlertSeverity = "warning" | "critical";

interface OperationalAlert {
  id: string;
  severity: OperationalAlertSeverity;
  area: "generation" | "payments" | "http";
  metric: string;
  value: number;
  threshold: number;
  message: string;
  runbook: string;
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

const requestPasswordResetSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8)
});

const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional()
});

const generationInputSchema = z.object({
  clientRequestId: z
    .string()
    .min(8)
    .max(120)
    .default(() => randomUUID()),
  referenceImageId: z.string().min(1).optional(),
  prompt: z.string().min(1).max(maxPromptLength),
  negativePrompt: z.string().max(800).optional(),
  style: z.enum(["realistic", "illustration", "anime", "product_photography", "poster"]),
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]),
  quantity: z.number().int().min(1).max(maxQuantity),
  quality: z.enum(["draft", "standard", "high"])
});

const referenceUploadSchema = z.object({
  fileName: z.string().min(1).max(180),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  contentBase64: z.string().min(16).max(envNumber("UPLOAD_MAX_BASE64_CHARS", 8_000_000))
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const userStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "DELETED"]);
const userRoleSchema = z.enum(["USER", "ADMIN"]);
const taskStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "BLOCKED"]);
const imageVisibilitySchema = z.enum(["PRIVATE", "PUBLIC", "HIDDEN"]);
const orderStatusSchema = z.enum(["PENDING", "PAID", "CANCELED", "REFUNDED", "CLOSED"]);

const taskQuerySchema = paginationSchema.extend({
  status: taskStatusSchema.optional()
});

const adminUserQuerySchema = paginationSchema.extend({
  status: userStatusSchema.optional(),
  role: userRoleSchema.optional(),
  search: z.string().trim().max(120).optional()
});

const adminTaskQuerySchema = paginationSchema.extend({
  status: taskStatusSchema.optional(),
  userId: z.string().min(1).optional()
});

const adminImageQuerySchema = paginationSchema.extend({
  visibility: imageVisibilitySchema.optional(),
  userId: z.string().min(1).optional()
});

const adminOrderQuerySchema = paginationSchema.extend({
  status: orderStatusSchema.optional(),
  userId: z.string().min(1).optional()
});

const idParamSchema = z.object({ taskId: z.string().min(1) });
const imageParamSchema = z.object({ imageId: z.string().min(1) });
const orderParamSchema = z.object({ orderId: z.string().min(1) });
const userParamSchema = z.object({ userId: z.string().min(1) });
const planParamSchema = z.object({ planId: z.string().min(1) });
const paymentWebhookParamSchema = z.object({ provider: z.string().min(1) });

const createOrderSchema = z.object({
  planId: z.string().min(1),
  paymentProvider: z.enum(["mock", "stripe", "wechat", "alipay"]).default("mock")
});

const statusSchema = z.object({ status: userStatusSchema });
const visibilitySchema = z.object({ visibility: imageVisibilitySchema });
const adjustCreditSchema = z.object({
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0),
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

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function uploadBodyLimitBytes(): number {
  const base64Chars = envNumber("UPLOAD_MAX_BASE64_CHARS", 8_000_000);
  return Math.max(envNumber("API_BODY_LIMIT_BYTES", 1024 * 100), base64Chars + 16 * 1024);
}

async function enqueueGenerationTaskOrFail(taskId: string, userId: string, requestedAt: string): Promise<void> {
  try {
    await generationQueue.enqueueGenerationTask({ taskId, userId, requestedAt });
  } catch (error) {
    await markTaskFailedAndRefund(
      taskId,
      "QUEUE_ENQUEUE_FAILED",
      errorMessage(error, "Generation queue enqueue failed")
    );
    throw new AppError("INTERNAL_ERROR", "Generation task could not be queued. Credits were refunded.", 500, {
      taskId
    });
  }
}

function sessionToken(request: FastifyRequest, optional = false): string {
  const cookieToken = cookieValue(request.headers.cookie, sessionCookieName());
  if (cookieToken) {
    return cookieToken;
  }
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    if (optional) {
      return "";
    }
    throw new AppError("UNAUTHORIZED", "Missing session token", 401);
  }
  return authorization.slice("Bearer ".length);
}

async function requireAuth(request: FastifyRequest): Promise<{ data: StoreData; user: User }> {
  const token = sessionToken(request);
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

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
  reply.header(
    "set-cookie",
    serializeCookie(sessionCookieName(), token, {
      expires: new Date(expiresAt),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "set-cookie",
    serializeCookie(sessionCookieName(), "", {
      expires: new Date(0),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

function sessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? "imagora_session";
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: { expires: Date; httpOnly: boolean; secure: boolean; sameSite: string; path: string }
): string {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    `Expires=${options.expires.toUTCString()}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`
  ];
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
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

function mustFindOwnReferenceImage(data: StoreData, userId: string, referenceImageId: string): ReferenceImage {
  const image = data.referenceImages.find(
    (item) => item.id === referenceImageId && item.userId === userId && !item.deletedAt
  );
  if (!image) {
    throw new AppError("NOT_FOUND", "Reference image was not found", 404);
  }
  if (new Date(image.expiresAt).getTime() <= Date.now()) {
    throw new AppError("VALIDATION_ERROR", "Reference image has expired", 400);
  }
  if (image.safetyStatus !== "PASSED") {
    throw new AppError("CONTENT_BLOCKED", "Reference image is not available for generation", 400);
  }
  return image;
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

function mustFindOrder(data: StoreData, orderId: string): Order {
  const order = data.orders.find((item) => item.id === orderId);
  if (!order) {
    throw new AppError("NOT_FOUND", "Order was not found", 404);
  }
  return order;
}

function runOrderMaintenance(data: StoreData): OrderMaintenanceResult {
  const now = new Date().toISOString();
  const closedExpiredOrders = closeExpiredPendingOrders(data, now);
  const reconciledPaymentEvents = reconcileSucceededPaymentEvents(data, now);
  const reconciledPaidOrders = reconcilePaidOrderCredits(data);
  return { closedExpiredOrders, reconciledPaidOrders, reconciledPaymentEvents };
}

function closeExpiredPendingOrders(data: StoreData, now: string): number {
  const expiresMs = envNumber("ORDER_PENDING_TTL_MINUTES", 30) * 60 * 1000;
  if (expiresMs <= 0) {
    return 0;
  }
  const cutoff = Date.now() - expiresMs;
  let closed = 0;
  for (const order of data.orders) {
    if (order.status !== "PENDING") {
      continue;
    }
    if (new Date(order.createdAt).getTime() <= cutoff) {
      order.status = "CLOSED";
      order.updatedAt = now;
      closed += 1;
    }
  }
  return closed;
}

function reconcileSucceededPaymentEvents(data: StoreData, now: string): number {
  let reconciled = 0;
  for (const event of data.paymentEvents) {
    if (event.eventType !== "payment.succeeded") {
      continue;
    }
    const order = data.orders.find((item) => item.id === event.orderId);
    if (!order || order.status === "PAID") {
      continue;
    }
    if (paymentEventAmount(event.payload) !== order.amountCents) {
      continue;
    }
    order.status = "PAID";
    order.paymentIntentId = order.paymentIntentId ?? `${event.provider}_pi_${order.id}`;
    order.paidAt = order.paidAt ?? event.processedAt;
    order.updatedAt = now;
    reconciled += 1;
  }
  return reconciled;
}

function reconcilePaidOrderCredits(data: StoreData): number {
  let reconciled = 0;
  for (const order of data.orders) {
    if (order.status !== "PAID") {
      continue;
    }
    const idempotencyKey = `order-grant:${order.id}`;
    if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
      continue;
    }
    const plan = data.plans.find((item) => item.id === order.planId);
    if (!plan) {
      continue;
    }
    grantCredits(data, order.userId, plan.credits, "ORDER", order.id, idempotencyKey, `Purchased ${plan.name}`);
    reconciled += 1;
  }
  return reconciled;
}

function paymentEventAmount(payload: Record<string, unknown>): number | null {
  const amount = payload.amountCents;
  return typeof amount === "number" && Number.isInteger(amount) ? amount : null;
}

function applyPaymentSucceeded(
  data: StoreData,
  input: {
    provider: string;
    providerEventId: string;
    orderId: string;
    eventType: string;
    amountCents: number;
    payload: Record<string, unknown>;
  }
): { order: Order; balanceAfter: number; credited: boolean; duplicateEvent: boolean; reason: string | null } {
  const duplicate = data.paymentEvents.find(
    (event) => event.provider === input.provider && event.providerEventId === input.providerEventId
  );
  if (duplicate) {
    const order = mustFindOrder(data, duplicate.orderId);
    return {
      order,
      balanceAfter: mustFindCreditAccount(data, order.userId).balance,
      credited: false,
      duplicateEvent: true,
      reason: "DUPLICATE_EVENT"
    };
  }

  const order = mustFindOrder(data, input.orderId);
  if (order.paymentProvider !== input.provider) {
    throw new AppError("VALIDATION_ERROR", "Payment provider does not match order", 400);
  }

  const plan = data.plans.find((item) => item.id === order.planId);
  if (!plan) {
    throw new AppError("PLAN_UNAVAILABLE", "Plan is not available", 404);
  }

  const now = new Date().toISOString();
  data.paymentEvents.push({
    id: randomUUID(),
    provider: input.provider,
    providerEventId: input.providerEventId,
    orderId: order.id,
    eventType: input.eventType,
    payload: input.payload,
    processedAt: now,
    createdAt: now
  });

  if (input.amountCents !== order.amountCents) {
    return {
      order,
      balanceAfter: mustFindCreditAccount(data, order.userId).balance,
      credited: false,
      duplicateEvent: false,
      reason: "AMOUNT_MISMATCH"
    };
  }

  if (order.status === "PAID") {
    return {
      order,
      balanceAfter: mustFindCreditAccount(data, order.userId).balance,
      credited: false,
      duplicateEvent: false,
      reason: "ORDER_ALREADY_PAID"
    };
  }

  if (!["PENDING", "CLOSED"].includes(order.status)) {
    return {
      order,
      balanceAfter: mustFindCreditAccount(data, order.userId).balance,
      credited: false,
      duplicateEvent: false,
      reason: "ORDER_NOT_PAYABLE"
    };
  }

  order.status = "PAID";
  order.paymentIntentId = order.paymentIntentId ?? `${input.provider}_pi_${order.id}`;
  order.paidAt = now;
  order.updatedAt = now;
  grantCredits(
    data,
    order.userId,
    plan.credits,
    "ORDER",
    order.id,
    `order-grant:${order.id}`,
    `Purchased ${plan.name}`
  );

  return {
    order,
    balanceAfter: mustFindCreditAccount(data, order.userId).balance,
    credited: true,
    duplicateEvent: false,
    reason: null
  };
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

async function markTaskFailedAndRefund(taskId: string, code: string, message: string): Promise<void> {
  await store.update((data) => {
    const task = data.generationTasks.find((item) => item.id === taskId);
    if (!task || ["SUCCEEDED", "FAILED", "CANCELED", "BLOCKED"].includes(task.status)) {
      return;
    }
    const now = new Date().toISOString();
    task.status = "FAILED";
    task.failureCode = code;
    task.failureMessage = message;
    task.completedAt = now;
    task.updatedAt = now;
    refundTaskCredits(data, task, "Generation task could not be queued");
  });
}

function refundTaskCredits(data: StoreData, task: GenerationTask, remark: string): void {
  const idempotencyKey = `task-refund:${task.id}`;
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return;
  }
  const account = mustFindCreditAccount(data, task.userId);
  const now = new Date().toISOString();
  account.balance += task.creditCost;
  account.totalEarned += task.creditCost;
  account.updatedAt = now;
  data.creditLedgerEntries.push({
    id: randomUUID(),
    userId: task.userId,
    type: "REFUND",
    amount: task.creditCost,
    balanceAfter: account.balance,
    sourceType: "TASK",
    sourceId: task.id,
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

function adjustCredits(
  data: StoreData,
  userId: string,
  amount: number,
  adminUserId: string,
  idempotencyKey: string,
  remark: string
): void {
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return;
  }
  const account = mustFindCreditAccount(data, userId);
  if (amount < 0 && account.balance < Math.abs(amount)) {
    throw new AppError("INSUFFICIENT_CREDITS", "Credit balance is not enough", 402);
  }
  const now = new Date().toISOString();
  account.balance += amount;
  if (amount > 0) {
    account.totalEarned += amount;
  } else {
    account.totalSpent += Math.abs(amount);
  }
  account.updatedAt = now;
  data.creditLedgerEntries.push({
    id: randomUUID(),
    userId,
    type: "ADJUST",
    amount,
    balanceAfter: account.balance,
    sourceType: "ADMIN",
    sourceId: adminUserId,
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

function inspectReferenceUpload(input: z.infer<typeof referenceUploadSchema>): InspectedReferenceUpload {
  const contentBase64 = normalizeBase64(input.contentBase64);
  const bytes = decodeBase64(contentBase64);
  const fileSize = bytes.byteLength;
  const maxBytes = envNumber("UPLOAD_MAX_BYTES", 5 * 1024 * 1024);
  if (fileSize > maxBytes) {
    throw new AppError("VALIDATION_ERROR", "Reference image is too large", 400, { maxBytes, fileSize });
  }

  const mimeType = detectImageMime(bytes);
  if (!mimeType) {
    throw new AppError("VALIDATION_ERROR", "Reference image signature is not supported", 400);
  }
  if (mimeType !== input.mimeType) {
    throw new AppError("VALIDATION_ERROR", "Reference image MIME does not match file signature", 400, {
      declared: input.mimeType,
      detected: mimeType
    });
  }

  const dimensions = readImageDimensions(bytes, mimeType);
  if (!dimensions) {
    throw new AppError("VALIDATION_ERROR", "Reference image dimensions could not be read", 400);
  }
  const maxDimension = envNumber("UPLOAD_MAX_DIMENSION", 8192);
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > maxDimension ||
    dimensions.height > maxDimension
  ) {
    throw new AppError("VALIDATION_ERROR", "Reference image dimensions are not allowed", 400, {
      maxDimension,
      width: dimensions.width,
      height: dimensions.height
    });
  }

  return {
    contentBase64,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    fileSize,
    mimeType,
    width: dimensions.width,
    height: dimensions.height
  };
}

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  return (dataUrl?.[2] ?? trimmed).replace(/\s/g, "");
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new AppError("VALIDATION_ERROR", "Reference image content is not valid base64", 400);
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length) {
    throw new AppError("VALIDATION_ERROR", "Reference image content is empty", 400);
  }
  return bytes;
}

function detectImageMime(bytes: Buffer): UploadMimeType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function readImageDimensions(bytes: Buffer, mimeType: UploadMimeType): { width: number; height: number } | null {
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
  }
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      return null;
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb)
    ) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    };
  }
  return null;
}

function extensionForMime(mimeType: UploadMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}

function featureFlags(): FeatureFlags {
  return {
    generation: envBool("FEATURE_GENERATION_ENABLED", true),
    payments: envBool("FEATURE_PAYMENTS_ENABLED", true),
    uploads: envBool("FEATURE_UPLOADS_ENABLED", true),
    downloads: envBool("FEATURE_DOWNLOADS_ENABLED", true)
  };
}

function assertFeatureEnabled(feature: FeatureName): void {
  if (!featureFlags()[feature]) {
    throw new AppError("FEATURE_DISABLED", `${feature} is temporarily disabled`, 503, { feature });
  }
}

function assertPaymentProviderEnabled(provider: string): void {
  if (provider !== paymentProvider.name) {
    throw new AppError("VALIDATION_ERROR", "Payment provider is not enabled", 400, {
      requestedProvider: provider,
      enabledProvider: paymentProvider.name
    });
  }
}

function assertMockPaymentAllowed(): void {
  if (isProduction || paymentProvider.name !== "mock") {
    throw new AppError("FEATURE_DISABLED", "Mock payment completion is disabled", 503, {
      provider: paymentProvider.name
    });
  }
}

function validateProductionConfig(): void {
  if (!isProduction) {
    return;
  }

  requireProductionValue("WEB_ORIGIN");
  rejectLocalhostProductionValue("WEB_ORIGIN");
  requireProductionValue("DATABASE_URL");
  requireProductionValue("REDIS_URL");
  requireProductionValue("OPENAI_API_KEY");
  requireProductionValue("S3_ENDPOINT");
  requireProductionValue("S3_BUCKET");
  requireProductionValue("S3_ACCESS_KEY_ID");
  requireProductionValue("S3_SECRET_ACCESS_KEY");
  requireProductionValue("S3_PUBLIC_BASE_URL");
  requireProductionValue("STRIPE_SECRET_KEY");
  requireProductionValue("STRIPE_WEBHOOK_SECRET");
  requireProductionValue("STRIPE_SUCCESS_URL");
  requireProductionValue("STRIPE_CANCEL_URL");
  requireProductionSetting("DATA_STORE", "prisma");
  requireProductionSetting("QUEUE_PROVIDER", "bullmq");
  requireProductionSetting("AI_PROVIDER", "openai");
  requireProductionSetting("STORAGE_PROVIDER", "s3", "r2");
  requireProductionSetting("PAYMENT_PROVIDER", "stripe");
  requireProductionSetting("RATE_LIMIT_PROVIDER", "redis");
  if (!envBool("SESSION_COOKIE_SECURE", false)) {
    throw new Error("Unsafe production config: SESSION_COOKIE_SECURE must be true");
  }
}

function requireProductionValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Unsafe production config: ${name} is required`);
  }
  return value;
}

function requireProductionSetting(name: string, ...allowedValues: string[]): void {
  const value = requireProductionValue(name);
  if (!allowedValues.includes(value)) {
    throw new Error(`Unsafe production config: ${name} must be ${allowedValues.join(" or ")}`);
  }
}

function rejectLocalhostProductionValue(name: string): void {
  const value = requireProductionValue(name);
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value)) {
    throw new Error(`Unsafe production config: ${name} must not point at localhost`);
  }
}

function applySecurityHeaders(reply: FastifyReply): void {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === "production") {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

function enforceWriteOrigin(request: FastifyRequest): void {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    pathOnly(request.url).startsWith("/api/payments/webhooks/")
  ) {
    return;
  }
  const origin = headerValue(request.headers.origin);
  if (!origin) {
    return;
  }
  if (!allowedWriteOrigins().has(origin)) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed", 403);
  }
}

function allowedWriteOrigins(): Set<string> {
  const values = [process.env.WEB_ORIGIN, process.env.CSRF_ALLOWED_ORIGINS]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set(values);
}

async function enforceRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = pathOnly(request.url);
  const rule = rateLimitRules.find((item) => item.method === request.method && item.pattern.test(path));
  if (!rule || rule.max <= 0) {
    return;
  }

  const now = Date.now();
  if (rateLimitBuckets.size > 5000) {
    pruneRateLimitBuckets(now);
  }

  const key = `${rule.id}:${request.ip}`;
  if ((process.env.RATE_LIMIT_PROVIDER ?? "memory") === "redis") {
    const redisResult = await redisFixedWindowIncrement(key, rateLimitWindowMs);
    reply.header("x-ratelimit-limit", String(rule.max));
    reply.header("x-ratelimit-remaining", String(Math.max(rule.max - redisResult.count, 0)));
    reply.header("x-ratelimit-reset", new Date(redisResult.resetAt).toISOString());
    if (redisResult.count > rule.max) {
      throw new AppError("RATE_LIMITED", "Too many requests, please retry later", 429, {
        limit: rule.max,
        resetAt: new Date(redisResult.resetAt).toISOString()
      });
    }
    return;
  }

  const bucket = rateLimitBuckets.get(key);
  const nextBucket =
    !bucket || bucket.resetAt <= now
      ? { count: 1, resetAt: now + rateLimitWindowMs }
      : { ...bucket, count: bucket.count + 1 };
  rateLimitBuckets.set(key, nextBucket);

  reply.header("x-ratelimit-limit", String(rule.max));
  reply.header("x-ratelimit-remaining", String(Math.max(rule.max - nextBucket.count, 0)));
  reply.header("x-ratelimit-reset", new Date(nextBucket.resetAt).toISOString());

  if (nextBucket.count > rule.max) {
    throw new AppError("RATE_LIMITED", "Too many requests, please retry later", 429, {
      limit: rule.max,
      resetAt: new Date(nextBucket.resetAt).toISOString()
    });
  }
}

async function redisFixedWindowIncrement(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
  const redisKey = `imagora:ratelimit:${key}`;
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const count = Number(await redisCommand(redisUrl, ["INCR", redisKey]));
  if (count === 1) {
    await redisCommand(redisUrl, ["PEXPIRE", redisKey, String(windowMs)]);
  }
  const ttl = Number(await redisCommand(redisUrl, ["PTTL", redisKey]));
  const resetAt = Date.now() + Math.max(ttl, 0);
  return { count, resetAt };
}

function redisCommand(redisUrl: string, args: string[]): Promise<string> {
  const url = new URL(redisUrl);
  const port = Number(url.port || 6379);
  const password = decodeURIComponent(url.password);
  const db = Number(url.pathname.replace("/", "") || 0);
  const commands: string[][] = [];
  if (password) {
    commands.push(["AUTH", password]);
  }
  if (db) {
    commands.push(["SELECT", String(db)]);
  }
  commands.push(args);

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port });
    let buffer = Buffer.alloc(0);
    const responses: string[] = [];
    socket.setTimeout(envNumber("REDIS_RATE_LIMIT_TIMEOUT_MS", 500));
    socket.on("connect", () => {
      socket.write(commands.map(encodeRedisCommand).join(""));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseRedisResponse(buffer);
        if (!parsed) {
          break;
        }
        responses.push(parsed.value);
        buffer = buffer.subarray(parsed.bytes);
        if (responses.length === commands.length) {
          socket.end();
          resolve(responses[responses.length - 1] ?? "");
        }
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Redis rate limit command timed out"));
    });
    socket.on("error", reject);
  });
}

function encodeRedisCommand(args: string[]): string {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`;
}

function parseRedisResponse(buffer: Buffer): { value: string; bytes: number } | null {
  const type = String.fromCharCode(buffer[0] ?? 0);
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.subarray(1, lineEnd).toString("utf8");
  if (type === "+" || type === ":") {
    return { value: line, bytes: lineEnd + 2 };
  }
  if (type === "-") {
    throw new Error(`Redis error: ${line}`);
  }
  if (type === "$") {
    const length = Number(line);
    if (length < 0) {
      return { value: "", bytes: lineEnd + 2 };
    }
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) {
      return null;
    }
    return { value: buffer.subarray(start, end).toString("utf8"), bytes: end + 2 };
  }
  throw new Error(`Unsupported Redis response type: ${type}`);
}

function pruneRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}

function recordRequestMetric(request: FastifyRequest, statusCode: number): void {
  const route = `${request.method} ${request.routeOptions.url ?? pathOnly(request.url)}`;
  const metric = routeMetrics.get(route) ?? { requests: 0, failures: 0, totalDurationMs: 0, maxDurationMs: 0 };
  const durationMs = Math.max(0, Date.now() - (request.startedAt ?? Date.now()));
  metric.requests += 1;
  metric.failures += statusCode >= 500 ? 1 : 0;
  metric.totalDurationMs += durationMs;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
  routeMetrics.set(route, metric);
}

function httpMetricsSnapshot() {
  const routes = [...routeMetrics.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([route, metric]) => ({
      route,
      requests: metric.requests,
      failures: metric.failures,
      averageDurationMs: round(metric.totalDurationMs / metric.requests),
      maxDurationMs: metric.maxDurationMs
    }));
  return {
    requestsTotal: routes.reduce((sum, route) => sum + route.requests, 0),
    failuresTotal: routes.reduce((sum, route) => sum + route.failures, 0),
    routes
  };
}

function operationalAlertsSnapshot(data: StoreData, http: ReturnType<typeof httpMetricsSnapshot>): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const terminalTasks = data.generationTasks.filter((task) =>
    ["SUCCEEDED", "FAILED", "CANCELED", "BLOCKED"].includes(task.status)
  );
  const failedTasks = terminalTasks.filter((task) => task.status === "FAILED");
  const pendingTasks = data.generationTasks.filter((task) => task.status === "PENDING").length;
  const runningTasks = data.generationTasks.filter((task) => task.status === "RUNNING").length;
  const generationFailureRate = terminalTasks.length ? round(failedTasks.length / terminalTasks.length) : 0;
  const generationFailureRateThreshold = envNumber("ALERT_GENERATION_FAILURE_RATE", 0.35);
  if (generationFailureRateThreshold >= 0 && generationFailureRate > generationFailureRateThreshold) {
    alerts.push({
      id: "generation.failure-rate",
      severity: alertSeverity(generationFailureRate, generationFailureRateThreshold),
      area: "generation",
      metric: "generationFailureRate",
      value: generationFailureRate,
      threshold: generationFailureRateThreshold,
      message: "Generation failure rate is above threshold.",
      runbook:
        "Disable generation, inspect provider failures, and restart/scale workers after provider health is confirmed."
    });
  }

  const backlog = pendingTasks + runningTasks;
  const backlogThreshold = envNumber("ALERT_GENERATION_BACKLOG_MAX", 25);
  if (backlog > backlogThreshold) {
    alerts.push({
      id: "generation.backlog",
      severity: alertSeverity(backlog, backlogThreshold),
      area: "generation",
      metric: "generationBacklog",
      value: backlog,
      threshold: backlogThreshold,
      message: "Generation task backlog is above threshold.",
      runbook: "Scale workers or temporarily disable generation submissions until backlog drains."
    });
  }

  const staleRunningMinutes = envNumber("ALERT_STALE_RUNNING_MINUTES", 10);
  const staleRunningThreshold = envNumber("ALERT_STALE_RUNNING_TASKS_MAX", 0);
  const staleCutoff = Date.now() - staleRunningMinutes * 60 * 1000;
  const staleRunning = data.generationTasks.filter(
    (task) => task.status === "RUNNING" && task.startedAt && new Date(task.startedAt).getTime() <= staleCutoff
  ).length;
  if (staleRunning > staleRunningThreshold) {
    alerts.push({
      id: "generation.stale-running",
      severity: "critical",
      area: "generation",
      metric: "staleRunningTasks",
      value: staleRunning,
      threshold: staleRunningThreshold,
      message: "Generation tasks have been running longer than the stale threshold.",
      runbook: "Run worker recovery, verify refunds, and check provider timeout logs by taskId."
    });
  }

  const pendingOrders = data.orders.filter((order) => order.status === "PENDING").length;
  const pendingOrdersThreshold = envNumber("ALERT_PENDING_ORDERS_MAX", 50);
  if (pendingOrders > pendingOrdersThreshold) {
    alerts.push({
      id: "payments.pending-orders",
      severity: alertSeverity(pendingOrders, pendingOrdersThreshold),
      area: "payments",
      metric: "pendingOrders",
      value: pendingOrders,
      threshold: pendingOrdersThreshold,
      message: "Pending payment orders are above threshold.",
      runbook: "Check payment provider status, disable payments if needed, and run order reconciliation."
    });
  }

  const amountMismatchEvents = data.paymentEvents.filter((event) => {
    if (event.eventType !== "payment.succeeded") {
      return false;
    }
    const order = data.orders.find((item) => item.id === event.orderId);
    return Boolean(order && paymentEventAmount(event.payload) !== order.amountCents);
  }).length;
  const amountMismatchThreshold = envNumber("ALERT_PAYMENT_AMOUNT_MISMATCH_MAX", 0);
  if (amountMismatchEvents > amountMismatchThreshold) {
    alerts.push({
      id: "payments.amount-mismatch",
      severity: "critical",
      area: "payments",
      metric: "paymentAmountMismatchEvents",
      value: amountMismatchEvents,
      threshold: amountMismatchThreshold,
      message: "Payment succeeded events with amount mismatch were detected.",
      runbook: "Do not manually grant credits until the provider event and order snapshot are verified."
    });
  }

  const httpFailureRate = http.requestsTotal ? round(http.failuresTotal / http.requestsTotal) : 0;
  const httpFailureRateThreshold = envNumber("ALERT_HTTP_FAILURE_RATE", 0.05);
  if (httpFailureRate > httpFailureRateThreshold) {
    alerts.push({
      id: "http.failure-rate",
      severity: alertSeverity(httpFailureRate, httpFailureRateThreshold),
      area: "http",
      metric: "httpFailureRate",
      value: httpFailureRate,
      threshold: httpFailureRateThreshold,
      message: "HTTP 5xx failure rate is above threshold.",
      runbook: "Inspect route metrics, recent deploys, and provider logs by requestId."
    });
  }

  return alerts.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function domainMetricsSnapshot(data: StoreData) {
  const terminalTasks = data.generationTasks.filter((task) =>
    ["SUCCEEDED", "FAILED", "CANCELED", "BLOCKED"].includes(task.status)
  );
  const succeededTasks = data.generationTasks.filter((task) => task.status === "SUCCEEDED");
  const completedDurations = data.generationTasks
    .filter((task) => task.startedAt && task.completedAt)
    .map((task) => new Date(task.completedAt as string).getTime() - new Date(task.startedAt as string).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);

  return {
    usersTotal: data.users.length,
    creditsOutstanding: data.creditAccounts.reduce((sum, account) => sum + account.balance, 0),
    tasksByStatus: countBy(data.generationTasks, (task) => task.status),
    generationSuccessRate: terminalTasks.length ? round(succeededTasks.length / terminalTasks.length) : null,
    averageGenerationDurationMs: completedDurations.length
      ? round(completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length)
      : null,
    referenceImagesTotal: data.referenceImages.filter((image) => !image.deletedAt).length,
    imagesTotal: data.generatedImages.length,
    ordersByStatus: countBy(data.orders, (order) => order.status),
    paymentEventsTotal: data.paymentEvents.length,
    blockedSafetyEventsTotal: data.safetyEvents.filter((event) => event.status === "BLOCKED").length
  };
}

function alertSeverity(value: number, threshold: number): OperationalAlertSeverity {
  return threshold > 0 && value >= threshold * 2 ? "critical" : "warning";
}

function severityRank(severity: OperationalAlertSeverity): number {
  return severity === "critical" ? 2 : 1;
}

function countBy<T>(items: T[], selectKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    const key = selectKey(item);
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function pathOnly(url: string): string {
  return url.split("?")[0] ?? url;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase());
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function webhookSignature(request: FastifyRequest): string | undefined {
  return (
    headerValue(request.headers["stripe-signature"]) ??
    headerValue(request.headers["x-webhook-signature"]) ??
    headerValue(request.headers["x-payment-signature"])
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as unknown;
      return payloadRecord(parsed);
    } catch {
      return { raw: payload };
    }
  }
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { raw: payload };
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
