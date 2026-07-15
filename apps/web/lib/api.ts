const defaultApiBaseUrl = "http://127.0.0.1:4100";
const defaultRequestTimeoutMs = 15_000;
const defaultTaskPollIntervalMs = 2_000;
const defaultTaskWaitTimeoutMs = 5 * 60_000;

export const apiBaseUrl = resolveApiBaseUrl();
export const DEFAULT_IMAGE_MODEL_ID = "openai:gpt-image-2";
export const DEFAULT_MOCK_IMAGE_MODEL_ID = "mock:default";
export const IMAGE_MODEL_OPTIONS = [{ value: DEFAULT_IMAGE_MODEL_ID, label: "GPT Image 2" }] as const;

// 会话过期广播：受保护页面订阅后统一跳登录，避免各页只弹红字卡死。
// 登录/注册/找回/重置/验证码等 auth 接口的 401 属于业务性失败，不应触发全局跳转。
export const SESSION_EXPIRED_EVENT = "imagora:session-expired";

let currentUserCache: User | null | undefined;
let currentUserPromise: Promise<User | null> | null = null;

export function normalizeImageModel(modelName?: string | null): string {
  const normalized = modelName?.trim();
  if (!normalized) {
    return DEFAULT_IMAGE_MODEL_ID;
  }
  if (normalized === "gpt-image-2") {
    return DEFAULT_IMAGE_MODEL_ID;
  }
  if (normalized === "mock") {
    return DEFAULT_MOCK_IMAGE_MODEL_ID;
  }
  return normalized;
}

export function resolveSelectableImageModel(modelName?: string | null): string {
  const normalized = normalizeImageModel(modelName);
  return IMAGE_MODEL_OPTIONS.some((option) => option.value === normalized) ? normalized : DEFAULT_IMAGE_MODEL_ID;
}

export function resolveImageSrc(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) {
      if (normalized.startsWith("/api/files/")) {
        return `${apiBaseUrl}${normalized}`;
      }
      return normalized;
    }
  }
  return null;
}

// 触发生成图片下载。filesystem 存储签出的是 /api/files 相对路径，需补全到 API 域名；
// 且 API 与 web 跨域，<a download> 的 download 属性会被浏览器忽略，故先 fetch 成同源 blob
// 再触发下载。返回下载的文件名供调用方提示。签名 URL 自带 HMAC 校验，无需附带 cookie。
export async function downloadGeneratedImage(imageId: string): Promise<string> {
  const result = await apiFetch<{ url: string; fileName: string }>(`/api/images/${imageId}/download-url`, {
    method: "POST",
    body: {}
  });
  const downloadSrc = resolveImageSrc(result.url);
  if (!downloadSrc) {
    throw new Error("下载链接无效，请稍后重试。");
  }
  const response = await fetch(downloadSrc);
  if (!response.ok) {
    throw new Error("下载失败，请稍后重试。");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = result.fileName;
    anchor.rel = "noreferrer";
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return result.fileName;
}

function isAuthEndpoint(path: string): boolean {
  return path.startsWith("/api/auth/");
}

function notifySessionExpired(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

export type User = {
  id: string;
  email: string;
  nickname: string;
  avatarUrl: string | null;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

export function peekCurrentUser(): User | null | undefined {
  return currentUserCache;
}

export function setCurrentUser(user: User | null): void {
  currentUserCache = user;
  currentUserPromise = null;
}

export async function getCurrentUser(options: { force?: boolean } = {}): Promise<User | null> {
  if (!options.force && currentUserCache !== undefined) {
    return currentUserCache;
  }

  if (!options.force && currentUserPromise) {
    return currentUserPromise;
  }

  currentUserPromise = apiFetch<{ user: User }>("/api/auth/me")
    .then((result) => {
      currentUserCache = result.user;
      return result.user;
    })
    .catch((error) => {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        currentUserCache = null;
        return null;
      }
      throw error;
    })
    .finally(() => {
      currentUserPromise = null;
    });

  return currentUserPromise;
}

export type CaptchaChallenge = {
  captchaId: string;
  imageSvg: string;
  instruction: string;
  targetLabel: string;
  requiredSelections: number;
  optionCount: number;
  expiresAt: string;
};

export type CaptchaSelection = {
  x: number;
  y: number;
};

export type CaptchaVerification = {
  verificationId: string;
  expiresAt: string;
};

export type CreditAccount = {
  userId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
};

export type CreditLedgerEntry = {
  id: string;
  type: "GRANT" | "SPEND" | "REFUND" | "EXPIRE" | "ADJUST";
  amount: number;
  balanceAfter: number;
  remark: string;
  createdAt: string;
  expiresAt?: string | null;
};

export type Task = {
  id: string;
  userId: string;
  clientRequestId: string;
  referenceImageId?: string | null;
  prompt: string;
  negativePrompt: string | null;
  style: string;
  aspectRatio: string;
  width: number;
  height: number;
  quantity: number;
  quality: string;
  modelProvider: string;
  modelName: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "BLOCKED";
  creditCost: number;
  refundedCredits?: number;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GenerationMetadata = {
  taskId: string;
  prompt: string;
  negativePrompt: string | null;
  style: string;
  aspectRatio: string;
  quality: string;
  quantity: number;
  modelProvider: string;
  modelName: string;
  width: number;
  height: number;
  creditCost: number;
  createdAt: string;
};

export type ReferenceImage = {
  id: string;
  publicUrl: string;
  originalFileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  fileSize: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  expiresAt: string;
};

export type GeneratedImage = {
  id: string;
  taskId: string;
  userId: string;
  projectId: string | null;
  storageKey?: string;
  thumbnailUrl: string;
  publicUrl: string;
  thumbnailKey?: string;
  width: number;
  height: number;
  fileSize?: number;
  mimeType?: string;
  safetyStatus?: "PASSED" | "BLOCKED" | "REVIEW_REQUIRED";
  visibility: "PRIVATE" | "PUBLIC" | "HIDDEN";
  generationMetadata: GenerationMetadata;
  favorite?: boolean;
  deletedAt: string | null;
  createdAt: string;
};

export type ImageProject = {
  id: string;
  userId: string;
  name: string;
  description: string;
  coverImageId: string | null;
  coverThumbnailUrl?: string | null;
  imageCount?: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type Plan = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  credits: number;
  validDays: number | null;
  status: "ACTIVE" | "INACTIVE";
  sortOrder: number;
};

export type Order = {
  id: string;
  userId: string;
  orderNo: string;
  planId: string;
  amountCents: number;
  currency: string;
  paymentProvider: string;
  paymentIntentId: string | null;
  status: "PENDING" | "PAID" | "CANCELED" | "REFUNDED" | "CLOSED";
  paidAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type PaymentEvent = {
  id: string;
  provider: string;
  providerEventId: string;
  orderId: string;
  eventType: string;
  payload: Record<string, unknown>;
  processedAt: string;
  createdAt: string;
};

export type AuditLog = {
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
};

export type SafetyEvent = {
  id: string;
  userId: string;
  targetType: "PROMPT" | "UPLOAD_IMAGE" | "GENERATED_IMAGE";
  targetId: string;
  status: "PASSED" | "BLOCKED" | "REVIEW_REQUIRED";
  reasonCode: string;
  reasonMessage: string;
  provider: string;
  createdAt: string;
};

export type SafetyAppeal = {
  id: string;
  userId: string;
  safetyEventId: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  adminNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type AdminMetrics = {
  users: number;
  tasks: number;
  images: number;
  paidOrders: number;
  paidRevenueCents: number;
  aiCostCents: number;
  grossProfitCents: number;
  blockedSafetyEvents: number;
  reviewRequiredSafetyEvents: number;
};

export type OrderMaintenance = {
  closedExpiredOrders: number;
  reconciledPaidOrders: number;
  reconciledPaymentEvents: number;
  expiredCredits: number;
  failedPendingGenerationTasks: number;
  failedRunningGenerationTasks: number;
  reconciledGenerationRefunds: number;
  refundedGenerationCredits: number;
};

export type OperationalAlert = {
  id: string;
  severity: "warning" | "critical";
  area: "generation" | "payments" | "http";
  metric: string;
  value: number;
  threshold: number;
  message: string;
  runbook: string;
};

export type OperationalIncident = {
  id: string;
  severity: "info" | "warning" | "critical";
  area: "generation" | "payments" | "http" | "system";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
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
};

export type AlertNotification = {
  id: string;
  alertId: string;
  channel: "local";
  status: "SENT";
  severity: "info" | "warning" | "critical";
  dedupeKey: string;
  message: string;
  createdAt: string;
  sentAt: string;
};

export type AdminOperationalMetrics = {
  service: {
    uptimeSeconds: number;
    startedAt: string;
    features: {
      generation: boolean;
      payments: boolean;
      uploads: boolean;
      downloads: boolean;
    };
  };
  http: {
    requestsTotal: number;
    failuresTotal: number;
  };
  domain: {
    generationSuccessRate: number | null;
    generationFailureRate: number | null;
    averageGenerationDurationMs: number | null;
    averageQueueWaitMs: number | null;
    referenceImagesTotal: number;
    paymentEventsTotal: number;
    paymentFailuresTotal: number;
    refundFailuresTotal: number;
    blockedSafetyEventsTotal: number;
    creditsOutstanding: number;
    creditsExpiringSoon: number;
    creditsExpiredTotal: number;
    paidRevenueCents: number;
    aiCostCents: number;
    grossProfitCents: number;
  };
  maintenance: OrderMaintenance;
  alerts: OperationalAlert[];
  recentIncidents: OperationalIncident[];
  alertNotifications: AlertNotification[];
};

export type SafetyRule = {
  id: string;
  term: string;
  action: "BLOCK" | "REVIEW";
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
};

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string | undefined,
    public readonly apiMessage: string | undefined,
    public readonly status: number
  ) {
    super(formatApiErrorMessage(code, apiMessage, status));
    this.name = "ApiRequestError";
  }
}

export class TaskWaitTimeoutError extends Error {
  constructor(public readonly latestResult: { task: Task; images: GeneratedImage[] } | null) {
    super("生成任务仍在处理中，稍后可在历史记录中查看结果。");
    this.name = "TaskWaitTimeoutError";
  }
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultRequestTimeoutMs);

  try {
    const response = await fetch(`${resolveApiBaseUrl()}${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await readApiPayload<T>(response);
    if (!response.ok || !payload.data) {
      // 非 auth 接口返回 401 视为会话过期，广播给受保护页统一跳登录
      if (response.status === 401 && payload.error?.code === "UNAUTHORIZED" && !isAuthEndpoint(path)) {
        notifySessionExpired();
      }
      throw new ApiRequestError(payload.error?.code, payload.error?.message, response.status);
    }
    return payload.data;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("请求超时，请检查网络后重试。");
    }
    if (error instanceof TypeError) {
      throw new Error("网络连接失败，请检查网络后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function resolveApiBaseUrl(): string {
  const configured = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL);
  if (typeof window === "undefined") {
    return configured ?? defaultApiBaseUrl;
  }
  if (!isLocalHostname(window.location.hostname)) {
    return configured ?? defaultApiBaseUrl;
  }
  if (!configured) {
    return `${window.location.protocol}//${window.location.hostname}:4100`;
  }
  try {
    const url = new URL(configured);
    if (!isLocalHostname(url.hostname)) {
      return configured;
    }
    return `${url.protocol}//${window.location.hostname}:${url.port || "4100"}`;
  } catch {
    return configured;
  }
}

function normalizeApiBaseUrl(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\/$/, "");
  return normalized || null;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function readApiPayload<T>(
  response: Response
): Promise<{ data?: T; error?: { code?: string; message: string } }> {
  const text = await response.text();
  if (!text) {
    return response.ok ? {} : { error: { message: response.statusText || "Request failed" } };
  }
  try {
    return JSON.parse(text) as { data?: T; error?: { code?: string; message: string } };
  } catch {
    return { error: { message: response.ok ? "Invalid JSON response" : response.statusText || "Request failed" } };
  }
}

export async function getLoginCaptcha(): Promise<CaptchaChallenge> {
  return apiFetch<CaptchaChallenge>("/api/auth/captcha");
}

export async function verifyLoginCaptcha(
  captchaId: string,
  captchaSelections: CaptchaSelection[]
): Promise<CaptchaVerification> {
  return apiFetch<CaptchaVerification>("/api/auth/captcha/verify", {
    method: "POST",
    body: { captchaId, captchaSelections }
  });
}

export async function login(
  email: string,
  password: string,
  captchaVerificationIds: string[]
): Promise<{ user: User }> {
  const result = await apiFetch<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: { email, password, captchaVerificationIds }
  });
  setCurrentUser(result.user);
  return result;
}

export async function register(email: string, password: string): Promise<{ user: User; emailDelivered: boolean }> {
  const result = await apiFetch<{ user: User; emailDelivered: boolean }>("/api/auth/register", {
    method: "POST",
    body: { email, password }
  });
  setCurrentUser(result.user);
  return result;
}

export async function waitForTask(
  taskId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<{ task: Task; images: GeneratedImage[] }> {
  const timeoutMs = options.timeoutMs ?? defaultTaskWaitTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? defaultTaskPollIntervalMs;
  const startedAt = Date.now();
  let latestResult: { task: Task; images: GeneratedImage[] } | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    const result = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`);
    latestResult = result;
    if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELED"].includes(result.task.status)) {
      return result;
    }
  }
  throw new TaskWaitTimeoutError(latestResult);
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
  setCurrentUser(null);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiFetch<{ ok: boolean; message: string }>("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword }
  });
}

export async function changeEmail(currentPassword: string, newEmail: string): Promise<{ user: User }> {
  const result = await apiFetch<{ user: User }>("/api/auth/change-email", {
    method: "POST",
    body: { currentPassword, newEmail }
  });
  setCurrentUser(result.user);
  return result;
}

export type UserSession = {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
};

export async function getSessions(): Promise<{ sessions: UserSession[] }> {
  return apiFetch<{ sessions: UserSession[] }>("/api/auth/sessions");
}

export async function logoutOtherSessions(): Promise<{ removed: number }> {
  return apiFetch<{ ok: boolean; removed: number }>("/api/auth/logout-others", {
    method: "POST"
  });
}

export async function deleteAccount(currentPassword: string, reason?: string): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/delete-account", {
    method: "POST",
    body: { currentPassword, ...(reason ? { reason } : {}) }
  });
  setCurrentUser(null);
}

export async function submitSafetyAppeal(safetyEventId: string, reason: string): Promise<{ appeal: SafetyAppeal }> {
  return apiFetch<{ appeal: SafetyAppeal }>("/api/safety-appeals", {
    method: "POST",
    body: { safetyEventId, reason }
  });
}

export async function getSafetyAppeals(): Promise<{ appeals: SafetyAppeal[] }> {
  return apiFetch<{ appeals: SafetyAppeal[] }>("/api/safety-appeals");
}

export function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const normalizedCurrency = currency.toUpperCase();
  const amountText = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(amount);
  const currencyNameMap: Record<string, string> = {
    CNY: "元",
    USD: "美元"
  };
  const currencyName = currencyNameMap[normalizedCurrency] ?? normalizedCurrency;
  return `${amountText} ${currencyName}`;
}

const labelMap: Record<string, string> = {
  ACTIVE: "启用",
  ADMIN: "管理员",
  ADJUST: "人工调整",
  ACKNOWLEDGED: "已确认",
  BLOCK: "拦截",
  BLOCKED: "已拦截",
  CANCELED: "已取消",
  CLOSED: "已关闭",
  critical: "严重",
  DELETED: "已删除",
  EXPIRE: "过期",
  FAILED: "失败",
  GRANT: "发放",
  HIDDEN: "已隐藏",
  IDLE: "待提交",
  INACTIVE: "停用",
  info: "提示",
  OPEN: "待处理",
  PAID: "已支付",
  PASSED: "已通过",
  PENDING: "待处理",
  PRIVATE: "私有",
  PUBLIC: "公开",
  REFUND: "退回",
  REFUNDED: "已退款",
  RESOLVED: "已解决",
  REVIEW: "复核",
  REVIEW_REQUIRED: "待复核",
  RUNNING: "处理中",
  SENT: "已发送",
  SPEND: "消耗",
  SUCCEEDED: "已完成",
  SUSPENDED: "已停用",
  USER: "普通用户",
  warning: "警告"
};

const styleLabelMap: Record<string, string> = {
  anime: "动漫",
  cinematic: "电影写实",
  illustration: "插画",
  isometric: "等距图形",
  poster: "海报设计",
  product: "产品摄影",
  product_photography: "产品摄影",
  realistic: "写实"
};

const qualityLabelMap: Record<string, string> = {
  draft: "草稿",
  Draft: "草稿",
  high: "高清",
  standard: "标准",
  Studio: "标准",
  Ultra: "精细"
};

const planNameMap: Record<string, string> = {
  Creator: "创作者版",
  Starter: "入门版",
  Studio: "团队版"
};

const planDescriptionMap: Record<string, string> = {
  "1850 credits for teams and ecommerce operators": "面向小团队、电商运营和持续内容生产的高容量积分包。",
  "220 credits for prompt exploration": "适合验证提示词方向、探索风格和完成轻量创作。",
  "620 credits with HD downloads": "适合个人创作者稳定生成素材，并支持高清下载。"
};

const providerLabelMap: Record<string, string> = {
  alipay: "支付宝",
  mock: "平台结算",
  stripe: "银行卡支付",
  wechat: "微信支付"
};

const auditActionMap: Record<string, string> = {
  "maintenance.generation.reconcile": "生成任务补偿对账",
  "image.visibility.update": "图片可见性变更",
  "maintenance.reconcile": "订单对账",
  "plan.create": "创建套餐",
  "plan.update": "更新套餐",
  "safety-rule.create": "新增安全规则",
  "safety-rule.update": "更新安全规则",
  "safety-event.review": "安全事件复核",
  "user.credits.adjust": "用户积分调整",
  "user.status.update": "用户状态变更"
};

const targetTypeMap: Record<string, string> = {
  IMAGE: "图片",
  ORDER: "订单",
  PLAN: "套餐",
  PROMPT: "提示词",
  SAFETY_RULE: "安全规则",
  SAFETY_EVENT: "安全事件",
  SYSTEM: "系统",
  TASK: "任务",
  UPLOAD_IMAGE: "参考图",
  USER: "用户"
};

const metricLabelMap: Record<string, string> = {
  generation: "生成",
  generationBacklog: "生成任务积压",
  generationFailureRate: "生成失败率",
  http: "接口",
  httpFailureRate: "接口失败率",
  paymentAmountMismatchEvents: "支付金额不一致事件",
  payments: "支付",
  pendingOrders: "待支付订单",
  refundFailuresTotal: "积分退回失败",
  staleRunningTasks: "长时间运行任务"
};

const alertMessageMap: Record<string, string> = {
  "Generation failure rate is above threshold.": "生成失败率超过阈值。",
  "Generation task backlog is above threshold.": "生成任务积压超过阈值。",
  "Generation tasks have been running longer than the stale threshold.": "存在运行时间超过阈值的生成任务。",
  "Generation refund failures were detected.": "检测到生成失败后的积分退回异常。",
  "HTTP 5xx failure rate is above threshold.": "服务接口 5xx 失败率超过阈值。",
  "Payment succeeded events with amount mismatch were detected.": "检测到支付成功事件与订单金额不一致。",
  "Pending payment orders are above threshold.": "待支付订单数量超过阈值。"
};

const alertRunbookMap: Record<string, string> = {
  "Check payment provider status, disable payments if needed, and run order reconciliation.":
    "检查支付服务状态，必要时暂停支付入口，并执行订单对账。",
  "Disable generation, inspect provider failures, and restart/scale workers after provider health is confirmed.":
    "暂停生成入口，检查模型服务故障，确认服务恢复后重启或扩容生成处理服务。",
  "Do not manually grant credits until the provider event and order snapshot are verified.":
    "在核对支付事件和订单快照前，不要手动发放积分。",
  "Inspect route metrics, recent deploys, and provider logs by requestId.":
    "按请求编号检查路由指标、近期发布记录和外部服务日志。",
  "Pause generation, inspect credit ledger entries by taskId, and reconcile refunds before retrying.":
    "暂停生成入口，按任务编号核对积分流水，完成退回对账后再恢复重试。",
  "Run worker recovery, verify refunds, and check provider timeout logs by taskId.":
    "执行生成处理服务恢复流程，核对积分退回，并按任务编号检查超时日志。",
  "Scale workers or temporarily disable generation submissions until backlog drains.":
    "扩容生成处理服务，或临时暂停新的生成提交，直到积压任务处理完毕。"
};

const safetyRuleTermMap: Record<string, string> = {
  "child abuse": "儿童安全风险内容",
  "sexual violence": "性暴力内容",
  terrorist: "恐怖主义内容"
};

const apiErrorCodeMap: Record<string, string> = {
  CONFLICT: "账号信息无法完成注册，请检查邮箱或直接登录。",
  CAPTCHA_INVALID: "图片验证已失效或输入错误，请刷新后重试。",
  CAPTCHA_REQUIRED: "请先完成图片验证。",
  CONTENT_BLOCKED: "内容未通过安全规则，请调整提示词或参考图后重试。",
  CONTENT_REVIEW_REQUIRED: "内容已提交人工复核，暂时无法生成。如认为是误判，可在下方发起申诉。",
  FEATURE_DISABLED: "该功能当前暂不可用，请稍后再试。",
  FORBIDDEN: "当前账号没有权限执行此操作。",
  INSUFFICIENT_CREDITS: "积分余额不足，请充值后再提交生成。",
  INTERNAL_ERROR: "服务暂时异常，请稍后重试。",
  INVALID_CURRENT_PASSWORD: "当前密码不正确，请重新输入。",
  INVALID_RESET_TOKEN: "重置链接无效或已过期，请重新申请。",
  INVALID_VERIFY_TOKEN: "验证链接无效或已过期，请重新申请验证邮件。",
  NOT_FOUND: "请求的资源不存在或已被移除。",
  ORDER_NOT_PAYABLE: "该订单当前不可支付，请重新创建订单。",
  PLAN_UNAVAILABLE: "该套餐当前不可购买，请选择其他套餐。",
  RATE_LIMITED: "操作过于频繁，请稍后再试。",
  RATE_LIMIT_UNAVAILABLE: "服务限流组件暂时不可用，请稍后再试。",
  TASK_NOT_RETRYABLE: "只有失败或被拦截的任务可以重新生成。",
  UNAUTHORIZED: "登录已失效，请重新登录。",
  VALIDATION_ERROR: "提交内容格式不正确，请检查后重试。"
};

const apiErrorMessageMap: Record<string, string> = {
  "Admin cannot change own status here": "不能在此处修改当前管理员账号状态。",
  "Cannot remove the last active administrator": "不能移除最后一个启用中的管理员账号。",
  "Credit balance is not enough": "积分余额不足，请充值后再提交生成。",
  "Email is already registered": "该邮箱已注册，请直接登录或更换邮箱。",
  "Unable to create account with these credentials": "账号信息无法完成注册，请检查邮箱或直接登录。",
  "Invalid email or password": "邮箱或密码不正确。",
  "Invalid request payload": "提交内容格式不正确，请检查后重试。",
  "Only failed or blocked tasks can be retried": "只有失败或被拦截的任务可以重新生成。",
  "Order is not payable": "该订单当前不可支付，请重新创建订单。",
  "Payment provider does not match order": "支付渠道与订单不匹配，请重新创建订单。",
  "Payment provider is not enabled": "当前支付渠道未启用。",
  "Plan is not available": "该套餐当前不可购买，请选择其他套餐。",
  "Prompt requires manual safety review": "内容需要人工复核，暂时无法提交生成；如有误判请联系管理员申诉。",
  "Reference image requires manual safety review": "参考图需要人工复核，暂时无法使用；如有误判请联系管理员申诉。",
  "Prompt was blocked by safety rules": "提示词未通过安全规则，请调整后重试。",
  "Reference image content is empty": "参考图内容为空，请重新上传。",
  "Reference image content is not valid base64": "参考图内容无法识别，请重新上传。",
  "Reference image was blocked by safety rules": "参考图未通过安全规则，请更换图片后重试。",
  "Request failed": "请求失败，请稍后重试。",
  "Too many requests, please retry later": "操作过于频繁，请稍后再试。",
  "User is not active": "账号当前不可用，请联系管理员。"
};

export function formatStatusLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return labelMap[value] ?? value;
}

export function formatStyleLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return styleLabelMap[value] ?? value;
}

export function formatQualityLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return qualityLabelMap[value] ?? value;
}

export function formatCredits(value: number): string {
  return `${value.toLocaleString("zh-CN")} 积分`;
}

export function formatPlanName(value: string): string {
  return planNameMap[value] ?? value;
}

export function formatPlanDescription(value: string): string {
  return planDescriptionMap[value] ?? value;
}

export function formatPaymentProvider(value: string): string {
  return providerLabelMap[value] ?? value;
}

export function formatAuditAction(value: string): string {
  return auditActionMap[value] ?? value;
}

export function formatTargetType(value: string): string {
  return targetTypeMap[value] ?? value;
}

export function formatMetricLabel(value: string): string {
  return metricLabelMap[value] ?? value;
}

export function formatOperationalAlertMessage(value: string): string {
  return alertMessageMap[value] ?? value;
}

export function formatOperationalRunbook(value: string): string {
  return alertRunbookMap[value] ?? value;
}

export function formatSafetyRuleTerm(value: string): string {
  return safetyRuleTermMap[value] ?? value;
}

export function formatNickname(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  if (value === "Demo Creator") {
    return "创作用户";
  }
  if (value === "Imagora Admin") {
    return "Imagora 管理员";
  }
  return value;
}

export function formatLedgerRemark(value: string): string {
  if (value === "Initial admin credits") {
    return "管理员初始积分";
  }
  if (value === "Demo welcome credits" || value === "Welcome credits") {
    return "新用户欢迎积分";
  }
  if (value === "Image generation task") {
    return "图片生成任务扣减";
  }
  if (value === "Retry image generation task") {
    return "重新生成任务扣减";
  }
  if (value === "Generation task could not be queued") {
    return "生成任务入队失败自动返还";
  }
  if (value === "Task ended before image delivery" || value === "Task failed before image delivery") {
    return "生成未交付自动返还";
  }
  if (value === "未交付图片的积分自动返还") {
    return value;
  }
  if (value.startsWith("Purchased ")) {
    return `购买${formatPlanName(value.replace("Purchased ", ""))}`;
  }
  return value;
}

export function formatApiErrorMessage(code: string | undefined, message: string | undefined, status?: number): string {
  if (code && apiErrorCodeMap[code]) {
    return apiErrorCodeMap[code];
  }
  if (message && apiErrorMessageMap[message]) {
    return apiErrorMessageMap[message];
  }
  return status ? `请求失败，请稍后重试。（${status}）` : "请求失败，请稍后重试。";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
