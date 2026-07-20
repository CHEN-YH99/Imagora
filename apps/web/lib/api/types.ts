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

export type CaptchaConfig = {
  mode: "builtin" | "turnstile";
  turnstile: { enabled: boolean; siteKey: string };
};

export type UserSession = {
  id: string;
  current: boolean;
  createdAt: string;
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

export type PageInfo = {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
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
