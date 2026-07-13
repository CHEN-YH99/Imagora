import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import cors from "@fastify/cors";
import pino from "pino";
import {
  assertProductionOpenAiGenerationConfig,
  getActiveProviderMetadata,
  quoteImageGeneration,
  readOpenAiGenerationRuntimeConfig,
  resolveDefaultImageModel,
  resolveDefaultImageProvider,
  resolveProviderModel
} from "@imagora/ai-providers";
import { createStore, hashPassword, verifyPassword, withoutPassword } from "@imagora/database";
import { buildVerificationEmail, createMailer } from "@imagora/mailer";
import { createAlertNotifier } from "@imagora/notifier";
import { createPaymentProvider, type VerifiedPaymentEvent } from "@imagora/payments";
import { createGenerationQueue } from "@imagora/queue";
import { createSafetyProvider } from "@imagora/safety";
import { createObjectStorage, FilesystemObjectStorage } from "@imagora/storage";
import {
  AppError,
  type AdminAuditLog,
  type AlertNotification,
  type AlertNotificationPayload,
  type AlertNotificationStatus,
  type ApiEnvelope,
  type AspectRatio,
  aspectRatioDimensions,
  DEFAULT_PENDING_TASK_TIMEOUT_MS,
  DEFAULT_RUNNING_TASK_TIMEOUT_MS,
  creditSourceRemainders,
  expireCredits,
  refundFailureCount,
  refundTaskCredits,
  groupLedgerByUser,
  type GeneratedImage,
  type GenerationTask,
  maxPromptLength,
  maxQuantity,
  type ModelId,
  type Order,
  type PaymentEvent,
  type Plan,
  publicUser,
  type Quality,
  type ReferenceImage,
  runGenerationMaintenance,
  type SourceType,
  type StoreData,
  type StyleId,
  taskRefundedCredits,
  type User,
  type SafetyAppeal,
  type SafetyRule
} from "@imagora/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

// Structured logging setup
const isProduction = process.env.NODE_ENV === "production";

validateProductionConfig();

const store = createStore();
const mailer = createMailer();
const alertNotifier = createAlertNotifier({ mailer });
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
  bodyLimit: envNumber("API_BODY_LIMIT_BYTES", 1024 * 100),
  // 反代/负载均衡后面必须信任 X-Forwarded-For，否则 request.ip 全是代理 IP，
  // 限流按 IP 分桶会退化成"全局共享一个桶"，登录爆破防护形同虚设。
  // 默认关闭（本地直连更安全），生产由 TRUST_PROXY 显式开启；也可传入代理跳数或 CIDR。
  trustProxy: resolveTrustProxy()
});
const serviceStartedAt = Date.now();
const routeMetrics = new Map<string, RouteMetric>();
const rateLimitBuckets = new Map<string, RateLimitBucket>();
const captchaChallenges = new Map<string, CaptchaChallenge>();
const captchaVerifications = new Map<string, CaptchaVerification>();
const loginAttempts = new Map<string, LoginAttempt>();
const captchaRequiredRounds = 2;
const rateLimitWindowMs = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
const generationMaintenanceIntervalMs = envNumber("GENERATION_MAINTENANCE_INTERVAL_MS", 60_000);
const rateLimitRules: RateLimitRule[] = [
  {
    id: "auth-captcha",
    method: "GET",
    pattern: /^\/api\/auth\/captcha$/,
    max: envNumber("RATE_LIMIT_CAPTCHA_MAX", 60)
  },
  { id: "auth-login", method: "POST", pattern: /^\/api\/auth\/login$/, max: envNumber("RATE_LIMIT_AUTH_MAX", 20) },
  {
    id: "auth-register",
    method: "POST",
    pattern: /^\/api\/auth\/register$/,
    max: envNumber("RATE_LIMIT_AUTH_MAX", 20)
  },
  {
    id: "auth-password-reset-request",
    method: "POST",
    pattern: /^\/api\/auth\/request-password-reset$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-password-reset",
    method: "POST",
    pattern: /^\/api\/auth\/reset-password$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-resend-verification",
    method: "POST",
    pattern: /^\/api\/auth\/resend-verification$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5),
    keyBy: "user"
  },
  {
    id: "auth-change-password",
    method: "POST",
    pattern: /^\/api\/auth\/change-password$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-change-email",
    method: "POST",
    pattern: /^\/api\/auth\/change-email$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
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
  },
  {
    id: "preview-url",
    method: "POST",
    pattern: /^\/api\/images\/[^/]+\/preview-url$/,
    max: envNumber("RATE_LIMIT_PREVIEW_MAX", envNumber("RATE_LIMIT_DOWNLOAD_MAX", 60))
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
  origin: [...allowedWriteOrigins()],
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

  request.userId = userId;
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

app.setErrorHandler(async (error, request, reply) => {
  const requestId = request.requestId ?? randomUUID();
  const duration = Date.now() - (request.startedAt ?? Date.now());

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      await recordHttpIncident(request, {
        severity: "critical",
        errorCode: error.code,
        message: error.message,
        taskId: stringDetail(error.details, "taskId"),
        orderId: stringDetail(error.details, "orderId")
      });
    }
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
    if (statusCode >= 500) {
      await recordHttpIncident(request, {
        severity: "critical",
        errorCode: "HTTP_ERROR",
        message
      });
    }
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
      errorCode: "UNHANDLED_ERROR",
      duration
    },
    "Unhandled error"
  );
  await recordHttpIncident(request, {
    severity: "critical",
    errorCode: "UNHANDLED_ERROR",
    message: error instanceof Error ? error.message : "Unhandled server error"
  });

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

// filesystem 存储模式下的文件回读：复刻 S3 signed URL 的私有 + 过期语义。
// getSignedUrl 生成 /api/files/<key>?expiresAt=&signature=，这里校验 HMAC 与过期后回读磁盘文件。
// 仅在 STORAGE_PROVIDER=filesystem 时挂载，其余模式该路由不存在（图片走 data: 内联或 S3 直链）。
if (storage instanceof FilesystemObjectStorage) {
  const filesystemStorage = storage;
  app.get("/api/files/*", async (request, reply) => {
    const key = (request.params as Record<string, string>)["*"];
    const query = fileSignatureQuerySchema.parse(request.query);
    let filePath: string;
    try {
      filePath = filesystemStorage.verifyAndResolve(key, Number(query.expiresAt), query.signature);
    } catch (error) {
      throw new AppError("FORBIDDEN", errorMessage(error, "Signed URL is invalid"), 403);
    }
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      throw new AppError("NOT_FOUND", "File was not found", 404);
    }
    reply.header("content-type", contentTypeForStorageKey(key));
    reply.header("cache-control", "private, max-age=300");
    return reply.send(body);
  });
}

app.get("/api/auth/captcha", async (request) => {
  pruneCaptchaChallenges();
  pruneCaptchaVerifications();
  const challenge = createCaptchaChallenge();
  const captchaId = randomUUID();
  const expiresAt = new Date(Date.now() + envNumber("CAPTCHA_TTL_SECONDS", 180) * 1000).toISOString();
  captchaChallenges.set(captchaId, {
    answerHash: hashCaptchaAnswer(challenge.answer),
    expiresAt,
    createdAt: new Date().toISOString()
  });
  return envelope(request, {
    captchaId,
    imageSvg: challenge.imageSvg,
    instruction: `请点击图中所有${challenge.targetLabel}`,
    targetLabel: challenge.targetLabel,
    requiredSelections: challenge.answer.length,
    optionCount: captchaOptions.length,
    expiresAt,
    ...(exposeCaptchaAnswerForTests() ? { answer: challenge.answer } : {})
  });
});

app.post("/api/auth/captcha/verify", async (request) => {
  pruneCaptchaChallenges();
  pruneCaptchaVerifications();
  const input = captchaVerifySchema.parse(request.body);
  verifyCaptchaChallenge(input.captchaId, input.captchaSelections);
  const verificationId = randomUUID();
  const expiresAt = new Date(Date.now() + envNumber("CAPTCHA_VERIFICATION_TTL_SECONDS", 180) * 1000).toISOString();
  captchaVerifications.set(verificationId, {
    expiresAt,
    createdAt: new Date().toISOString()
  });
  return envelope(request, { verificationId, expiresAt });
});

app.post("/api/auth/register", async (request, reply) => {
  const input = registerSchema.parse(request.body);
  const result = await store.update(async (data) => {
    const email = input.email.toLowerCase();
    if (data.users.some((user) => user.email === email)) {
      throw new AppError("CONFLICT", "Unable to create account with these credentials", 409);
    }
    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      email,
      passwordHash: hashPassword(input.password),
      nickname: defaultNicknameForEmail(email),
      avatarUrl: null,
      emailVerifiedAt: null,
      role: "USER",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now
    };
    const sessionToken = randomUUID();
    const verifyTokenPlain = randomUUID();
    const verifyTokenHash = createHash("sha256").update(verifyTokenPlain).digest("hex");
    const verifyTtlHours = envNumber("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24);
    const verifyExpiresAt = new Date(Date.now() + verifyTtlHours * 60 * 60 * 1000).toISOString();
    data.users.push(user);
    data.sessions.push({ token: sessionToken, userId: user.id, createdAt: now, expiresAt: addDays(now, 14) });
    data.emailVerificationTokens.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: verifyTokenHash,
      expiresAt: verifyExpiresAt,
      usedAt: null,
      createdAt: now
    });
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
      createdAt: now,
      expiresAt: null
    });
    setSessionCookie(reply, sessionToken, addDays(now, 14));
    reply.status(201);
    return { user, verifyTokenPlain };
  });

  const verifyUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/verify-email?token=${result.verifyTokenPlain}`;
  // 发信成败通过 emailDelivered 透传给前端：失败时提示用户可稍后重发，不再假装一切正常。
  let emailDelivered = false;
  try {
    await mailer.sendEmail(
      buildVerificationEmail({ to: result.user.email, nickname: result.user.nickname, verifyUrl })
    );
    emailDelivered = true;
    request.log.info({ userId: result.user.id }, "Verification email sent");
  } catch (error) {
    request.log.error({ userId: result.user.id, error }, "Failed to send verification email");
  }

  return envelope(request, { user: publicUser(result.user), emailDelivered });
});

app.post("/api/auth/login", async (request, reply) => {
  const input = loginSchema.parse(request.body);
  // 两条放行路径：① 已有未耗尽的登录尝试令牌 → 扣一次额度直接放行；
  // ② 无有效令牌 → 必须提交两轮图片验证，验过后签发新令牌。
  if (consumeLoginAttempt(request)) {
    // 走令牌路径：本次尝试无需重做图片验证。
  } else {
    if (!input.captchaVerificationIds || input.captchaVerificationIds.length !== captchaRequiredRounds) {
      throw new AppError("CAPTCHA_REQUIRED", "Image verification is required", 400);
    }
    verifyCaptchaVerifications(input.captchaVerificationIds);
    // 签发带额度的尝试令牌并扣掉本次；密码错误时令牌保留，前端可直接重输密码。
    issueLoginAttempt(reply);
    consumeLoginAttempt(request);
  }

  return store.update(async (data) => {
    const user = data.users.find((item) => item.email === input.email.toLowerCase());
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      // 密码错误：不清令牌，前端凭剩余额度可直接重试而无需重验。
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
    // 登录成功：作废尝试令牌。
    clearLoginAttempt(request, reply);
    return envelope(request, { user: publicUser(user) });
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

// 修改密码：必须校验旧密码，成功后签发新会话并踢掉其余会话，防止旧凭据继续有效。
app.post("/api/auth/change-password", async (request, reply) => {
  const { user } = await requireAuth(request);
  const input = changePasswordSchema.parse(request.body);
  return store.update(async (data) => {
    const current = mustFindUser(data, user.id);
    if (!verifyPassword(input.currentPassword, current.passwordHash)) {
      throw new AppError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 400);
    }
    const now = new Date().toISOString();
    current.passwordHash = hashPassword(input.newPassword);
    current.updatedAt = now;
    // 清掉该用户的所有会话，再为当前请求签发一个新会话，避免用户在本设备上被强制登出。
    const newToken = randomUUID();
    data.sessions = data.sessions.filter((session) => session.userId !== user.id);
    data.sessions.push({ token: newToken, userId: user.id, createdAt: now, expiresAt: addDays(now, 14) });
    setSessionCookie(reply, newToken, addDays(now, 14));
    request.log.info({ userId: user.id }, "Password changed");
    return envelope(request, { ok: true, message: "Password changed successfully" });
  });
});

// 修改邮箱：校验密码 + 查重，换邮箱后重置验证状态并发送新的验证邮件。
app.post("/api/auth/change-email", async (request) => {
  const { user } = await requireAuth(request);
  const input = changeEmailSchema.parse(request.body);
  const result = await store.update(async (data) => {
    const current = mustFindUser(data, user.id);
    if (!verifyPassword(input.currentPassword, current.passwordHash)) {
      throw new AppError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 400);
    }
    const nextEmail = input.newEmail.toLowerCase();
    if (nextEmail === current.email) {
      throw new AppError("VALIDATION_ERROR", "New email is the same as the current email", 400);
    }
    if (data.users.some((item) => item.id !== current.id && item.email === nextEmail)) {
      throw new AppError("CONFLICT", "Unable to update email with this address", 409);
    }
    const now = new Date().toISOString();
    current.email = nextEmail;
    current.emailVerifiedAt = null;
    current.updatedAt = now;

    const verifyTokenPlain = randomUUID();
    const verifyTokenHash = createHash("sha256").update(verifyTokenPlain).digest("hex");
    const verifyTtlHours = envNumber("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24);
    const verifyExpiresAt = new Date(Date.now() + verifyTtlHours * 60 * 60 * 1000).toISOString();
    data.emailVerificationTokens = data.emailVerificationTokens.filter((t) => t.userId !== current.id || t.usedAt);
    data.emailVerificationTokens.push({
      id: randomUUID(),
      userId: current.id,
      tokenHash: verifyTokenHash,
      expiresAt: verifyExpiresAt,
      usedAt: null,
      createdAt: now
    });
    return { user: current, verifyTokenPlain };
  });

  const verifyUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/verify-email?token=${result.verifyTokenPlain}`;
  try {
    await mailer.sendEmail(
      buildVerificationEmail({ to: result.user.email, nickname: result.user.nickname, verifyUrl })
    );
    request.log.info({ userId: result.user.id }, "Verification email sent after email change");
  } catch (error) {
    request.log.error({ userId: result.user.id, error }, "Failed to send verification email after email change");
  }
  return envelope(request, { user: publicUser(result.user) });
});

// 会话列表：展示当前用户所有有效会话，并标记当前请求所在会话。
app.get("/api/auth/sessions", async (request) => {
  const { user, data } = await requireAuth(request);
  const currentToken = sessionToken(request);
  const sessions = data.sessions
    .filter((session) => session.userId === user.id)
    .sort(descCreated)
    .map((session) => ({
      id: createHash("sha256").update(session.token).digest("hex").slice(0, 24),
      current: session.token === currentToken,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    }));
  return envelope(request, { sessions });
});

// 登出其他所有设备：只保留当前会话，清掉该用户其余会话。
app.post("/api/auth/logout-others", async (request) => {
  const { user } = await requireAuth(request);
  const currentToken = sessionToken(request);
  const removed = await store.update((data) => {
    const before = data.sessions.length;
    data.sessions = data.sessions.filter(
      (session) => session.userId !== user.id || session.token === currentToken
    );
    return before - data.sessions.length;
  });
  request.log.info({ userId: user.id, removed }, "Logged out other sessions");
  return envelope(request, { ok: true, removed });
});

// 注销账户：软删（status=DELETED），墓碑化邮箱以释放原邮箱供重新注册，清会话并审计留档。
// 积分/订单等数据保留不动，仅停用账户；requireAuth 会自动拦截非 ACTIVE 账户。
app.post("/api/auth/delete-account", async (request, reply) => {
  const { user } = await requireAuth(request);
  const input = deleteAccountSchema.parse(request.body);
  await store.update((data) => {
    const current = mustFindUser(data, user.id);
    if (!verifyPassword(input.currentPassword, current.passwordHash)) {
      throw new AppError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 401);
    }
    if (current.role === "ADMIN") {
      const otherActiveAdmins = data.users.filter(
        (item) => item.id !== current.id && item.role === "ADMIN" && item.status === "ACTIVE"
      );
      if (otherActiveAdmins.length === 0) {
        throw new AppError("VALIDATION_ERROR", "Cannot remove the last active administrator", 400);
      }
    }
    const now = new Date().toISOString();
    const originalEmail = current.email;
    // 墓碑化邮箱：把原邮箱挪到一个不可登录的占位地址，释放原邮箱供他人/本人重新注册。
    const tombstoneEmail = `deleted+${current.id}@deleted.imagora.local`;
    const before = { email: originalEmail, status: current.status };
    current.email = tombstoneEmail;
    current.status = "DELETED";
    current.updatedAt = now;
    // 清掉该用户所有会话，注销后立即失效。
    data.sessions = data.sessions.filter((session) => session.userId !== current.id);
    // 清理未使用的验证/重置令牌，避免遗留可用凭据。
    data.emailVerificationTokens = data.emailVerificationTokens.filter((t) => t.userId !== current.id);
    data.passwordResetTokens = data.passwordResetTokens.filter((t) => t.userId !== current.id);
    audit(
      data,
      current.id,
      "account.self-delete",
      "USER",
      current.id,
      input.reason ?? null,
      before,
      { email: tombstoneEmail, status: "DELETED" },
      request
    );
    request.log.info({ userId: current.id }, "Account self-deleted");
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

app.post("/api/auth/verify-email", async (request) => {
  const input = z.object({ token: z.string().min(1) }).parse(request.body);
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const data = await store.read();
  const verifyToken = data.emailVerificationTokens.find((t) => t.tokenHash === tokenHash && !t.usedAt);
  if (!verifyToken || new Date(verifyToken.expiresAt) < new Date()) {
    throw new AppError("INVALID_VERIFY_TOKEN", "Invalid or expired verification token", 400);
  }
  return store.update(async (data) => {
    const user = mustFindUser(data, verifyToken.userId);
    const now = new Date().toISOString();
    user.emailVerifiedAt = now;
    user.updatedAt = now;
    const token = data.emailVerificationTokens.find((t) => t.tokenHash === tokenHash);
    if (token) {
      token.usedAt = now;
    }
    request.log.info({ userId: user.id }, "Email verified");
    return envelope(request, { ok: true, email: user.email });
  });
});

app.post("/api/auth/resend-verification", async (request) => {
  const { user } = await requireAuth(request);
  if (user.emailVerifiedAt) {
    return envelope(request, { ok: true, message: "Email is already verified" });
  }
  return store.update(async (data) => {
    // 重发冷却：同一用户两次重发至少间隔 RESEND_VERIFICATION_COOLDOWN_SECONDS（默认 60s），
    // 防连点轰炸收件箱、省邮件配额。此处尚无写入，抛错回滚无副作用。
    const cooldownSeconds = envNumber("RESEND_VERIFICATION_COOLDOWN_SECONDS", 60);
    const lastToken = data.emailVerificationTokens
      .filter((t) => t.userId === user.id && !t.usedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (lastToken) {
      const elapsedMs = Date.now() - new Date(lastToken.createdAt).getTime();
      const remainingMs = cooldownSeconds * 1000 - elapsedMs;
      if (remainingMs > 0) {
        throw new AppError("RESEND_TOO_SOON", "Verification email was sent recently, please wait before retrying", 429, {
          retryAfterSeconds: Math.ceil(remainingMs / 1000)
        });
      }
    }
    const now = new Date().toISOString();
    const verifyTokenPlain = randomUUID();
    const verifyTokenHash = createHash("sha256").update(verifyTokenPlain).digest("hex");
    const verifyTtlHours = envNumber("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24);
    const verifyExpiresAt = new Date(Date.now() + verifyTtlHours * 60 * 60 * 1000).toISOString();
    data.emailVerificationTokens = data.emailVerificationTokens.filter((t) => t.userId !== user.id || t.usedAt);
    data.emailVerificationTokens.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: verifyTokenHash,
      expiresAt: verifyExpiresAt,
      usedAt: null,
      createdAt: now
    });
    const verifyUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/verify-email?token=${verifyTokenPlain}`;
    try {
      await mailer.sendEmail(buildVerificationEmail({ to: user.email, nickname: user.nickname, verifyUrl }));
      request.log.info({ userId: user.id }, "Verification email resent");
    } catch (error) {
      request.log.error({ userId: user.id, error }, "Failed to resend verification email");
    }
    return envelope(request, { ok: true, message: "Verification email sent" });
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

app.get("/api/users/me/safety-events", async (request) => {
  const { user, data } = await requireAuth(request);
  const query = paginationSchema.parse(request.query);
  const events = data.safetyEvents
    .filter((event) => event.userId === user.id)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { events });
});

app.post("/api/generation/quote", async (request) => {
  assertFeatureEnabled("generation");
  await requireAuth(request);
  const input = generationInputSchema.parse(request.body);
  const estimatedCost = quote(input);
  return envelope(request, { creditCost: estimatedCost, balanceRequired: estimatedCost });
});

app.post("/api/generation/tasks", async (request, reply) => {
  assertFeatureEnabled("generation");
  const { user } = await requireAuth(request);
  assertEmailVerified(user);
  const input = generationInputSchema.parse(request.body);
  const { providerMetadata: resolvedProviderMetadata, model: resolvedModel } = resolveGenerationProviderSelection(
    input.model
  );
  const cost = quote({ ...input, model: resolvedModel });
  const result = await store.update(async (data) => {
    const duplicate = data.generationTasks.find(
      (task) => task.userId === user.id && task.clientRequestId === input.clientRequestId
    );
    if (duplicate) {
      return {
        task: taskWithRefund(data, duplicate),
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
        .map((rule) => rule.term),
      reviewTerms: data.safetyRules
        .filter((rule) => rule.status === "ACTIVE" && rule.action === "REVIEW")
        .map((rule) => rule.term)
    });
    if (safety.status === "BLOCKED" || safety.status === "REVIEW_REQUIRED") {
      // 注意：store.update 在回调抛异常时会回滚，不落库。安全事件必须靠“正常返回”提交，
      // 再在事务外抛 AppError，否则待复核/拦截记录会随回滚丢失，人工复核队列永远为空。
      data.safetyEvents.push({
        id: randomUUID(),
        userId: user.id,
        targetType: "PROMPT",
        targetId: input.clientRequestId,
        status: safety.status,
        reasonCode: safety.reasonCode,
        reasonMessage: safety.reasonMessage,
        provider: safety.provider,
        createdAt: new Date().toISOString()
      });
      return { blocked: true as const, safety };
    }
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
      modelProvider: resolvedProviderMetadata.name,
      modelName: resolvedModel,
      status: "PENDING",
      creditCost: cost,
      providerCostCents: 0,
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
      blocked: false as const,
      task: taskWithRefund(data, task),
      balanceAfter: mustFindCreditAccount(data, user.id).balance,
      enqueue: true,
      requestedAt: now
    };
  });
  if (result.blocked) {
    // 安全事件已在上面的事务里落库，这里才安全地抛错拦截请求。
    // REVIEW_REQUIRED 用独立错误码，前端才能给出“人工复核 + 申诉”文案，而不是笼统的拦截提示。
    const review = result.safety.status === "REVIEW_REQUIRED";
    throw new AppError(
      review ? "CONTENT_REVIEW_REQUIRED" : "CONTENT_BLOCKED",
      review ? "Prompt requires manual safety review" : "Prompt was blocked by safety rules",
      400,
      { ...result.safety }
    );
  }
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

  const result = await store.update(async (data) => {
    if (safety.status === "BLOCKED" || safety.status === "REVIEW_REQUIRED") {
      // 同 /api/generation/tasks：安全事件必须靠正常返回提交，抛异常会回滚导致记录丢失
      data.safetyEvents.push({
        id: randomUUID(),
        userId: user.id,
        targetType: "UPLOAD_IMAGE",
        targetId: upload.contentHash,
        status: safety.status,
        reasonCode: safety.reasonCode,
        reasonMessage: safety.reasonMessage,
        provider: safety.provider,
        createdAt: new Date().toISOString()
      });
      return { blocked: true as const, safety };
    }

    const existing = data.referenceImages.find(
      (image) => image.userId === user.id && image.contentHash === upload.contentHash && !image.deletedAt
    );
    if (existing) {
      return { blocked: false as const, referenceImage: existing, duplicate: true, created: false };
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
    return { blocked: false as const, referenceImage, duplicate: false, created: true };
  });
  if (result.blocked) {
    // 安全事件已在事务里落库,这里才抛错拦截。参考图 REVIEW 同样拦截,因为花钱的是后续生成而非上传本身。
    const review = result.safety.status === "REVIEW_REQUIRED";
    throw new AppError(
      review ? "CONTENT_REVIEW_REQUIRED" : "CONTENT_BLOCKED",
      review ? "Reference image requires manual safety review" : "Reference image was blocked by safety rules",
      400,
      { ...result.safety }
    );
  }
  if (result.created) {
    reply.status(201);
  }
  return envelope(request, { referenceImage: result.referenceImage, duplicate: result.duplicate });
});

app.get("/api/generation/tasks", async (request) => {
  const { user, data } = await requireAuth(request);
  const query = taskQuerySchema.parse(request.query);
  const tasks = data.generationTasks
    .filter((task) => task.userId === user.id)
    .filter((task) => (query.status ? task.status === query.status : true))
    .sort(descCreated)
    .slice(0, query.limit)
    .map((task) => taskWithRefund(data, task));
  return envelope(request, { tasks });
});

app.get("/api/generation/tasks/:taskId", async (request) => {
  const { user, data } = await requireAuth(request);
  const { taskId } = idParamSchema.parse(request.params);
  const task = mustFindOwnTask(data, user.id, taskId);
  const images = data.generatedImages
    .filter((image) => image.taskId === task.id && !image.deletedAt)
    .map(withoutImagePublicUrl);
  return envelope(request, { task: taskWithRefund(data, task), images });
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

app.post("/api/images/:imageId/preview-url", async (request) => {
  const { user, data } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const image = mustFindOwnImage(data, user.id, imageId);
  const expiresInSeconds = Math.max(
    60,
    Math.min(envNumber("PREVIEW_URL_TTL_MINUTES", envNumber("DOWNLOAD_URL_TTL_MINUTES", 15)) * 60, 60 * 60 * 24 * 7)
  );
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const inlineOriginalUrl = resolveInlineDataUrl(image.publicUrl);

  return envelope(request, {
    url: inlineOriginalUrl ?? (await storage.getSignedUrl(image.storageKey, expiresInSeconds)),
    expiresAt
  });
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
    mustFindOwnImage(data, user.id, imageId);
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
  const expiresInSeconds = Math.max(60, Math.min(envNumber("DOWNLOAD_URL_TTL_MINUTES", 15) * 60, 60 * 60 * 24 * 7));
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  return envelope(request, {
    url: await storage.getSignedUrl(image.storageKey, expiresInSeconds),
    fileName: `imagora-${image.id}.${extensionForMimeType(image.mimeType)}`,
    expiresAt
  });
});

app.delete("/api/images/:imageId", async (request) => {
  const { user, data } = await requireAuth(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const image = mustFindOwnImage(data, user.id, imageId);
  await storage.deleteObject(image.storageKey);
  if (image.thumbnailKey && image.thumbnailKey !== image.storageKey) {
    await storage.deleteObject(image.thumbnailKey);
  }
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

app.get("/api/admin/dashboard", async (request) => {
  await requireAdmin(request);
  return store.update((data) => {
    runOrderMaintenance(data);
    const paidRevenueCents = data.orders
      .filter((order) => order.status === "PAID")
      .reduce((sum, order) => sum + order.amountCents, 0);
    // AI 成本仅统计已成功产出的任务，避免把失败退款任务的名义成本算进毛利
    const aiCostCents = data.generationTasks
      .filter((task) => task.status === "SUCCEEDED")
      .reduce((sum, task) => sum + (task.providerCostCents ?? 0), 0);
    return envelope(request, {
      metrics: {
        users: data.users.length,
        tasks: data.generationTasks.length,
        images: data.generatedImages.length,
        paidOrders: data.orders.filter((order) => order.status === "PAID").length,
        paidRevenueCents,
        aiCostCents,
        grossProfitCents: paidRevenueCents - aiCostCents,
        blockedSafetyEvents: data.safetyEvents.filter((event) => event.status === "BLOCKED").length,
        reviewRequiredSafetyEvents: data.safetyEvents.filter((event) => event.status === "REVIEW_REQUIRED").length
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
    const alerts = operationalAlertsSnapshot(data, http);
    recordLocalAlertNotifications(data, alerts);
    return envelope(request, {
      service: {
        uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1000),
        startedAt: new Date(serviceStartedAt).toISOString(),
        features: featureFlags()
      },
      http,
      domain,
      maintenance,
      alerts,
      recentIncidents: data.operationalIncidents.sort(descUpdated).slice(0, 12),
      alertNotifications: data.alertNotifications.sort(descCreated).slice(0, 12)
    });
  });
});

app.post("/api/admin/maintenance/reconcile", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const input = adminReasonSchema.parse(request.body ?? {});
  return store.update((data) => {
    const maintenance = runOrderMaintenance(data);
    audit(
      data,
      admin.id,
      "maintenance.reconcile",
      "SYSTEM",
      "platform",
      input.reason,
      null,
      { ...maintenance },
      request
    );
    return envelope(request, { maintenance });
  });
});

app.post("/api/admin/maintenance/reconcile-generation", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const input = adminReasonSchema.parse(request.body ?? {});
  return store.update((data) => {
    const maintenance = runGenerationMaintenance(data, generationMaintenanceOptions());
    audit(
      data,
      admin.id,
      "maintenance.generation.reconcile",
      "SYSTEM",
      "generation",
      input.reason,
      null,
      { ...maintenance },
      request
    );
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
  const orders = data.orders
    .filter((o) => o.userId === userId)
    .sort(descCreated)
    .slice(0, 10);
  const tasks = data.generationTasks
    .filter((t) => t.userId === userId)
    .sort(descCreated)
    .slice(0, 10);
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
  const input = adminStatusSchema.parse(request.body);
  return store.update((data) => {
    const target = mustFindUser(data, userId);
    if (target.id === admin.id) {
      throw new AppError("VALIDATION_ERROR", "Admin cannot change own status here", 400);
    }
    if (target.role === "ADMIN" && input.status !== "ACTIVE") {
      const otherActiveAdmins = data.users.filter(
        (user) => user.id !== target.id && user.role === "ADMIN" && user.status === "ACTIVE"
      );
      if (otherActiveAdmins.length === 0) {
        throw new AppError("VALIDATION_ERROR", "Cannot remove the last active administrator", 400);
      }
    }
    const before = { status: target.status };
    target.status = input.status;
    target.updatedAt = new Date().toISOString();
    audit(
      data,
      admin.id,
      "user.status.update",
      "USER",
      target.id,
      input.reason,
      before,
      { status: target.status },
      request
    );
    return envelope(request, { user: withoutPassword(target) });
  });
});

app.post("/api/admin/users/:userId/credits/adjust", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { userId } = userParamSchema.parse(request.params);
  const input = adjustCreditSchema.parse(request.body);
  // 大额人工调整必须显式二次确认，防止误触多敲一个零就发出去
  const largeAdjustThreshold = envNumber("ADMIN_CREDIT_ADJUST_THRESHOLD", 1000);
  if (Math.abs(input.amount) >= largeAdjustThreshold && !input.confirm) {
    throw new AppError("VALIDATION_ERROR", "大额积分调整需要二次确认", 400, {
      requiresConfirmation: true,
      threshold: largeAdjustThreshold,
      amount: input.amount
    });
  }
  return store.update((data) => {
    mustFindUser(data, userId);
    const account = mustFindCreditAccount(data, userId);
    const before = { balance: account.balance };
    // 幂等键随请求传入，重复提交只执行一次，也不重复写审计
    const applied = adjustCredits(
      data,
      userId,
      input.amount,
      admin.id,
      `admin-adjust:${input.clientRequestId}`,
      input.reason
    );
    if (applied) {
      audit(
        data,
        admin.id,
        "user.credits.adjust",
        "USER",
        userId,
        input.reason,
        before,
        { balance: account.balance },
        request
      );
    }
    return envelope(request, { account });
  });
});

app.get("/api/admin/generation/tasks", async (request) => {
  const query = adminTaskQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const tasks = data.generationTasks
    .filter((task) => !query.status || task.status === query.status)
    .filter((task) => !query.userId || task.userId === query.userId)
    .filter((task) => matchesCreatedRange(task.createdAt, query))
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { tasks });
});

app.get("/api/admin/generation/tasks/:taskId", async (request) => {
  await requireAdmin(request);
  const { taskId } = idParamSchema.parse(request.params);
  const data = await store.read();
  const task = mustFindTask(data, taskId);
  const user = mustFindUser(data, task.userId);
  const images = data.generatedImages.filter((image) => image.taskId === task.id).sort(descCreated);
  return envelope(request, { task, user: withoutPassword(user), images });
});

app.get("/api/admin/images", async (request) => {
  const query = adminImageQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const images = data.generatedImages
    .filter((image) => !query.visibility || image.visibility === query.visibility)
    .filter((image) => !query.userId || image.userId === query.userId)
    .filter((image) => matchesCreatedRange(image.createdAt, query))
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { images });
});

app.get("/api/admin/images/:imageId", async (request) => {
  await requireAdmin(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const data = await store.read();
  const image = mustFindImage(data, imageId);
  const user = mustFindUser(data, image.userId);
  const task = mustFindTask(data, image.taskId);
  return envelope(request, { image, user: withoutPassword(user), task });
});

app.patch("/api/admin/images/:imageId/visibility", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { imageId } = imageParamSchema.parse(request.params);
  const input = adminVisibilitySchema.parse(request.body);
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
      input.reason,
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
    .filter((order) => !query.orderNo || order.orderNo.toLowerCase().includes(query.orderNo.toLowerCase()))
    .filter((order) => matchesCreatedRange(order.createdAt, query))
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { orders });
});

app.get("/api/admin/orders/:orderId", async (request) => {
  await requireAdmin(request);
  const { orderId } = orderParamSchema.parse(request.params);
  const data = await store.read();
  const order = mustFindOrder(data, orderId);
  const user = mustFindUser(data, order.userId);
  const plan = data.plans.find((item) => item.id === order.planId);
  if (!plan) {
    throw new AppError("NOT_FOUND", "Plan was not found", 404);
  }
  const paymentEvents = data.paymentEvents.filter((event) => event.orderId === order.id).sort(descCreated);
  return envelope(request, { order, user: withoutPassword(user), plan, paymentEvents });
});

app.get("/api/admin/plans", async (request) => {
  const { data } = await requireAdmin(request);
  return envelope(request, { plans: data.plans.sort((a, b) => a.sortOrder - b.sortOrder) });
});

app.post("/api/admin/plans", async (request, reply) => {
  const { user: admin } = await requireAdmin(request);
  const input = adminPlanSchema.parse(request.body);
  return store.update((data) => {
    const now = new Date().toISOString();
    const plan: Plan = { id: randomUUID(), ...stripAdminReason(input), createdAt: now, updatedAt: now };
    data.plans.push(plan);
    audit(
      data,
      admin.id,
      "plan.create",
      "PLAN",
      plan.id,
      input.reason,
      null,
      plan as unknown as Record<string, unknown>,
      request
    );
    reply.status(201);
    return envelope(request, { plan });
  });
});

app.patch("/api/admin/plans/:planId", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { planId } = planParamSchema.parse(request.params);
  const input = adminPlanPatchSchema.parse(request.body);
  return store.update((data) => {
    const plan = data.plans.find((item) => item.id === planId);
    if (!plan) {
      throw new AppError("NOT_FOUND", "Plan was not found", 404);
    }
    const before = { ...plan };
    Object.assign(plan, stripAdminReason(input), { updatedAt: new Date().toISOString() });
    audit(
      data,
      admin.id,
      "plan.update",
      "PLAN",
      plan.id,
      input.reason,
      before,
      plan as unknown as Record<string, unknown>,
      request
    );
    return envelope(request, { plan });
  });
});

app.get("/api/admin/audit-logs", async (request) => {
  const query = adminAuditQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const logs = data.adminAuditLogs
    .filter((log) => !query.adminUserId || log.adminUserId === query.adminUserId)
    .filter((log) => !query.action || log.action === query.action)
    .filter((log) => !query.targetType || log.targetType === query.targetType)
    .filter((log) => !query.targetId || log.targetId === query.targetId)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { logs });
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
    audit(data, admin.id, "safety-rule.create", "SAFETY_RULE", rule.id, null, null, { ...rule }, request);
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
    audit(data, admin.id, "safety-rule.update", "SAFETY_RULE", rule.id, null, before, { ...rule }, request);
    return envelope(request, { rule });
  });
});

app.get("/api/admin/safety-events", async (request) => {
  const query = safetyEventQuerySchema.parse(request.query);
  const { data } = await requireAdmin(request);
  const events = data.safetyEvents
    .filter((event) => !query.status || event.status === query.status)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { events });
});

app.patch("/api/admin/safety-events/:eventId", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { eventId } = safetyEventParamSchema.parse(request.params);
  const input = safetyEventReviewSchema.parse(request.body);
  return store.update((data) => {
    const event = data.safetyEvents.find((item) => item.id === eventId);
    if (!event) {
      throw new AppError("NOT_FOUND", "Safety event was not found", 404);
    }
    if (event.status !== "REVIEW_REQUIRED") {
      throw new AppError("VALIDATION_ERROR", "Only pending safety reviews can be handled", 400);
    }
    const before = { ...event };
    event.status = input.status;
    event.reasonMessage = `${event.reasonMessage}；人工复核：${input.reason}`;
    audit(data, admin.id, "safety-event.review", "SAFETY_EVENT", event.id, input.reason, before, { ...event }, request);
    return envelope(request, { event });
  });
});

// ---- 用户申诉接口 ----

app.post("/api/safety-appeals", async (request) => {
  const { user } = await requireAuth(request);
  const input = safetyAppealCreateSchema.parse(request.body);
  return store.update((data) => {
    const event = data.safetyEvents.find((item) => item.id === input.safetyEventId && item.userId === user.id);
    if (!event) {
      throw new AppError("NOT_FOUND", "Safety event was not found", 404);
    }
    const existing = data.safetyAppeals.find(
      (appeal) => appeal.safetyEventId === input.safetyEventId && appeal.status === "PENDING"
    );
    if (existing) {
      throw new AppError("CONFLICT", "已有待处理的申诉，请等待结果后再提交", 409);
    }
    const now = new Date().toISOString();
    const appeal: SafetyAppeal = {
      id: randomUUID(),
      userId: user.id,
      safetyEventId: input.safetyEventId,
      reason: input.reason,
      status: "PENDING",
      adminNote: null,
      createdAt: now,
      resolvedAt: null
    };
    data.safetyAppeals.push(appeal);
    return envelope(request, { appeal });
  });
});

app.get("/api/safety-appeals", async (request) => {
  const { user } = await requireAuth(request);
  const data = await store.read();
  const appeals = data.safetyAppeals.filter((appeal) => appeal.userId === user.id).sort(descCreated);
  return envelope(request, { appeals });
});

app.get("/api/admin/safety-appeals", async (request) => {
  const query = safetyAppealAdminQuerySchema.parse(request.query);
  await requireAdmin(request);
  const data = await store.read();
  const appeals = data.safetyAppeals
    .filter((appeal) => !query.status || appeal.status === query.status)
    .sort(descCreated)
    .slice(0, query.limit);
  return envelope(request, { appeals });
});

app.patch("/api/admin/safety-appeals/:appealId", async (request) => {
  const { user: admin } = await requireAdmin(request);
  const { appealId } = safetyAppealParamSchema.parse(request.params);
  const input = safetyAppealReviewSchema.parse(request.body);
  return store.update((data) => {
    const appeal = data.safetyAppeals.find((item) => item.id === appealId);
    if (!appeal) {
      throw new AppError("NOT_FOUND", "Appeal was not found", 404);
    }
    if (appeal.status !== "PENDING") {
      throw new AppError("VALIDATION_ERROR", "Only pending appeals can be reviewed", 400);
    }
    const before = { ...appeal };
    const now = new Date().toISOString();
    appeal.status = input.status;
    appeal.adminNote = input.adminNote ?? null;
    appeal.resolvedAt = now;
    audit(
      data,
      admin.id,
      "safety-appeal.review",
      "SAFETY_APPEAL",
      appeal.id,
      input.adminNote ?? null,
      before,
      { ...appeal },
      request
    );
    return envelope(request, { appeal });
  });
});

// 导出 app 供测试用 app.inject 跑全链路。
export { app };

// API_NO_LISTEN=true 时只构建 app、不监听端口也不起后台定时器，
// 让测试可以 import 本模块后用 app.inject 而不真正占用端口。
if (process.env.API_NO_LISTEN !== "true") {
  startBackgroundGenerationMaintenance();
  startBackgroundAlertEvaluation();

  const port = Number(process.env.API_PORT ?? 4100);
  const host = process.env.API_HOST ?? "127.0.0.1";
  await app.listen({ port, host });
}

declare module "fastify" {
  interface FastifyRequest {
    requestId?: string;
    startedAt?: number;
    userId?: string;
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
  // 限流维度：默认按 IP；登录态接口应按 user，避免换 IP 绕过 / 同 NAT 出口互相误伤。
  keyBy?: "ip" | "user";
}

interface CaptchaChallenge {
  answerHash: string;
  expiresAt: string;
  createdAt: string;
}

interface CaptchaVerification {
  expiresAt: string;
  createdAt: string;
}

interface LoginAttempt {
  remaining: number;
  expiresAt: string;
  createdAt: string;
}

interface CaptchaSelection {
  x: number;
  y: number;
}

interface CaptchaOption {
  id: string;
  label: string;
  fill: string;
  accent: string;
}

interface CaptchaTile {
  option: CaptchaOption;
  row: number;
  column: number;
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
  expiredCredits: number;
  failedPendingGenerationTasks: number;
  failedRunningGenerationTasks: number;
  reconciledGenerationRefunds: number;
  refundedGenerationCredits: number;
}

type OperationalAlertSeverity = "warning" | "critical";
type OperationalIncidentSeverity = "info" | "warning" | "critical";
type OperationalArea = "generation" | "payments" | "http" | "system";

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

interface OperationalIncidentInput {
  severity: OperationalIncidentSeverity;
  area: OperationalArea;
  message: string;
  errorCode?: string | null;
  requestId?: string | null;
  userId?: string | null;
  taskId?: string | null;
  orderId?: string | null;
  route?: string | null;
}

const commonPasswordBlocklist = new Set([
  "123456",
  "12345678",
  "123456789",
  "admin123",
  "imagora",
  "imagora123",
  "password",
  "password123",
  "qwerty123"
]);

const emailSchema = z.string().trim().toLowerCase().min(1).max(254).email();
const loginPasswordSchema = z.string().min(1).max(128).refine(hasNoControlCharacters, {
  message: "Password contains unsupported characters"
});
const newPasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((password) => password.trim() === password, {
    message: "Password must not start or end with spaces"
  })
  .refine(hasNoControlCharacters, {
    message: "Password contains unsupported characters"
  })
  .refine((password) => /[A-Za-z]/.test(password) && /\d/.test(password), {
    message: "Password must include letters and numbers"
  })
  .refine((password) => !commonPasswordBlocklist.has(normalizePasswordForBlocklist(password)), {
    message: "Password is too common"
  });

const registerSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema
  })
  .strict()
  .superRefine((input, context) => {
    const emailName = input.email.split("@")[0]?.toLowerCase() ?? "";
    if (emailName.length >= 4 && input.password.toLowerCase().includes(emailName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Password must not include the email name"
      });
    }
  });

// captchaVerificationIds 变为可选：带有效登录尝试令牌重试时前端不再发验证码 ID。
// 提供时仍必须恰好 captchaRequiredRounds 个，保持首次验证的强度。
const loginSchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema,
    captchaVerificationIds: z.array(z.string().uuid()).length(captchaRequiredRounds).optional()
  })
  .strict();

// 仅校验图片验证字段：当没有有效登录尝试令牌时，login 必须带齐两轮 verificationId。
const loginCaptchaSchema = z.object({
  captchaVerificationIds: z.array(z.string().uuid()).length(captchaRequiredRounds)
});

const captchaVerifySchema = z
  .object({
    captchaId: z.string().uuid(),
    captchaSelections: z
      .array(
        z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1)
        })
      )
      .min(1)
      .max(6)
  })
  .strict();

const requestPasswordResetSchema = z.object({
  email: emailSchema
});

const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: newPasswordSchema
  })
  .strict();

const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional()
});

const changePasswordSchema = z
  .object({
    currentPassword: loginPasswordSchema,
    newPassword: newPasswordSchema
  })
  .strict()
  .superRefine((input, context) => {
    if (input.currentPassword === input.newPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: "New password must be different from the current password"
      });
    }
  });

const changeEmailSchema = z
  .object({
    newEmail: emailSchema,
    currentPassword: loginPasswordSchema
  })
  .strict();

// 注销账户：需要当前密码确认身份，reason 可选用于审计留档。
const deleteAccountSchema = z
  .object({
    currentPassword: loginPasswordSchema,
    reason: z.string().trim().max(500).optional()
  })
  .strict();

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
  quality: z.enum(["draft", "standard", "high"]),
  model: z.string().trim().min(1).max(80).optional()
});

const referenceUploadSchema = z.object({
  fileName: z.string().min(1).max(180),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  contentBase64: z.string().min(16).max(envNumber("UPLOAD_MAX_BASE64_CHARS", 8_000_000))
});

const fileSignatureQuerySchema = z.object({
  expiresAt: z.string().regex(/^\d+$/, "expiresAt must be a millisecond timestamp"),
  signature: z.string().regex(/^[a-f0-9]{64}$/, "signature must be a 64-char hex digest")
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const adminRangeQuerySchema = paginationSchema.extend({
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional()
});

const optionalPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
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

const adminTaskQuerySchema = adminRangeQuerySchema.extend({
  status: taskStatusSchema.optional(),
  userId: z.string().min(1).optional()
});

const adminImageQuerySchema = adminRangeQuerySchema.extend({
  visibility: imageVisibilitySchema.optional(),
  userId: z.string().min(1).optional()
});

const adminOrderQuerySchema = adminRangeQuerySchema.extend({
  status: orderStatusSchema.optional(),
  userId: z.string().min(1).optional(),
  orderNo: z.string().trim().min(1).max(80).optional()
});

const adminAuditQuerySchema = paginationSchema.extend({
  adminUserId: z.string().min(1).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  targetType: z.string().trim().min(1).max(80).optional(),
  targetId: z.string().trim().min(1).max(120).optional()
});

const idParamSchema = z.object({ taskId: z.string().min(1) });
const imageParamSchema = z.object({ imageId: z.string().min(1) });
const orderParamSchema = z.object({ orderId: z.string().min(1) });
const userParamSchema = z.object({ userId: z.string().min(1) });
const planParamSchema = z.object({ planId: z.string().min(1) });
const paymentWebhookParamSchema = z.object({ provider: z.string().min(1) });

const createOrderSchema = z.object({
  planId: z.string().min(1),
  paymentProvider: z.enum(["mock", "stripe", "wechat", "alipay"]).default("mock"),
  clientRequestId: z.string().min(8).max(120).optional()
});

const adminReasonSchema = z.object({ reason: z.string().trim().min(3).max(240) });
const statusSchema = z.object({ status: userStatusSchema });
const visibilitySchema = z.object({ visibility: imageVisibilitySchema });
const adjustCreditSchema = z.object({
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: "amount 不能为 0" })
    .refine((value) => Math.abs(value) <= 100000, { message: "单次调整不能超过 100000 积分" }),
  reason: z.string().min(3).max(240),
  confirm: z.boolean().optional(),
  // 幂等键由客户端在发起操作时生成一次，防止重复提交/网络重试把同一笔调整叠加执行
  clientRequestId: z.string().min(8).max(120)
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
const adminStatusSchema = statusSchema.merge(adminReasonSchema);
const adminVisibilitySchema = visibilitySchema.merge(adminReasonSchema);
const adminPlanSchema = planSchema.merge(adminReasonSchema);
const adminPlanPatchSchema = planPatchSchema.merge(adminReasonSchema);
const safetyRuleParamSchema = z.object({ ruleId: z.string().min(1) });
const safetyRuleSchema = z.object({
  term: z.string().min(2).max(120),
  action: z.enum(["BLOCK", "REVIEW"]),
  status: z.enum(["ACTIVE", "INACTIVE"])
});
const safetyRulePatchSchema = safetyRuleSchema.partial();
const safetyEventParamSchema = z.object({ eventId: z.string().min(1) });
const safetyEventQuerySchema = z.object({
  status: z.enum(["PASSED", "BLOCKED", "REVIEW_REQUIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
const safetyEventReviewSchema = z.object({ status: z.enum(["PASSED", "BLOCKED"]) }).merge(adminReasonSchema);
const safetyAppealParamSchema = z.object({ appealId: z.string().min(1) });
const safetyAppealCreateSchema = z.object({
  safetyEventId: z.string().min(1),
  reason: z.string().min(10).max(1000)
});
const safetyAppealAdminQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
const safetyAppealReviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNote: z.string().min(1).max(500).optional()
});

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

// trustProxy 决定 request.ip 取值：反代/网关后面必须开启，否则限流按代理 IP 计数直接失效。
// 支持三种配置：true/false 布尔；数字（信任的代理跳数）；逗号分隔的可信 IP/CIDR 列表。
function resolveTrustProxy(): boolean | number | string[] {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) {
    // 生产默认信任一层代理（常见于 Nginx/网关），本地开发关闭。
    return isProduction ? 1 : false;
  }
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 0) {
    return asNumber;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
  if (authorization?.startsWith("Bearer ")) {
    if (allowBearerSessionAuth()) {
      return authorization.slice("Bearer ".length);
    }
    throw new AppError("UNAUTHORIZED", "Bearer session auth is disabled", 401);
  }
  if (optional) {
    return "";
  }
  throw new AppError("UNAUTHORIZED", "Missing session token", 401);
}

function allowBearerSessionAuth(): boolean {
  return envBool("ALLOW_BEARER_SESSION_AUTH", false);
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

// 邮箱验证门槛：防止一次性邮箱注册即领 120 积分直接消耗。
// 开发/测试默认关闭（无痛调试）；生产默认开启，且 validateProductionConfig
// 会拒绝任何显式关闭（REQUIRE_EMAIL_VERIFICATION=false）的生产配置。
function requireEmailVerification(): boolean {
  return envBool("REQUIRE_EMAIL_VERIFICATION", process.env.NODE_ENV === "production");
}

function assertEmailVerified(user: User): void {
  if (!requireEmailVerification()) {
    return;
  }
  if (!user.emailVerifiedAt) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Email verification is required before generating images", 403);
  }
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
  appendSetCookie(
    reply,
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

// 追加一个 Set-Cookie 头，避免同一响应里多次 reply.header("set-cookie") 相互覆盖
// （典型场景：登录成功同时要种 session cookie 并清掉登录尝试令牌 cookie）。
function appendSetCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  if (existing === undefined) {
    reply.header("set-cookie", cookie);
    return;
  }
  const list = Array.isArray(existing) ? [...existing.map(String), cookie] : [String(existing), cookie];
  reply.header("set-cookie", list);
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

function quote(input: {
  style: StyleId;
  quality: Quality;
  quantity: number;
  aspectRatio: AspectRatio;
  model?: ModelId;
}): number {
  const { model } = resolveGenerationProviderSelection(input.model);
  return quoteImageGeneration({
    style: input.style,
    quality: input.quality,
    quantity: input.quantity,
    aspectRatio: input.aspectRatio,
    model
  }).creditCost;
}

function resolveGenerationProviderSelection(model?: ModelId): {
  providerMetadata: ReturnType<typeof getActiveProviderMetadata>;
  model: ModelId;
} {
  const requestedModel = parseGenerationModel(model);
  const providerMetadata = getActiveProviderMetadata();
  const fallbackModel = providerMetadata.modelName;
  try {
    const resolvedModel = resolveProviderModel(requestedModel ?? fallbackModel, providerMetadata.name);
    return {
      providerMetadata: {
        ...providerMetadata,
        modelName: resolvedModel
      },
      model: resolvedModel
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider model is not configured";
    if (
      providerMetadata.name === "mock" &&
      requestedModel &&
      isCompatibleOpenAiRequestForMockProvider(requestedModel)
    ) {
      return {
        providerMetadata: {
          ...providerMetadata,
          modelName: fallbackModel
        },
        model: fallbackModel
      };
    }
    throw new AppError("VALIDATION_ERROR", message, 400, { model: requestedModel });
  }
}

function parseGenerationModel(model?: ModelId): ModelId | undefined {
  const normalized = model?.trim();
  return normalized ? normalized : undefined;
}

function isCompatibleOpenAiRequestForMockProvider(model: ModelId): boolean {
  try {
    resolveProviderModel(model, "openai");
    return true;
  } catch {
    return false;
  }
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

function mustFindTask(data: StoreData, taskId: string): GenerationTask {
  const task = data.generationTasks.find((item) => item.id === taskId);
  if (!task) {
    throw new AppError("NOT_FOUND", "Task was not found", 404);
  }
  return task;
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

function mustFindImage(data: StoreData, imageId: string): GeneratedImage {
  const image = data.generatedImages.find((item) => item.id === imageId && !item.deletedAt);
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

async function ensureCheckoutUrl(data: StoreData, order: Order): Promise<string> {
  const existingCheckoutUrl = findCheckoutUrl(data, order);
  if (existingCheckoutUrl) {
    return existingCheckoutUrl;
  }
  const payment = await paymentProvider.createPayment({
    orderId: order.id,
    orderNo: order.orderNo,
    amountCents: order.amountCents,
    currency: order.currency
  });
  const now = new Date().toISOString();
  order.paymentIntentId = payment.paymentIntentId;
  order.updatedAt = now;
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
      currency: order.currency
    },
    processedAt: now,
    createdAt: now
  });
  return payment.checkoutUrl;
}

function findCheckoutUrl(data: StoreData, order: Order): string | null {
  const event = data.paymentEvents
    .filter(
      (item) =>
        item.provider === order.paymentProvider && item.orderId === order.id && item.eventType === "checkout.created"
    )
    .sort(descCreated)[0];
  const checkoutUrl = event?.payload.checkoutUrl;
  return typeof checkoutUrl === "string" && checkoutUrl.length > 0 ? checkoutUrl : null;
}

function findOrderByClientRequestId(data: StoreData, userId: string, clientRequestId: string): Order | null {
  const event = data.paymentEvents
    .filter(
      (item) => item.eventType === "checkout.created" && paymentEventClientRequestId(item.payload) === clientRequestId
    )
    .sort(descCreated)[0];
  if (!event) {
    return null;
  }
  return data.orders.find((order) => order.id === event.orderId && order.userId === userId) ?? null;
}

function runOrderMaintenance(data: StoreData): OrderMaintenanceResult {
  const now = new Date().toISOString();
  const expiredCredits = expireCredits(data);
  const generationMaintenance = runGenerationMaintenance(data, generationMaintenanceOptions());
  const closedExpiredOrders = closeExpiredPendingOrders(data, now);
  const reconciledPaymentEvents = reconcileSucceededPaymentEvents(data, now);
  const reconciledPaidOrders = reconcilePaidOrderCredits(data);
  return {
    closedExpiredOrders,
    reconciledPaidOrders,
    reconciledPaymentEvents,
    expiredCredits,
    failedPendingGenerationTasks: generationMaintenance.failedPendingTasks,
    failedRunningGenerationTasks: generationMaintenance.failedRunningTasks,
    reconciledGenerationRefunds: generationMaintenance.reconciledRefunds,
    refundedGenerationCredits: generationMaintenance.refundedCredits
  };
}

function generationMaintenanceOptions() {
  return {
    pendingTimeoutMs: envNumber("GENERATION_PENDING_TIMEOUT_MS", DEFAULT_PENDING_TASK_TIMEOUT_MS),
    runningTimeoutMs: envNumber("GENERATION_RUNNING_TIMEOUT_MS", DEFAULT_RUNNING_TASK_TIMEOUT_MS)
  };
}

function startBackgroundGenerationMaintenance(): void {
  if (generationMaintenanceIntervalMs <= 0) {
    return;
  }

  const timer = setInterval(() => {
    store
      .update((data) => {
        const generationMaintenance = runGenerationMaintenance(data, generationMaintenanceOptions());
        const expiredCredits = expireCredits(data);
        if (
          generationMaintenance.failedPendingTasks ||
          generationMaintenance.failedRunningTasks ||
          generationMaintenance.reconciledRefunds ||
          expiredCredits
        ) {
          logger.warn(
            {
              failedPendingTasks: generationMaintenance.failedPendingTasks,
              failedRunningTasks: generationMaintenance.failedRunningTasks,
              reconciledGenerationRefunds: generationMaintenance.reconciledRefunds,
              refundedGenerationCredits: generationMaintenance.refundedCredits,
              expiredCredits
            },
            "background generation maintenance reconciled tasks"
          );
        }
      })
      .catch((error) => {
        logger.error({ err: error }, "background generation maintenance failed");
      });
  }, generationMaintenanceIntervalMs);

  timer.unref();
}

function taskWithRefund(data: StoreData, task: GenerationTask): GenerationTask & { refundedCredits: number } {
  return {
    ...task,
    refundedCredits: taskRefundedCredits(data, task.id)
  };
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
    if (
      paymentEventAmount(event.payload) !== order.amountCents ||
      paymentEventOrderNo(event.payload) !== order.orderNo ||
      paymentEventCurrency(event.payload) !== normalizeCurrency(order.currency)
    ) {
      continue;
    }
    order.status = "PAID";
    order.paymentIntentId =
      order.paymentIntentId ?? paymentEventIntentId(event.payload) ?? `${event.provider}_pi_${order.id}`;
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
    grantCredits(
      data,
      order.userId,
      plan.credits,
      "ORDER",
      order.id,
      idempotencyKey,
      `Purchased ${plan.name}`,
      plan.validDays
    );
    reconciled += 1;
  }
  return reconciled;
}

function paymentEventAmount(payload: Record<string, unknown>): number | null {
  const amount = payload.amountCents;
  return typeof amount === "number" && Number.isInteger(amount) ? amount : null;
}

function paymentEventClientRequestId(payload: Record<string, unknown>): string | null {
  const clientRequestId = payload.clientRequestId;
  return typeof clientRequestId === "string" && clientRequestId.length > 0 ? clientRequestId : null;
}

function paymentFailureEvents(data: StoreData): PaymentEvent[] {
  return data.paymentEvents.filter((event) => {
    if (event.eventType !== "payment.succeeded") {
      return false;
    }
    const order = data.orders.find((item) => item.id === event.orderId);
    return Boolean(
      order &&
      (paymentEventAmount(event.payload) !== order.amountCents ||
        paymentEventOrderNo(event.payload) !== order.orderNo ||
        paymentEventCurrency(event.payload) !== normalizeCurrency(order.currency))
    );
  });
}

function paymentEventOrderNo(payload: Record<string, unknown>): string | null {
  const orderNo = payload.orderNo;
  return typeof orderNo === "string" && orderNo.length > 0 ? orderNo : null;
}

function paymentEventCurrency(payload: Record<string, unknown>): string | null {
  const currency = payload.currency;
  return typeof currency === "string" && currency.length > 0 ? normalizeCurrency(currency) : null;
}

function paymentEventIntentId(payload: Record<string, unknown>): string | null {
  const paymentIntentId = payload.paymentIntentId;
  return typeof paymentIntentId === "string" && paymentIntentId.length > 0 ? paymentIntentId : null;
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function normalizedPaymentPayload(input: {
  providerEventId: string;
  orderId: string;
  orderNo: string;
  amountCents: number;
  currency: string;
  paymentIntentId: string | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...input.payload,
    providerEventId: input.providerEventId,
    orderId: input.orderId,
    orderNo: input.orderNo,
    amountCents: input.amountCents,
    currency: normalizeCurrency(input.currency),
    paymentIntentId: input.paymentIntentId
  };
}

function applyPaymentSucceeded(
  data: StoreData,
  input: {
    provider: string;
    providerEventId: string;
    orderId: string;
    orderNo: string;
    eventType: string;
    amountCents: number;
    currency: string;
    paymentIntentId: string | null;
    requestId?: string | null;
    route?: string | null;
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
    payload: normalizedPaymentPayload(input),
    processedAt: now,
    createdAt: now
  });

  if (input.orderNo !== order.orderNo) {
    recordOperationalIncident(data, {
      severity: "critical",
      area: "payments",
      message: "Payment succeeded event order number did not match the order snapshot.",
      errorCode: "ORDER_NO_MISMATCH",
      requestId: input.requestId ?? null,
      userId: order.userId,
      orderId: order.id,
      route: input.route ?? null
    });
    return {
      order,
      balanceAfter: mustFindCreditAccount(data, order.userId).balance,
      credited: false,
      duplicateEvent: false,
      reason: "ORDER_NO_MISMATCH"
    };
  }

  if (normalizeCurrency(input.currency) !== normalizeCurrency(order.currency)) {
    recordOperationalIncident(data, {
      severity: "critical",
      area: "payments",
      message: "Payment succeeded event currency did not match the order snapshot.",
      errorCode: "CURRENCY_MISMATCH",
      requestId: input.requestId ?? null,
      userId: order.userId,
      orderId: order.id,
      route: input.route ?? null
    });
    return {
      order,
      balanceAfter: mustFindCreditAccount(data, order.userId).balance,
      credited: false,
      duplicateEvent: false,
      reason: "CURRENCY_MISMATCH"
    };
  }

  if (input.amountCents !== order.amountCents) {
    recordOperationalIncident(data, {
      severity: "critical",
      area: "payments",
      message: "Payment succeeded event amount did not match the order snapshot.",
      errorCode: "AMOUNT_MISMATCH",
      requestId: input.requestId ?? null,
      userId: order.userId,
      orderId: order.id,
      route: input.route ?? null
    });
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
  order.paymentIntentId = order.paymentIntentId ?? input.paymentIntentId ?? `${input.provider}_pi_${order.id}`;
  order.paidAt = now;
  order.updatedAt = now;
  grantCredits(
    data,
    order.userId,
    plan.credits,
    "ORDER",
    order.id,
    `order-grant:${order.id}`,
    `Purchased ${plan.name}`,
    plan.validDays
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
    createdAt: now,
    expiresAt: null
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
    refundTaskCredits(data, task, task.creditCost, "Generation task could not be queued");
    recordOperationalIncident(data, {
      severity: "critical",
      area: "generation",
      message,
      errorCode: code,
      userId: task.userId,
      taskId: task.id
    });
  });
}

function grantCredits(
  data: StoreData,
  userId: string,
  amount: number,
  sourceType: SourceType,
  sourceId: string,
  idempotencyKey: string,
  remark: string,
  validDays?: number | null
): void {
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return;
  }
  const account = mustFindCreditAccount(data, userId);
  const now = new Date().toISOString();
  account.balance += amount;
  account.totalEarned += amount;
  account.updatedAt = now;
  // 有效期为正数才形成过期批次，否则视为永久积分
  const expiresAt =
    typeof validDays === "number" && validDays > 0
      ? new Date(new Date(now).getTime() + validDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
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
    createdAt: now,
    expiresAt
  });
}

function adjustCredits(
  data: StoreData,
  userId: string,
  amount: number,
  adminUserId: string,
  idempotencyKey: string,
  remark: string
): boolean {
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return false;
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
    createdAt: now,
    expiresAt: null
  });
  return true;
}

function withFavorite(data: StoreData, userId: string, image: GeneratedImage): GeneratedImage & { favorite: boolean } {
  return {
    ...withoutImagePublicUrl(image),
    favorite: data.imageFavorites.some((favorite) => favorite.userId === userId && favorite.imageId === image.id)
  };
}

function withoutImagePublicUrl(image: GeneratedImage): GeneratedImage {
  return {
    ...image,
    publicUrl: "",
    // filesystem 模式下缩略图是 local://key，前端批量展示时直接当 <img src>，
    // 无法逐张调接口签名，这里就地签成 /api/files/... 长效链接。data:/https 直链原样透传。
    thumbnailUrl: signLocalThumbnailUrl(image.thumbnailUrl)
  };
}

// 把 worker 落库的 local://<key> 缩略图签名成前端可直连的 /api/files/<key> URL。
// 仅 filesystem 模式生效；其余模式 thumbnailUrl 已是 data: 或公开直链，原样返回。
function signLocalThumbnailUrl(thumbnailUrl: string): string {
  if (!(storage instanceof FilesystemObjectStorage) || !thumbnailUrl.startsWith("local://")) {
    return thumbnailUrl;
  }
  const key = thumbnailUrl.slice("local://".length);
  return storage.buildSignedUrl(key, thumbnailSignedUrlTtlSeconds());
}

function thumbnailSignedUrlTtlSeconds(): number {
  // 列表页可能久留，给足 TTL 降低裂图；上限受 storage 层 7 天封顶保护。
  return Math.max(60, envNumber("THUMBNAIL_URL_TTL_HOURS", 24) * 60 * 60);
}

function resolveInlineDataUrl(value: string): string | null {
  const normalized = value.trim();
  return normalized.startsWith("data:") ? normalized : null;
}

function audit(
  data: StoreData,
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason: string | null,
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
    reason,
    before,
    after,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? "",
    createdAt: new Date().toISOString()
  };
  data.adminAuditLogs.push(log);
}

function stripAdminReason<T extends { reason: string }>(input: T): Omit<T, "reason"> {
  const { reason: _reason, ...rest } = input;
  return rest;
}

function matchesCreatedRange(
  createdAt: string,
  query: { createdFrom?: string | undefined; createdTo?: string | undefined }
): boolean {
  const createdTime = new Date(createdAt).getTime();
  if (query.createdFrom && createdTime < new Date(query.createdFrom).getTime()) {
    return false;
  }
  if (query.createdTo && createdTime > new Date(query.createdTo).getTime()) {
    return false;
  }
  return true;
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

// 由 storage key 的扩展名反推 content-type，供 /api/files 回读时设置响应头。
function contentTypeForStorageKey(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
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

const captchaColumns = 4;
const captchaRows = 3;
const captchaOptions: CaptchaOption[] = [
  { id: "cow", label: "奶牛", fill: "#f8fafc", accent: "#0f172a" },
  { id: "duck", label: "鸭子", fill: "#fef3c7", accent: "#f59e0b" },
  { id: "panda", label: "熊猫", fill: "#f8fafc", accent: "#111827" },
  { id: "rabbit", label: "兔子", fill: "#ffe4e6", accent: "#fb7185" },
  { id: "fox", label: "狐狸", fill: "#ffedd5", accent: "#f97316" },
  { id: "seal", label: "海豹", fill: "#e0f2fe", accent: "#0284c7" },
  { id: "cat", label: "猫", fill: "#fef9c3", accent: "#ca8a04" },
  { id: "dog", label: "狗", fill: "#f5e8d8", accent: "#92400e" },
  { id: "owl", label: "猫头鹰", fill: "#ede9fe", accent: "#7c3aed" },
  { id: "turtle", label: "乌龟", fill: "#dcfce7", accent: "#16a34a" },
  { id: "sheep", label: "绵羊", fill: "#f8fafc", accent: "#64748b" },
  { id: "squirrel", label: "松鼠", fill: "#fed7aa", accent: "#ea580c" }
];

function createCaptchaChallenge(): {
  answer: CaptchaSelection[];
  imageSvg: string;
  targetLabel: string;
} {
  const target = captchaOptions[Math.floor(Math.random() * captchaOptions.length)] ?? captchaOptions[0];
  const targetCount = 2 + Math.floor(Math.random() * 3);
  const targetIndexes = pickUniqueIndexes(captchaColumns * captchaRows, targetCount);
  const tiles: CaptchaTile[] = [];
  for (let index = 0; index < captchaColumns * captchaRows; index += 1) {
    const option = targetIndexes.has(index) ? target : randomNonTargetCaptchaOption(target.id);
    tiles.push({
      option,
      row: Math.floor(index / captchaColumns),
      column: index % captchaColumns
    });
  }
  const answer = [...targetIndexes]
    .sort((left, right) => left - right)
    .map((index) => ({
      x: ((index % captchaColumns) + 0.5) / captchaColumns,
      y: (Math.floor(index / captchaColumns) + 0.5) / captchaRows
    }));

  return {
    answer,
    imageSvg: createCaptchaSvg(tiles, target.label),
    targetLabel: target.label
  };
}

function createCaptchaSvg(tiles: CaptchaTile[], targetLabel: string): string {
  const width = 360;
  const height = 260;
  const cardWidth = 74;
  const cardHeight = 62;
  const gap = 10;
  const offsetX = 18;
  const offsetY = 48;
  const tileSvg = tiles
    .map((tile, index) => {
      const x = offsetX + tile.column * (cardWidth + gap);
      const y = offsetY + tile.row * (cardHeight + gap);
      const noise = index % 2 === 0 ? "#dbeafe" : "#ccfbf1";
      return `<g><rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="12" fill="${tile.option.fill}" stroke="#94a3b8" stroke-width="1.5"/>${createCaptchaAnimalSvg(tile.option, x, y)}<circle cx="${x + 10}" cy="${y + 10}" r="2" fill="${noise}"/></g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="请点击图中所有${escapeXml(targetLabel)}"><rect width="${width}" height="${height}" rx="18" fill="#f8fafc"/><rect x="14" y="14" width="332" height="24" rx="12" fill="#0f766e"/><text x="28" y="31" fill="#ffffff" font-family="Arial, sans-serif" font-size="14" font-weight="700">请点击图中所有${escapeXml(targetLabel)}</text><path d="M14 236 C75 214, 134 250, 206 226 S300 214, 346 238" stroke="#99f6e4" stroke-width="3" fill="none" opacity="0.75"/>${tileSvg}</svg>`;
}

function createCaptchaAnimalSvg(option: CaptchaOption, x: number, y: number): string {
  const accent = option.accent;
  const fill = option.fill;
  switch (option.id) {
    case "cow":
      return `<g><ellipse cx="${x + 37}" cy="${y + 35}" rx="24" ry="15" fill="#f8fafc" stroke="${accent}" stroke-width="3"/><path d="M${x + 20} ${y + 22} L${x + 14} ${y + 12} M${x + 54} ${y + 22} L${x + 60} ${y + 12}" stroke="${accent}" stroke-width="3" stroke-linecap="round"/><circle cx="${x + 29}" cy="${y + 32}" r="4" fill="${accent}"/><circle cx="${x + 45}" cy="${y + 32}" r="4" fill="${accent}"/><path d="M${x + 28} ${y + 43} Q${x + 37} ${y + 49}, ${x + 46} ${y + 43}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/></g>`;
    case "duck":
      return `<g><ellipse cx="${x + 37}" cy="${y + 39}" rx="25" ry="14" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 31}" cy="${y + 25}" r="13" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 41} ${y + 26} L${x + 58} ${y + 21} L${x + 48} ${y + 31} Z" fill="#fb923c"/><circle cx="${x + 29}" cy="${y + 23}" r="3" fill="#0f172a"/></g>`;
    case "panda":
      return `<g><circle cx="${x + 25}" cy="${y + 20}" r="9" fill="${accent}"/><circle cx="${x + 49}" cy="${y + 20}" r="9" fill="${accent}"/><circle cx="${x + 37}" cy="${y + 34}" r="23" fill="#f8fafc" stroke="${accent}" stroke-width="3"/><ellipse cx="${x + 29}" cy="${y + 33}" rx="7" ry="9" fill="${accent}"/><ellipse cx="${x + 45}" cy="${y + 33}" rx="7" ry="9" fill="${accent}"/><circle cx="${x + 37}" cy="${y + 42}" r="4" fill="${accent}"/></g>`;
    case "rabbit":
      return `<g><ellipse cx="${x + 29}" cy="${y + 18}" rx="7" ry="17" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(-12 ${x + 29} ${y + 18})"/><ellipse cx="${x + 46}" cy="${y + 18}" rx="7" ry="17" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(12 ${x + 46} ${y + 18})"/><circle cx="${x + 37}" cy="${y + 39}" r="20" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 30}" cy="${y + 36}" r="3" fill="${accent}"/><circle cx="${x + 44}" cy="${y + 36}" r="3" fill="${accent}"/><path d="M${x + 31} ${y + 45} Q${x + 37} ${y + 50}, ${x + 43} ${y + 45}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/></g>`;
    case "fox":
      return `<g><path d="M${x + 16} ${y + 24} L${x + 25} ${y + 10} L${x + 34} ${y + 26} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 58} ${y + 24} L${x + 49} ${y + 10} L${x + 40} ${y + 26} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 15} ${y + 28} Q${x + 37} ${y + 8}, ${x + 59} ${y + 28} Q${x + 51} ${y + 53}, ${x + 37} ${y + 54} Q${x + 23} ${y + 53}, ${x + 15} ${y + 28} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 30}" cy="${y + 34}" r="3" fill="${accent}"/><circle cx="${x + 44}" cy="${y + 34}" r="3" fill="${accent}"/><path d="M${x + 37} ${y + 40} L${x + 31} ${y + 47} L${x + 43} ${y + 47} Z" fill="#ffffff"/></g>`;
    case "cat":
      return `<g><path d="M${x + 19} ${y + 25} L${x + 27} ${y + 11} L${x + 35} ${y + 26} M${x + 55} ${y + 25} L${x + 47} ${y + 11} L${x + 39} ${y + 26}" fill="none" stroke="${accent}" stroke-width="3" stroke-linejoin="round"/><circle cx="${x + 37}" cy="${y + 37}" r="20" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 30}" cy="${y + 34}" r="3" fill="${accent}"/><circle cx="${x + 44}" cy="${y + 34}" r="3" fill="${accent}"/><path d="M${x + 24} ${y + 43} H${x + 14} M${x + 50} ${y + 43} H${x + 60} M${x + 37} ${y + 40} V${y + 43}" stroke="${accent}" stroke-width="2" stroke-linecap="round"/></g>`;
    case "dog":
      return `<g><ellipse cx="${x + 24}" cy="${y + 29}" rx="9" ry="15" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(22 ${x + 24} ${y + 29})"/><ellipse cx="${x + 50}" cy="${y + 29}" rx="9" ry="15" fill="${fill}" stroke="${accent}" stroke-width="3" transform="rotate(-22 ${x + 50} ${y + 29})"/><circle cx="${x + 37}" cy="${y + 38}" r="20" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 31}" cy="${y + 35}" r="3" fill="${accent}"/><circle cx="${x + 43}" cy="${y + 35}" r="3" fill="${accent}"/><ellipse cx="${x + 37}" cy="${y + 44}" rx="7" ry="5" fill="${accent}"/></g>`;
    case "owl":
      return `<g><path d="M${x + 16} ${y + 22} Q${x + 37} ${y + 7}, ${x + 58} ${y + 22} V${y + 44} Q${x + 37} ${y + 60}, ${x + 16} ${y + 44} Z" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 29}" cy="${y + 32}" r="8" fill="#ffffff" stroke="${accent}" stroke-width="3"/><circle cx="${x + 45}" cy="${y + 32}" r="8" fill="#ffffff" stroke="${accent}" stroke-width="3"/><path d="M${x + 37} ${y + 39} L${x + 32} ${y + 47} H${x + 42} Z" fill="#f59e0b"/></g>`;
    case "turtle":
      return `<g><ellipse cx="${x + 37}" cy="${y + 38}" rx="23" ry="17" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 61}" cy="${y + 36}" r="8" fill="${fill}" stroke="${accent}" stroke-width="3"/><path d="M${x + 23} ${y + 32} Q${x + 37} ${y + 22}, ${x + 51} ${y + 32} M${x + 23} ${y + 44} Q${x + 37} ${y + 54}, ${x + 51} ${y + 44}" stroke="${accent}" stroke-width="2" fill="none"/><circle cx="${x + 64}" cy="${y + 34}" r="2" fill="${accent}"/></g>`;
    case "sheep":
      return `<g><circle cx="${x + 24}" cy="${y + 32}" r="10" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 36}" cy="${y + 27}" r="12" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 49}" cy="${y + 33}" r="11" fill="${fill}" stroke="${accent}" stroke-width="3"/><ellipse cx="${x + 38}" cy="${y + 45}" rx="17" ry="11" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 33}" cy="${y + 43}" r="2.5" fill="${accent}"/><circle cx="${x + 43}" cy="${y + 43}" r="2.5" fill="${accent}"/></g>`;
    case "squirrel":
      return `<g><path d="M${x + 51} ${y + 42} C${x + 68} ${y + 28}, ${x + 55} ${y + 8}, ${x + 42} ${y + 20}" fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round"/><ellipse cx="${x + 35}" cy="${y + 39}" rx="18" ry="16" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 25}" cy="${y + 25}" r="10" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 22}" cy="${y + 23}" r="2.5" fill="${accent}"/></g>`;
    case "seal":
    default:
      return `<g><ellipse cx="${x + 38}" cy="${y + 38}" rx="27" ry="15" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 32}" cy="${y + 28}" r="12" fill="${fill}" stroke="${accent}" stroke-width="3"/><circle cx="${x + 28}" cy="${y + 27}" r="3" fill="${accent}"/><path d="M${x + 36} ${y + 32} C${x + 48} ${y + 29}, ${x + 54} ${y + 33}, ${x + 61} ${y + 40}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/><path d="M${x + 17} ${y + 43} Q${x + 8} ${y + 52}, ${x + 24} ${y + 51}" fill="${fill}" stroke="${accent}" stroke-width="3"/></g>`;
  }
}

function verifyCaptchaChallenge(captchaId: string, captchaSelections: CaptchaSelection[]): void {
  pruneCaptchaChallenges();
  const challenge = captchaChallenges.get(captchaId);
  captchaChallenges.delete(captchaId);
  if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
  const normalizedSelections = normalizeCaptchaSelections(captchaSelections);
  if (normalizedSelections.length !== captchaSelections.length) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
  const actualHash = hashCaptchaAnswer(captchaSelections);
  if (actualHash !== challenge.answerHash) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
}

function verifyCaptchaVerifications(verificationIds: string[]): void {
  pruneCaptchaVerifications();
  const uniqueIds = new Set(verificationIds);
  if (uniqueIds.size !== captchaRequiredRounds) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
  const verifications = verificationIds.map((verificationId) => ({
    verificationId,
    verification: captchaVerifications.get(verificationId)
  }));
  for (const { verificationId } of verifications) {
    captchaVerifications.delete(verificationId);
  }
  const now = Date.now();
  if (verifications.some(({ verification }) => !verification || new Date(verification.expiresAt).getTime() <= now)) {
    throw new AppError("CAPTCHA_INVALID", "Image verification is invalid or expired", 400);
  }
}

function hashCaptchaAnswer(answer: CaptchaSelection[]): string {
  return createHash("sha256").update(normalizeCaptchaSelections(answer).join("|")).digest("hex");
}

function normalizeCaptchaSelections(selections: CaptchaSelection[]): string[] {
  return [...new Set(selections.map(captchaSelectionKey))].sort();
}

function captchaSelectionKey(selection: CaptchaSelection): string {
  const column = Math.min(captchaColumns - 1, Math.max(0, Math.floor(selection.x * captchaColumns)));
  const row = Math.min(captchaRows - 1, Math.max(0, Math.floor(selection.y * captchaRows)));
  return `${row}:${column}`;
}

function pickUniqueIndexes(count: number, targetCount: number): Set<number> {
  const indexes = new Set<number>();
  while (indexes.size < targetCount) {
    indexes.add(Math.floor(Math.random() * count));
  }
  return indexes;
}

function randomNonTargetCaptchaOption(targetId: string): CaptchaOption {
  const options = captchaOptions.filter((option) => option.id !== targetId);
  return options[Math.floor(Math.random() * options.length)] ?? captchaOptions[0];
}

function exposeCaptchaAnswerForTests(): boolean {
  return process.env.NODE_ENV !== "production" && envBool("EXPOSE_CAPTCHA_ANSWER_FOR_TESTS", false);
}

function pruneCaptchaChallenges(): void {
  const now = Date.now();
  for (const [captchaId, challenge] of captchaChallenges) {
    if (new Date(challenge.expiresAt).getTime() <= now) {
      captchaChallenges.delete(captchaId);
    }
  }
  const maxChallenges = envNumber("CAPTCHA_MAX_CHALLENGES", 5000);
  if (captchaChallenges.size <= maxChallenges) {
    return;
  }
  const overflow = [...captchaChallenges.entries()]
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, captchaChallenges.size - maxChallenges);
  for (const [captchaId] of overflow) {
    captchaChallenges.delete(captchaId);
  }
}

function pruneCaptchaVerifications(): void {
  const now = Date.now();
  for (const [verificationId, verification] of captchaVerifications) {
    if (new Date(verification.expiresAt).getTime() <= now) {
      captchaVerifications.delete(verificationId);
    }
  }
  const maxVerifications = envNumber("CAPTCHA_MAX_VERIFICATIONS", 5000);
  if (captchaVerifications.size <= maxVerifications) {
    return;
  }
  const overflow = [...captchaVerifications.entries()]
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, captchaVerifications.size - maxVerifications);
  for (const [verificationId] of overflow) {
    captchaVerifications.delete(verificationId);
  }
}

// 登录尝试令牌名，随会话 cookie 名派生，避免命名冲突。
function loginAttemptCookieName(): string {
  return process.env.LOGIN_ATTEMPT_COOKIE_NAME ?? "imagora_login_attempt";
}

function loginAttemptMaxTries(): number {
  return envNumber("LOGIN_ATTEMPT_MAX_TRIES", 5);
}

function loginAttemptTtlMs(): number {
  return envNumber("LOGIN_ATTEMPT_TTL_SECONDS", 300) * 1000;
}

// 验证码验过后签发一个带额度的登录尝试令牌，允许在有效期内多次尝试密码而无需重做图片验证。
function issueLoginAttempt(reply: FastifyReply): void {
  pruneLoginAttempts();
  const token = randomUUID();
  const now = Date.now();
  const expiresAtMs = now + loginAttemptTtlMs();
  loginAttempts.set(token, {
    remaining: loginAttemptMaxTries(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  appendSetCookie(
    reply,
    serializeCookie(loginAttemptCookieName(), token, {
      expires: new Date(expiresAtMs),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

// 消费一次登录尝试额度：令牌存在、未过期且有剩余额度则扣 1 并返回 true；否则清理并返回 false。
function consumeLoginAttempt(request: FastifyRequest): boolean {
  pruneLoginAttempts();
  const token = cookieValue(request.headers.cookie, loginAttemptCookieName());
  if (!token) {
    return false;
  }
  const attempt = loginAttempts.get(token);
  if (!attempt) {
    return false;
  }
  if (new Date(attempt.expiresAt).getTime() <= Date.now() || attempt.remaining <= 0) {
    loginAttempts.delete(token);
    return false;
  }
  attempt.remaining -= 1;
  if (attempt.remaining <= 0) {
    // 额度用尽：本次仍放行，但令牌作废，下次必须重新做图片验证。
    loginAttempts.delete(token);
  }
  return true;
}

// 登录成功或需要强制重验时，清掉当前尝试令牌及其 cookie。
function clearLoginAttempt(request: FastifyRequest, reply: FastifyReply): void {
  const token = cookieValue(request.headers.cookie, loginAttemptCookieName());
  if (token) {
    loginAttempts.delete(token);
  }
  appendSetCookie(
    reply,
    serializeCookie(loginAttemptCookieName(), "", {
      expires: new Date(0),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

function pruneLoginAttempts(): void {
  const now = Date.now();
  for (const [token, attempt] of loginAttempts) {
    if (new Date(attempt.expiresAt).getTime() <= now || attempt.remaining <= 0) {
      loginAttempts.delete(token);
    }
  }
  const maxAttempts = envNumber("LOGIN_ATTEMPT_MAX_TOKENS", 5000);
  if (loginAttempts.size <= maxAttempts) {
    return;
  }
  const overflow = [...loginAttempts.entries()]
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, loginAttempts.size - maxAttempts);
  for (const [token] of overflow) {
    loginAttempts.delete(token);
  }
}

function defaultNicknameForEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart.replace(/[^a-z0-9_-]/gi, "").slice(0, 32);
  return cleaned || "Imagora 用户";
}

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}

function normalizePasswordForBlocklist(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  requireProductionValue("OPENAI_TIMEOUT_MS");
  requireProductionValue("OPENAI_MAX_RETRIES");
  requireProductionValue("S3_ENDPOINT");
  requireProductionValue("S3_BUCKET");
  requireProductionValue("S3_ACCESS_KEY_ID");
  requireProductionValue("S3_SECRET_ACCESS_KEY");
  requireProductionValue("S3_PUBLIC_BASE_URL");
  requireProductionValue("STRIPE_SECRET_KEY");
  requireProductionValue("STRIPE_WEBHOOK_SECRET");
  requireProductionValue("STRIPE_SUCCESS_URL");
  requireProductionValue("STRIPE_CANCEL_URL");
  requireProductionValue("SAFETY_TEXT_ENDPOINT");
  requireProductionValue("SAFETY_IMAGE_ENDPOINT");
  requireProductionValue("SMTP_HOST");
  requireProductionValue("SMTP_USER");
  requireProductionValue("SMTP_PASSWORD");
  requireProductionValue("SMTP_FROM");
  if (!requireEmailVerification()) {
    throw new Error(
      "Unsafe production config: REQUIRE_EMAIL_VERIFICATION must not be disabled in production"
    );
  }
  requireProductionValue("GENERATION_RUNNING_TIMEOUT_MS");
  requireProductionSetting("DATA_STORE", "prisma");
  requireProductionSetting("QUEUE_PROVIDER", "bullmq");
  requireProductionImageProvider("openai");
  requireProductionImageModel();
  assertProductionOpenAiGenerationConfig();
  requireProductionGenerationRunningTimeout();
  requireProductionSetting("STORAGE_PROVIDER", "s3", "r2");
  requireProductionSetting("PAYMENT_PROVIDER", "stripe");
  requireProductionSetting("MAILER_PROVIDER", "smtp");
  requireProductionSetting("SAFETY_PROVIDER", "http");
  requireProductionSetting("RATE_LIMIT_PROVIDER", "redis");
  if (allowBearerSessionAuth()) {
    throw new Error("Unsafe production config: bearer session auth must be disabled");
  }
  if (!envBool("SESSION_COOKIE_SECURE", false)) {
    throw new Error("Unsafe production config: SESSION_COOKIE_SECURE must be true");
  }
  if (!process.env.ALERT_WEBHOOK_URL?.trim() && !process.env.ALERT_EMAIL_TO?.trim()) {
    throw new Error(
      "Unsafe production config: at least one alert channel is required (set ALERT_WEBHOOK_URL or ALERT_EMAIL_TO)"
    );
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

function requireProductionNumber(name: string): number {
  const value = Number(requireProductionValue(name));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Unsafe production config: ${name} must be a positive number`);
  }
  return value;
}

function requireProductionImageProvider(...allowedValues: string[]): void {
  let value: string;
  try {
    value = resolveDefaultImageProvider();
  } catch (error) {
    throw new Error(
      `Unsafe production config: ${error instanceof Error ? error.message : "image provider is not configured"}`
    );
  }
  if (!allowedValues.includes(value)) {
    throw new Error(
      `Unsafe production config: IMAGE_PROVIDER_DEFAULT (or legacy AI_PROVIDER) must be ${allowedValues.join(" or ")}`
    );
  }
}

function requireProductionImageModel(): void {
  try {
    resolveDefaultImageModel(resolveDefaultImageProvider());
  } catch (error) {
    throw new Error(
      `Unsafe production config: ${error instanceof Error ? error.message : "image model is not configured"}`
    );
  }
}

function requireProductionGenerationRunningTimeout(): void {
  const runningTimeoutMs = requireProductionNumber("GENERATION_RUNNING_TIMEOUT_MS");
  const openAiTimeoutMs = readOpenAiGenerationRuntimeConfig().timeoutMs;
  const minimum = openAiTimeoutMs * maxQuantity + 5 * 60 * 1000;
  if (runningTimeoutMs < minimum) {
    throw new Error(
      `Unsafe production config: GENERATION_RUNNING_TIMEOUT_MS must be at least ${minimum} when OPENAI_TIMEOUT_MS=${openAiTimeoutMs} and max quantity is ${maxQuantity}`
    );
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
  if (!allowedWriteOrigins().has(normalizeOrigin(origin))) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed", 403);
  }
}

function allowedWriteOrigins(): Set<string> {
  const values = [process.env.WEB_ORIGIN || "http://127.0.0.1:3100", process.env.CSRF_ALLOWED_ORIGINS]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const origins = new Set(values);
  addLocalDevelopmentOrigins(origins);
  return origins;
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function addLocalDevelopmentOrigins(origins: Set<string>): void {
  if (isProduction) {
    return;
  }
  origins.add("http://127.0.0.1:3100");
  origins.add("http://localhost:3100");
  for (const origin of [...origins]) {
    const alias = localDevelopmentOriginAlias(origin);
    if (alias) {
      origins.add(alias);
    }
  }
}

function localDevelopmentOriginAlias(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
      return normalizeOrigin(url.origin);
    }
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return normalizeOrigin(url.origin);
    }
  } catch {
    return null;
  }
  return null;
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

  const key = `${rule.id}:${await rateLimitScope(request, rule)}`;
  if ((process.env.RATE_LIMIT_PROVIDER ?? "memory") === "redis") {
    let redisResult: { count: number; resetAt: number };
    try {
      redisResult = await redisFixedWindowIncrement(key, rateLimitWindowMs);
    } catch (error) {
      request.log.error({ error, rateLimitRule: rule.id }, "Redis rate limiter unavailable");
      throw new AppError("RATE_LIMIT_UNAVAILABLE", "Rate limit service is unavailable", 503);
    }
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

// 限流维度：默认按 IP；登录态接口（如重发验证邮件）按 userId，避免换 IP 绕过或同 NAT 出口互相挤占。
// 取不到有效 session 时退回 IP，保证未登录命中该规则的请求仍受 IP 兜底限制。
async function rateLimitScope(request: FastifyRequest, rule: RateLimitRule): Promise<string> {
  if (rule.keyBy !== "user") {
    return request.ip;
  }
  let token: string;
  try {
    token = sessionToken(request, true);
  } catch {
    return request.ip;
  }
  if (!token) {
    return request.ip;
  }
  const data = await store.read();
  const now = new Date();
  const session = data.sessions.find(
    (item) => item.token === token && new Date(item.expiresAt) > now
  );
  return session ? `user:${session.userId}` : request.ip;
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

async function recordHttpIncident(
  request: FastifyRequest,
  input: Pick<OperationalIncidentInput, "severity" | "message" | "errorCode" | "taskId" | "orderId">
): Promise<void> {
  try {
    await store.update((data) => {
      recordOperationalIncident(data, {
        severity: input.severity,
        area: "http",
        message: input.message,
        errorCode: input.errorCode,
        requestId: request.requestId ?? null,
        userId: request.userId ?? null,
        taskId: input.taskId ?? null,
        orderId: input.orderId ?? null,
        route: routeLabel(request)
      });
    });
  } catch {
    request.log.warn({ errorCode: "INCIDENT_RECORD_FAILED" }, "Operational incident record failed");
  }
}

function recordOperationalIncident(data: StoreData, input: OperationalIncidentInput): void {
  data.operationalIncidents ??= [];
  const now = new Date().toISOString();
  const existing = data.operationalIncidents.find((incident) => {
    if (incident.status !== "OPEN" || incident.errorCode !== (input.errorCode ?? null)) {
      return false;
    }
    if (input.taskId) {
      return incident.taskId === input.taskId;
    }
    if (input.orderId) {
      return incident.orderId === input.orderId;
    }
    return input.requestId ? incident.requestId === input.requestId : false;
  });

  if (existing) {
    existing.severity = input.severity;
    existing.message = sanitizeOperationalMessage(input.message);
    existing.requestId = input.requestId ?? existing.requestId;
    existing.userId = input.userId ?? existing.userId;
    existing.route = input.route ?? existing.route;
    existing.updatedAt = now;
    return;
  }

  data.operationalIncidents.push({
    id: randomUUID(),
    severity: input.severity,
    area: input.area,
    status: "OPEN",
    message: sanitizeOperationalMessage(input.message),
    errorCode: input.errorCode ?? null,
    requestId: input.requestId ?? null,
    userId: input.userId ?? null,
    taskId: input.taskId ?? null,
    orderId: input.orderId ?? null,
    route: input.route ?? null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  });
  data.operationalIncidents = data.operationalIncidents
    .sort(descUpdated)
    .slice(0, envNumber("INCIDENT_RETENTION_MAX", 100));
}

function alertCooldownMs(): number {
  return envNumber("ALERT_COOLDOWN_MS", 30 * 60 * 1000);
}

/**
 * 冷却窗口桶：同一 (channel, alert) 在同一窗口内只发一次，跨窗口可再发。
 * 修掉旧逻辑 `local:${id}` 永久去重导致告警只发一次的 bug。
 */
function alertDedupeKey(channel: string, alertId: string, at: number): string {
  const cooldown = alertCooldownMs();
  const bucket = cooldown > 0 ? Math.floor(at / cooldown) : at;
  return `${channel}:${alertId}:${bucket}`;
}

function alertToPayload(alert: OperationalAlert): AlertNotificationPayload {
  return {
    id: alert.id,
    severity: alert.severity,
    area: alert.area,
    metric: alert.metric,
    value: alert.value,
    threshold: alert.threshold,
    message: alert.message,
    runbook: alert.runbook
  };
}

/**
 * 计算本轮每条告警还需要向哪些通道投递（跳过冷却窗口内已成功发送的通道）。
 * 返回的决策供事务外真正发送使用，避免网络 IO 占用 store 的 advisory lock。
 */
function planAlertDeliveries(
  data: StoreData,
  alerts: OperationalAlert[],
  channels: string[],
  at: number
): Array<{ alert: OperationalAlert; channel: string; dedupeKey: string }> {
  data.alertNotifications ??= [];
  const plan: Array<{ alert: OperationalAlert; channel: string; dedupeKey: string }> = [];
  for (const alert of alerts) {
    for (const channel of channels) {
      const dedupeKey = alertDedupeKey(channel, alert.id, at);
      const existing = data.alertNotifications.find((notification) => notification.dedupeKey === dedupeKey);
      // 冷却窗口内已成功发送 → 跳过；FAILED 记录允许重试。
      if (existing && existing.status === "SENT") {
        continue;
      }
      plan.push({ alert, channel, dedupeKey });
    }
  }
  return plan;
}

/**
 * 把一批投递结果 upsert 进 alertNotifications（dedupeKey 唯一，schema 层有 unique 约束）。
 * 已存在同 dedupeKey 记录则原地更新 status/message，否则新增。
 */
function recordAlertDeliveries(
  data: StoreData,
  deliveries: Array<{ alert: OperationalAlert; channel: string; dedupeKey: string; status: AlertNotificationStatus; error?: string }>
): void {
  data.alertNotifications ??= [];
  const now = new Date().toISOString();
  for (const delivery of deliveries) {
    const message =
      delivery.status === "FAILED" && delivery.error
        ? `${delivery.alert.message} | delivery failed: ${delivery.error}`.slice(0, 500)
        : delivery.alert.message;
    const existing = data.alertNotifications.find((notification) => notification.dedupeKey === delivery.dedupeKey);
    if (existing) {
      existing.status = delivery.status;
      existing.severity = delivery.alert.severity;
      existing.message = message;
      existing.sentAt = now;
      continue;
    }
    data.alertNotifications.push({
      id: randomUUID(),
      alertId: delivery.alert.id,
      channel: delivery.channel as AlertNotification["channel"],
      status: delivery.status,
      severity: delivery.alert.severity,
      dedupeKey: delivery.dedupeKey,
      message,
      createdAt: now,
      sentAt: now
    });
  }
  data.alertNotifications = data.alertNotifications
    .sort(descCreated)
    .slice(0, envNumber("ALERT_NOTIFICATION_RETENTION_MAX", 100));
}

/**
 * 记录 local 审计轨迹：检测到告警即落库（channel="local"），纯 store 操作、无网络 IO。
 * 与 email/webhook 的真实外发分层——local 是"发现了什么"的审计，外发是"通知了谁"。
 * 供 metrics 端点访问时同步调用，不拖慢请求（无 IO）。
 */
function recordLocalAlertNotifications(data: StoreData, alerts: OperationalAlert[]): void {
  const at = Date.now();
  recordAlertDeliveries(
    data,
    alerts.map((alert) => ({
      alert,
      channel: "local",
      dedupeKey: alertDedupeKey("local", alert.id, at),
      status: "SENT" as AlertNotificationStatus
    }))
  );
}

/**
 * 主动评估告警并外发：定时器与手动触发共用。
 * 流程：读快照算告警 → 事务内规划待投递(不做 IO) → 事务外并发发送 → 事务内 upsert 结果。
 */
async function evaluateAndDispatchAlerts(): Promise<{ alerts: number; dispatched: number; failed: number }> {
  if (!alertNotifier.hasChannels()) {
    return { alerts: 0, dispatched: 0, failed: 0 };
  }
  const snapshot = await store.read();
  const http = httpMetricsSnapshot();
  const alerts = operationalAlertsSnapshot(snapshot, http);
  if (!alerts.length) {
    return { alerts: 0, dispatched: 0, failed: 0 };
  }

  const at = Date.now();
  const channels = alertNotifier.channelNames;
  let plan: Array<{ alert: OperationalAlert; channel: string; dedupeKey: string }> = [];
  await store.update((data) => {
    plan = planAlertDeliveries(data, alerts, channels, at);
  });
  if (!plan.length) {
    return { alerts: alerts.length, dispatched: 0, failed: 0 };
  }

  // 事务外发送：按告警分组，一次 dispatch 覆盖该告警需要的所有通道。
  const byAlert = new Map<string, { alert: OperationalAlert; channels: string[] }>();
  for (const item of plan) {
    const entry = byAlert.get(item.alert.id) ?? { alert: item.alert, channels: [] };
    entry.channels.push(item.channel);
    byAlert.set(item.alert.id, entry);
  }

  const deliveries: Array<{
    alert: OperationalAlert;
    channel: string;
    dedupeKey: string;
    status: AlertNotificationStatus;
    error?: string;
  }> = [];
  let dispatched = 0;
  let failed = 0;
  for (const { alert, channels: alertChannels } of byAlert.values()) {
    const results = await alertNotifier.dispatch(alertToPayload(alert), { channels: alertChannels });
    for (const result of results) {
      const dedupeKey = alertDedupeKey(result.channel, alert.id, at);
      if (result.ok) {
        dispatched += 1;
        deliveries.push({ alert, channel: result.channel, dedupeKey, status: "SENT" });
      } else {
        failed += 1;
        deliveries.push({ alert, channel: result.channel, dedupeKey, status: "FAILED", error: result.error });
      }
    }
  }

  await store.update((data) => {
    recordAlertDeliveries(data, deliveries);
  });

  if (failed) {
    logger.error({ alerts: alerts.length, dispatched, failed }, "alert dispatch had channel failures");
  } else {
    logger.warn({ alerts: alerts.length, dispatched }, "alert dispatched to channels");
  }
  return { alerts: alerts.length, dispatched, failed };
}

/**
 * 后台定时评估告警并外发。补上"告警只在有人打开 metrics 时被动触发"的观测盲区。
 */
function startBackgroundAlertEvaluation(): void {
  const intervalMs = envNumber("ALERT_EVALUATION_INTERVAL_MS", 60_000);
  if (intervalMs <= 0 || !alertNotifier.hasChannels()) {
    return;
  }
  const timer = setInterval(() => {
    evaluateAndDispatchAlerts().catch((error) => {
      logger.error({ err: error }, "background alert evaluation failed");
    });
  }, intervalMs);
  timer.unref();
}

function routeLabel(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? pathOnly(request.url)}`;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeOperationalMessage(message: string): string {
  return message
    .replace(/(password|passwd|token|captcha|secret|api[_-]?key|authorization)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]")
    .slice(0, 280);
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

  const amountMismatchEvents = paymentFailureEvents(data).length;
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

  const refundFailures = refundFailureCount(data);
  const refundFailureThreshold = envNumber("ALERT_REFUND_FAILURES_MAX", 0);
  if (refundFailures > refundFailureThreshold) {
    alerts.push({
      id: "generation.refund-failures",
      severity: "critical",
      area: "generation",
      metric: "refundFailuresTotal",
      value: refundFailures,
      threshold: refundFailureThreshold,
      message: "Generation refund failures were detected.",
      runbook: "Pause generation, inspect credit ledger entries by taskId, and reconcile refunds before retrying."
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
  const failedTasks = terminalTasks.filter((task) => task.status === "FAILED");
  const completedDurations = data.generationTasks
    .filter((task) => task.startedAt && task.completedAt)
    .map((task) => new Date(task.completedAt as string).getTime() - new Date(task.startedAt as string).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  const queueWaitDurations = data.generationTasks
    .filter((task) => task.startedAt)
    .map((task) => new Date(task.startedAt as string).getTime() - new Date(task.createdAt).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);

  // 权益周期与成本核算
  const soonMs = Date.now() + envNumber("CREDIT_EXPIRING_SOON_DAYS", 7) * 24 * 60 * 60 * 1000;
  let creditsExpiringSoon = 0;
  for (const [, entries] of groupLedgerByUser(data.creditLedgerEntries)) {
    const remainders = creditSourceRemainders(entries);
    for (const entry of entries) {
      if (entry.type !== "GRANT" || !entry.expiresAt) {
        continue;
      }
      const expiresMs = new Date(entry.expiresAt).getTime();
      if (expiresMs > Date.now() && expiresMs <= soonMs) {
        creditsExpiringSoon += remainders.get(entry.id) ?? 0;
      }
    }
  }
  const creditsExpiredTotal = data.creditLedgerEntries
    .filter((entry) => entry.type === "EXPIRE")
    .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
  const paidRevenueCents = data.orders
    .filter((order) => order.status === "PAID")
    .reduce((sum, order) => sum + order.amountCents, 0);
  const aiCostCents = succeededTasks.reduce((sum, task) => sum + task.providerCostCents, 0);

  return {
    usersTotal: data.users.length,
    creditsOutstanding: data.creditAccounts.reduce((sum, account) => sum + account.balance, 0),
    creditsExpiringSoon,
    creditsExpiredTotal,
    tasksByStatus: countBy(data.generationTasks, (task) => task.status),
    generationSuccessRate: terminalTasks.length ? round(succeededTasks.length / terminalTasks.length) : null,
    generationFailureRate: terminalTasks.length ? round(failedTasks.length / terminalTasks.length) : null,
    averageGenerationDurationMs: completedDurations.length
      ? round(completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length)
      : null,
    averageQueueWaitMs: queueWaitDurations.length
      ? round(queueWaitDurations.reduce((sum, duration) => sum + duration, 0) / queueWaitDurations.length)
      : null,
    referenceImagesTotal: data.referenceImages.filter((image) => !image.deletedAt).length,
    imagesTotal: data.generatedImages.length,
    ordersByStatus: countBy(data.orders, (order) => order.status),
    paymentEventsTotal: data.paymentEvents.length,
    paymentFailuresTotal: paymentFailureEvents(data).length,
    refundFailuresTotal: refundFailureCount(data),
    paidRevenueCents,
    aiCostCents,
    grossProfitCents: paidRevenueCents - aiCostCents,
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

function descCreated<T extends { createdAt: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function descUpdated<T extends { updatedAt: string }>(a: T, b: T): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}
