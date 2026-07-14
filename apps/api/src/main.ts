import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import cors from "@fastify/cors";
import pino from "pino";
import { getActiveProviderMetadata, quoteImageGeneration, resolveProviderModel } from "@imagora/ai-providers";
import { createStore, hashPassword, verifyPassword, withoutPassword } from "@imagora/database";
import { buildVerificationEmail, createMailer } from "@imagora/mailer";
import { createAlertNotifier } from "@imagora/notifier";
import { createPaymentProvider } from "@imagora/payments";
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
  type ModelId,
  type Order,
  type PaymentEvent,
  publicUser,
  type Quality,
  type ReferenceImage,
  runGenerationMaintenance,
  type SourceType,
  type StoreData,
  type StyleId,
  taskRefundedCredits,
  type User
} from "@imagora/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { validateProductionConfig } from "./production-config.js";
import { registerApiRoutes } from "./routes/index.js";
import type { ApiRouteContext } from "./routes/index.js";
import {
  adjustCreditSchema,
  adminAuditQuerySchema,
  adminImageQuerySchema,
  adminOrderQuerySchema,
  adminPlanPatchSchema,
  adminPlanSchema,
  adminReasonSchema,
  adminStatusSchema,
  adminTaskQuerySchema,
  adminUserQuerySchema,
  adminVisibilitySchema,
  captchaRequiredRounds,
  captchaVerifySchema,
  changeEmailSchema,
  changePasswordSchema,
  createOrderSchema,
  deleteAccountSchema,
  fileSignatureQuerySchema,
  generationInputSchema,
  idParamSchema,
  imageParamSchema,
  loginSchema,
  optionalPaginationSchema,
  orderParamSchema,
  paginationSchema,
  paymentWebhookParamSchema,
  planParamSchema,
  referenceUploadSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  safetyAppealAdminQuerySchema,
  safetyAppealCreateSchema,
  safetyAppealParamSchema,
  safetyAppealReviewSchema,
  safetyEventParamSchema,
  safetyEventQuerySchema,
  safetyEventReviewSchema,
  safetyRuleParamSchema,
  safetyRulePatchSchema,
  safetyRuleSchema,
  taskQuerySchema,
  updateProfileSchema,
  userParamSchema
} from "./schemas.js";
import {
  addDays,
  descCreated,
  descUpdated,
  envBool,
  envNumber,
  envString,
  errorMessage,
  headerValue,
  pathOnly,
  payloadRecord,
  round,
  webhookSignature
} from "./runtime.js";

// Structured logging setup
const isProduction = process.env.NODE_ENV === "production";

validateProductionConfig({ allowBearerSessionAuth, isProduction, requireEmailVerification });

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

function envelope<T>(request: FastifyRequest, data: T): ApiEnvelope<T> {
  return { data, requestId: request.requestId ?? randomUUID() };
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
  const sessionCookie = serializeCookie(sessionCookieName(), token, {
    expires: new Date(expiresAt),
    httpOnly: true,
    secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
    sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
    path: "/"
  });
  const existing = reply.getHeader("set-cookie");
  if (existing === undefined) {
    reply.header("set-cookie", sessionCookie);
    return;
  }
  const existingCookies = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header("set-cookie", [
    sessionCookie,
    ...existingCookies.filter((cookie) => !cookie.startsWith(`${sessionCookieName()}=`))
  ]);
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  const session = data.sessions.find((item) => item.token === token && new Date(item.expiresAt) > now);
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
  deliveries: Array<{
    alert: OperationalAlert;
    channel: string;
    dedupeKey: string;
    status: AlertNotificationStatus;
    error?: string;
  }>
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

function createRouteContext(): ApiRouteContext {
  return {
    AppError,
    FilesystemObjectStorage,
    addDays,
    adjustCreditSchema,
    adjustCredits,
    adminAuditQuerySchema,
    adminImageQuerySchema,
    adminOrderQuerySchema,
    adminPlanPatchSchema,
    adminPlanSchema,
    adminReasonSchema,
    adminStatusSchema,
    adminTaskQuerySchema,
    adminUserQuerySchema,
    adminVisibilitySchema,
    applyPaymentSucceeded,
    aspectRatioDimensions,
    assertEmailVerified,
    assertFeatureEnabled,
    assertMockPaymentAllowed,
    assertPaymentProviderEnabled,
    audit,
    buildVerificationEmail,
    captchaChallenges,
    captchaOptions,
    captchaRequiredRounds,
    captchaVerifications,
    captchaVerifySchema,
    changeEmailSchema,
    changePasswordSchema,
    clearLoginAttempt,
    clearSessionCookie,
    consumeLoginAttempt,
    contentTypeForStorageKey,
    createCaptchaChallenge,
    createHash,
    createOrderSchema,
    defaultNicknameForEmail,
    deleteAccountSchema,
    descCreated,
    descUpdated,
    domainMetricsSnapshot,
    enqueueGenerationTaskOrFail,
    envelope,
    ensureCheckoutUrl,
    envNumber,
    envString,
    errorMessage,
    exposeCaptchaAnswerForTests,
    extensionForMime,
    extensionForMimeType,
    featureFlags,
    fileSignatureQuerySchema,
    findCheckoutUrl,
    findOrderByClientRequestId,
    generationInputSchema,
    generationMaintenanceOptions,
    hashCaptchaAnswer,
    hashPassword,
    httpMetricsSnapshot,
    idParamSchema,
    imageParamSchema,
    inspectReferenceUpload,
    issueLoginAttempt,
    loginSchema,
    mailer,
    matchesCreatedRange,
    mustFindCreditAccount,
    mustFindImage,
    mustFindOrder,
    mustFindOwnImage,
    mustFindOwnOrder,
    mustFindOwnReferenceImage,
    mustFindOwnTask,
    mustFindTask,
    mustFindUser,
    operationalAlertsSnapshot,
    optionalPaginationSchema,
    orderParamSchema,
    paginationSchema,
    payloadRecord,
    paymentProvider,
    paymentWebhookParamSchema,
    planParamSchema,
    pruneCaptchaChallenges,
    pruneCaptchaVerifications,
    publicUser,
    quote,
    randomUUID,
    readFile,
    recordLocalAlertNotifications,
    referenceUploadSchema,
    registerSchema,
    requestPasswordResetSchema,
    requireAdmin,
    requireAuth,
    resetPasswordSchema,
    resolveGenerationProviderSelection,
    resolveInlineDataUrl,
    routeLabel,
    runGenerationMaintenance,
    runOrderMaintenance,
    safetyAppealAdminQuerySchema,
    safetyAppealCreateSchema,
    safetyAppealParamSchema,
    safetyAppealReviewSchema,
    safetyEventParamSchema,
    safetyEventQuerySchema,
    safetyEventReviewSchema,
    safetyProvider,
    safetyRuleParamSchema,
    safetyRulePatchSchema,
    safetyRuleSchema,
    serviceStartedAt,
    sessionToken,
    setSessionCookie,
    spendCredits,
    stripAdminReason,
    storage,
    store,
    taskQuerySchema,
    taskWithRefund,
    updateProfileSchema,
    uploadBodyLimitBytes,
    userParamSchema,
    verifyCaptchaChallenge,
    verifyCaptchaVerifications,
    verifyPassword,
    webhookSignature,
    withFavorite,
    withoutImagePublicUrl,
    withoutPassword,
    z
  };
}

registerApiRoutes(app, createRouteContext());

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
