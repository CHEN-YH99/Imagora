import { randomUUID } from "node:crypto";

export type UserRole = "USER" | "ADMIN";
export type UserStatus = "ACTIVE" | "SUSPENDED" | "DELETED";
export type TaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "BLOCKED";
export type CreditLedgerType = "GRANT" | "SPEND" | "REFUND" | "EXPIRE" | "ADJUST";
export type SourceType = "TASK" | "ORDER" | "ADMIN" | "SYSTEM";
export type SafetyStatus = "PASSED" | "BLOCKED" | "REVIEW_REQUIRED";
export type OrderStatus = "PENDING" | "PAID" | "CANCELED" | "REFUNDED" | "CLOSED";
export type ImageVisibility = "PRIVATE" | "PUBLIC" | "HIDDEN";
export type Quality = "draft" | "standard" | "high";
export type StyleId = "realistic" | "illustration" | "anime" | "product_photography" | "poster";
export type AspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
export type ModelId = string;

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  nickname: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  nickname: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface UserCreditAccount {
  userId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  updatedAt: string;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  type: CreditLedgerType;
  amount: number;
  balanceAfter: number;
  sourceType: SourceType;
  sourceId: string;
  idempotencyKey: string;
  remark: string;
  // GRANT 批次的到期时间（ISO），null 表示永不过期；仅 GRANT 类型有意义
  expiresAt: string | null;
  createdAt: string;
}

export interface GenerationTask {
  id: string;
  userId: string;
  clientRequestId: string;
  referenceImageId: string | null;
  prompt: string;
  negativePrompt: string | null;
  style: StyleId;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  quantity: number;
  quality: Quality;
  modelProvider: string;
  modelName: string;
  status: TaskStatus;
  creditCost: number;
  // 供应商侧真实成本（分），任务成功后由 worker 落库，用于毛利核算
  providerCostCents: number;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationMetadata {
  taskId: string;
  prompt: string;
  negativePrompt: string | null;
  style: StyleId;
  aspectRatio: AspectRatio;
  quality: Quality;
  quantity: number;
  modelProvider: string;
  modelName: string;
  width: number;
  height: number;
  creditCost: number;
  createdAt: string;
}

export interface ImageProject {
  id: string;
  userId: string;
  name: string;
  description: string;
  coverImageId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface GeneratedImage {
  id: string;
  taskId: string;
  userId: string;
  projectId: string | null;
  storageKey: string;
  thumbnailKey: string;
  thumbnailUrl: string;
  publicUrl: string;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  safetyStatus: SafetyStatus;
  visibility: ImageVisibility;
  generationMetadata: GenerationMetadata;
  deletedAt: string | null;
  createdAt: string;
}

export interface ReferenceImage {
  id: string;
  userId: string;
  storageKey: string;
  publicUrl: string;
  originalFileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  fileSize: number;
  width: number | null;
  height: number | null;
  contentHash: string;
  safetyStatus: SafetyStatus;
  createdAt: string;
  expiresAt: string;
  deletedAt: string | null;
}

export interface ImageFavorite {
  userId: string;
  imageId: string;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  credits: number;
  validDays: number | null;
  status: "ACTIVE" | "INACTIVE";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  userId: string;
  planId: string;
  orderNo: string;
  amountCents: number;
  currency: string;
  paymentProvider: string;
  paymentIntentId: string | null;
  status: OrderStatus;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentEvent {
  id: string;
  provider: string;
  providerEventId: string;
  orderId: string;
  eventType: string;
  payload: Record<string, unknown>;
  processedAt: string;
  createdAt: string;
}

export interface SafetyEvent {
  id: string;
  userId: string;
  targetType: "PROMPT" | "UPLOAD_IMAGE" | "GENERATED_IMAGE";
  targetId: string;
  status: SafetyStatus;
  reasonCode: string;
  reasonMessage: string;
  provider: string;
  createdAt: string;
}

export interface SafetyRule {
  id: string;
  term: string;
  action: "BLOCK" | "REVIEW";
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  updatedAt: string;
}

export type SafetyAppealStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface SafetyAppeal {
  id: string;
  userId: string;
  safetyEventId: string;
  reason: string;
  status: SafetyAppealStatus;
  adminNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AdminAuditLog {
  id: string;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
}

export type OperationalSeverity = "info" | "warning" | "critical";
export type OperationalArea = "generation" | "payments" | "http" | "system";
export type OperationalIncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";

export interface OperationalIncident {
  id: string;
  severity: OperationalSeverity;
  area: OperationalArea;
  status: OperationalIncidentStatus;
  message: string;
  errorCode: string | null;
  requestId: string | null;
  userId: string | null;
  taskId: string | null;
  orderId: string | null;
  route: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type AlertChannel = "local" | "email" | "webhook";
export type AlertNotificationStatus = "SENT" | "FAILED" | "SKIPPED";

export interface AlertNotification {
  id: string;
  alertId: string;
  channel: AlertChannel;
  status: AlertNotificationStatus;
  severity: OperationalSeverity;
  dedupeKey: string;
  message: string;
  createdAt: string;
  sentAt: string;
}

/**
 * 告警外发载荷。由 API 侧根据运营告警构造，交给 notifier 各通道渲染发送。
 * 独立于内部 OperationalAlert，保持 notifier 包不依赖 API 内部类型。
 */
export interface AlertNotificationPayload {
  id: string;
  severity: OperationalSeverity;
  area: OperationalArea;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  runbook: string;
}

export interface StoreData {
  users: User[];
  sessions: Session[];
  passwordResetTokens: PasswordResetToken[];
  emailVerificationTokens: EmailVerificationToken[];
  creditAccounts: UserCreditAccount[];
  creditLedgerEntries: CreditLedgerEntry[];
  generationTasks: GenerationTask[];
  referenceImages: ReferenceImage[];
  generatedImages: GeneratedImage[];
  imageFavorites: ImageFavorite[];
  imageProjects: ImageProject[];
  plans: Plan[];
  orders: Order[];
  paymentEvents: PaymentEvent[];
  safetyEvents: SafetyEvent[];
  safetyRules: SafetyRule[];
  safetyAppeals: SafetyAppeal[];
  adminAuditLogs: AdminAuditLog[];
  operationalIncidents: OperationalIncident[];
  alertNotifications: AlertNotification[];
}

export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "CAPTCHA_REQUIRED"
  | "CAPTCHA_INVALID"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_CREDITS"
  | "CONTENT_BLOCKED"
  | "CONTENT_REVIEW_REQUIRED"
  | "TASK_NOT_RETRYABLE"
  | "PLAN_UNAVAILABLE"
  | "ORDER_NOT_PAYABLE"
  | "RATE_LIMITED"
  | "RATE_LIMIT_UNAVAILABLE"
  | "FEATURE_DISABLED"
  | "INTERNAL_ERROR"
  | "INVALID_RESET_TOKEN"
  | "RESET_TOKEN_EXPIRED"
  | "INVALID_VERIFY_TOKEN"
  | "RESEND_TOO_SOON"
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_CURRENT_PASSWORD";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const aspectRatioDimensions: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:4": { width: 960, height: 1280 },
  "4:3": { width: 1280, height: 960 },
  "9:16": { width: 900, height: 1600 },
  "16:9": { width: 1600, height: 900 }
};

export const maxPromptLength = 1200;
export const maxQuantity = 4;
export const DEFAULT_PENDING_TASK_TIMEOUT_MS = 5 * 60 * 1000;
// OpenAI 批量生图会按请求张数放大超时预算，高质量四宫格时 30 分钟以内都属于正常兜底窗口。
export const DEFAULT_RUNNING_TASK_TIMEOUT_MS = 30 * 60 * 1000;
// 生成任务积分成本的唯一真源为 @imagora/ai-providers 的 quoteImageGeneration，
// 此处不再维护独立公式，避免两套计费口径漂移。

export function publicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  };
}

export function generationMetadataFromTask(task: GenerationTask): GenerationMetadata {
  return {
    taskId: task.id,
    prompt: task.prompt,
    negativePrompt: task.negativePrompt,
    style: task.style,
    aspectRatio: task.aspectRatio,
    quality: task.quality,
    quantity: task.quantity,
    modelProvider: task.modelProvider,
    modelName: task.modelName,
    width: task.width,
    height: task.height,
    creditCost: task.creditCost,
    createdAt: task.createdAt
  };
}

const blockedTerms = ["child abuse", "sexual violence", "terrorist", "自杀教学", "未成年人色情"];

export function checkPromptSafety(prompt: string): { status: SafetyStatus; reasonCode: string; reasonMessage: string } {
  const normalized = prompt.toLowerCase();
  const hit = blockedTerms.find((term) => normalized.includes(term.toLowerCase()));
  if (hit) {
    return {
      status: "BLOCKED",
      reasonCode: "LOCAL_RULE_HIT",
      reasonMessage: `提示词命中安全词：${hit}`
    };
  }
  return { status: "PASSED", reasonCode: "OK", reasonMessage: "本地提示词检查通过" };
}

export function requireNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

// ---- 积分批次过期精算（API / worker / 对账脚本共享的唯一实现）----
//
// 批次级 FIFO 精算：从完整流水重建每个「正向来源」（GRANT/REFUND/正向 ADJUST）的当前剩余额。
// 不变量：sum(所有来源剩余) === account.balance。
// 消耗归属规则：
//   1. EXPIRE 负向流水按 sourceId 钉死归属到目标批次（不进入通用池，避免误扣其他批次）；
//   2. 其余消耗（SPEND / 负向 ADJUST）按「最早到期优先」归属，让快过期的积分先被花掉。
export function creditSourceRemainders(entries: CreditLedgerEntry[]): Map<string, number> {
  const sources = entries
    .filter((entry) => entry.amount > 0)
    .map((entry) => ({
      id: entry.id,
      expiresAtMs: entry.expiresAt ? new Date(entry.expiresAt).getTime() : Number.POSITIVE_INFINITY,
      createdAtMs: new Date(entry.createdAt).getTime()
    }));
  const remainder = new Map<string, number>();
  for (const entry of entries) {
    if (entry.amount > 0) {
      remainder.set(entry.id, entry.amount);
    }
  }
  // 阶段一：EXPIRE 钉死扣减自身目标批次
  for (const entry of entries) {
    if (entry.type === "EXPIRE" && entry.amount < 0) {
      const current = remainder.get(entry.sourceId);
      if (current !== undefined) {
        remainder.set(entry.sourceId, current - Math.abs(entry.amount));
      }
    }
  }
  // 阶段二：通用消耗按最早到期优先归属
  let generic = 0;
  for (const entry of entries) {
    if (entry.amount < 0 && entry.type !== "EXPIRE") {
      generic += Math.abs(entry.amount);
    }
  }
  const ordered = [...sources].sort((a, b) =>
    a.expiresAtMs !== b.expiresAtMs ? a.expiresAtMs - b.expiresAtMs : a.createdAtMs - b.createdAtMs
  );
  for (const source of ordered) {
    if (generic <= 0) {
      break;
    }
    const available = remainder.get(source.id) ?? 0;
    const take = Math.min(available, generic);
    remainder.set(source.id, available - take);
    generic -= take;
  }
  return remainder;
}

export function groupLedgerByUser(entries: CreditLedgerEntry[]): Map<string, CreditLedgerEntry[]> {
  const byUser = new Map<string, CreditLedgerEntry[]>();
  for (const entry of entries) {
    const list = byUser.get(entry.userId) ?? [];
    list.push(entry);
    byUser.set(entry.userId, list);
  }
  return byUser;
}

// 扫描并回收已过期批次的剩余积分。幂等键 `credit-expire:{batchId}` + 剩余重算双保险。
// 返回本次回收的批次数量。直接原地修改 data，调用方需自行处于存储写锁内。
export function expireCredits(data: StoreData, nowInput?: string): number {
  const now = nowInput ?? new Date().toISOString();
  const nowMs = new Date(now).getTime();
  let expired = 0;
  for (const [userId, entries] of groupLedgerByUser(data.creditLedgerEntries)) {
    const remainders = creditSourceRemainders(entries);
    for (const entry of entries) {
      if (entry.type !== "GRANT" || !entry.expiresAt) {
        continue;
      }
      if (new Date(entry.expiresAt).getTime() > nowMs) {
        continue;
      }
      const idempotencyKey = `credit-expire:${entry.id}`;
      if (data.creditLedgerEntries.some((existing) => existing.idempotencyKey === idempotencyKey)) {
        continue;
      }
      const remainder = remainders.get(entry.id) ?? 0;
      if (remainder <= 0) {
        continue;
      }
      const account = data.creditAccounts.find((item) => item.userId === userId);
      if (!account) {
        continue;
      }
      account.balance -= remainder;
      account.totalSpent += remainder;
      account.updatedAt = now;
      data.creditLedgerEntries.push({
        id: randomUUID(),
        userId,
        type: "EXPIRE",
        amount: -remainder,
        balanceAfter: account.balance,
        sourceType: "SYSTEM",
        sourceId: entry.id,
        idempotencyKey,
        remark: `积分批次过期回收（批次 ${entry.id.slice(0, 8)}）`,
        createdAt: now,
        expiresAt: null
      });
      expired += 1;
    }
  }
  return expired;
}

export interface TaskRefundResult {
  refunded: boolean;
  amount: number;
  balanceAfter: number | null;
}

export interface GenerationMaintenanceOptions {
  now?: string;
  pendingTimeoutMs?: number;
  runningTimeoutMs?: number;
}

export interface GenerationMaintenanceResult {
  failedPendingTasks: number;
  failedRunningTasks: number;
  reconciledRefunds: number;
  refundedCredits: number;
}

export function refundTaskCredits(
  data: StoreData,
  task: GenerationTask,
  amount = task.creditCost,
  remark = "Task failed before image delivery",
  nowInput?: string
): TaskRefundResult {
  const idempotencyKey = `task-refund:${task.id}`;
  const account = data.creditAccounts.find((item) => item.userId === task.userId);
  if (!account) {
    return { refunded: false, amount: 0, balanceAfter: null };
  }
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return { refunded: false, amount: 0, balanceAfter: account.balance };
  }
  const spent = taskSpentCredits(data, task.id);
  const alreadyRefunded = taskRefundedCredits(data, task.id);
  const refundable = Math.max(0, spent - alreadyRefunded);
  const refundAmount = Math.min(Math.max(0, amount), refundable);
  if (refundAmount <= 0) {
    return { refunded: false, amount: 0, balanceAfter: account.balance };
  }
  const now = nowInput ?? new Date().toISOString();
  account.balance += refundAmount;
  account.totalSpent = Math.max(0, account.totalSpent - refundAmount);
  account.updatedAt = now;
  data.creditLedgerEntries.push({
    id: randomUUID(),
    userId: task.userId,
    type: "REFUND",
    amount: refundAmount,
    balanceAfter: account.balance,
    sourceType: "TASK",
    sourceId: task.id,
    idempotencyKey,
    remark,
    createdAt: now,
    expiresAt: null
  });
  return { refunded: true, amount: refundAmount, balanceAfter: account.balance };
}

export function taskRefundedCredits(data: StoreData, taskId: string): number {
  return data.creditLedgerEntries
    .filter((entry) => entry.type === "REFUND" && entry.sourceType === "TASK" && entry.sourceId === taskId)
    .reduce((sum, entry) => sum + Math.max(0, entry.amount), 0);
}

export function refundFailureCount(data: StoreData): number {
  return data.generationTasks.filter(
    (task) =>
      ["FAILED", "BLOCKED", "CANCELED"].includes(task.status) &&
      task.creditCost > 0 &&
      taskSpentCredits(data, task.id) > taskRefundedCredits(data, task.id)
  ).length;
}

export function runGenerationMaintenance(
  data: StoreData,
  options: GenerationMaintenanceOptions = {}
): GenerationMaintenanceResult {
  const now = options.now ?? new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TASK_TIMEOUT_MS;
  const runningTimeoutMs = options.runningTimeoutMs ?? DEFAULT_RUNNING_TASK_TIMEOUT_MS;
  const result: GenerationMaintenanceResult = {
    failedPendingTasks: 0,
    failedRunningTasks: 0,
    reconciledRefunds: 0,
    refundedCredits: 0
  };

  for (const task of data.generationTasks) {
    if (task.status === "PENDING" && isOlderThan(task.createdAt, nowMs, pendingTimeoutMs)) {
      markTaskFailed(task, "QUEUE_TIMEOUT", "生成任务排队超时，已自动返还本次扣除的积分。", now);
      result.failedPendingTasks += 1;
    } else if (task.status === "RUNNING" && task.startedAt && isOlderThan(task.startedAt, nowMs, runningTimeoutMs)) {
      markTaskFailed(task, "WORKER_TIMEOUT", "生成处理超时，已自动返还本次扣除的积分。", now);
      result.failedRunningTasks += 1;
    }

    if (["FAILED", "BLOCKED", "CANCELED"].includes(task.status)) {
      const refund = refundTaskCredits(data, task, task.creditCost, "Task ended before image delivery", now);
      if (refund.refunded) {
        result.reconciledRefunds += 1;
        result.refundedCredits += refund.amount;
      }
    }
  }

  return result;
}

function taskSpentCredits(data: StoreData, taskId: string): number {
  return data.creditLedgerEntries
    .filter((entry) => entry.type === "SPEND" && entry.sourceType === "TASK" && entry.sourceId === taskId)
    .reduce((sum, entry) => sum + Math.abs(Math.min(0, entry.amount)), 0);
}

function markTaskFailed(task: GenerationTask, code: string, message: string, now: string): void {
  task.status = "FAILED";
  task.failureCode = code;
  task.failureMessage = message;
  task.completedAt = now;
  task.updatedAt = now;
}

function isOlderThan(value: string, nowMs: number, timeoutMs: number): boolean {
  if (timeoutMs <= 0) {
    return false;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= nowMs - timeoutMs;
}
