const defaultApiBaseUrl = "http://127.0.0.1:4100";
const defaultRequestTimeoutMs = 15_000;

export const apiBaseUrl = resolveApiBaseUrl();

export type User = {
  id: string;
  email: string;
  nickname: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerifiedAt: string | null;
};

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
};

export type Task = {
  id: string;
  referenceImageId?: string | null;
  prompt: string;
  style: string;
  aspectRatio: string;
  quantity: number;
  quality: string;
  modelName: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "BLOCKED";
  creditCost: number;
  failureMessage: string | null;
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
  storageKey?: string;
  publicUrl: string;
  thumbnailKey?: string;
  width: number;
  height: number;
  fileSize?: number;
  mimeType?: string;
  safetyStatus?: "PASSED" | "BLOCKED" | "REVIEW_REQUIRED";
  visibility: "PRIVATE" | "PUBLIC" | "HIDDEN";
  favorite?: boolean;
  createdAt: string;
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
  orderNo: string;
  planId: string;
  amountCents: number;
  currency: string;
  paymentProvider: string;
  status: "PENDING" | "PAID" | "CANCELED" | "REFUNDED" | "CLOSED";
  paidAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type AdminMetrics = {
  users: number;
  tasks: number;
  images: number;
  paidOrders: number;
  paidRevenueCents: number;
  blockedSafetyEvents: number;
};

export type OrderMaintenance = {
  closedExpiredOrders: number;
  reconciledPaidOrders: number;
  reconciledPaymentEvents: number;
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
    averageGenerationDurationMs: number | null;
    referenceImagesTotal: number;
    paymentEventsTotal: number;
    blockedSafetyEventsTotal: number;
  };
  maintenance: OrderMaintenance;
  alerts: OperationalAlert[];
};

export type SafetyRule = {
  id: string;
  term: string;
  action: "BLOCK" | "REVIEW";
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
};

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
      throw new Error(formatApiErrorMessage(payload.error?.code, payload.error?.message, response.status));
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
  return apiFetch<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: { email, password, captchaVerificationIds }
  });
}

export async function register(email: string, password: string): Promise<{ user: User }> {
  return apiFetch<{ user: User }>("/api/auth/register", {
    method: "POST",
    body: { email, password }
  });
}

export async function loginDemo(): Promise<{ user: User }> {
  throw new Error("请先在登录页完成图片验证后再继续。");
}

export async function waitForTask(taskId: string): Promise<{ task: Task; images: GeneratedImage[] }> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(1000);
    const result = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`);
    if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELED"].includes(result.task.status)) {
      return result;
    }
  }
  throw new Error("生成任务等待超时，请稍后在历史记录中查看结果。");
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
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
  PAID: "已支付",
  PENDING: "待处理",
  PRIVATE: "私有",
  PUBLIC: "公开",
  REFUND: "退回",
  REFUNDED: "已退款",
  REVIEW: "复核",
  RUNNING: "处理中",
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
  "image.visibility.update": "图片可见性变更",
  "maintenance.reconcile": "订单对账",
  "plan.create": "创建套餐",
  "plan.update": "更新套餐",
  "safety.rule.create": "新增安全规则",
  "user.credits.adjust": "用户积分调整",
  "user.status.update": "用户状态变更"
};

const targetTypeMap: Record<string, string> = {
  IMAGE: "图片",
  ORDER: "订单",
  PLAN: "套餐",
  PROMPT: "提示词",
  SAFETY_RULE: "安全规则",
  TASK: "任务",
  UPLOAD_IMAGE: "参考图",
  USER: "用户"
};

const metricLabelMap: Record<string, string> = {
  generationBacklog: "生成任务积压",
  generationFailureRate: "生成失败率",
  httpFailureRate: "接口失败率",
  paymentAmountMismatchEvents: "支付金额不一致事件",
  pendingOrders: "待支付订单",
  staleRunningTasks: "长时间运行任务"
};

const alertMessageMap: Record<string, string> = {
  "Generation failure rate is above threshold.": "生成失败率超过阈值。",
  "Generation task backlog is above threshold.": "生成任务积压超过阈值。",
  "Generation tasks have been running longer than the stale threshold.": "存在运行时间超过阈值的生成任务。",
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
  FEATURE_DISABLED: "该功能当前暂不可用，请稍后再试。",
  FORBIDDEN: "当前账号没有权限执行此操作。",
  INSUFFICIENT_CREDITS: "积分余额不足，请充值后再提交生成。",
  INTERNAL_ERROR: "服务暂时异常，请稍后重试。",
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
