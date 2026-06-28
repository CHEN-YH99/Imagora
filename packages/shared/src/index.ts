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
export type ModelId = "gpt-image-1" | "gpt-image-2" | "nano-banana-2" | "nano-banana-pro" | "seedream-4.5" | "mock";

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
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GeneratedImage {
  id: string;
  taskId: string;
  userId: string;
  storageKey: string;
  thumbnailKey: string;
  publicUrl: string;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  safetyStatus: SafetyStatus;
  visibility: ImageVisibility;
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

export interface AdminAuditLog {
  id: string;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
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
  plans: Plan[];
  orders: Order[];
  paymentEvents: PaymentEvent[];
  safetyEvents: SafetyEvent[];
  safetyRules: SafetyRule[];
  adminAuditLogs: AdminAuditLog[];
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
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_CREDITS"
  | "CONTENT_BLOCKED"
  | "TASK_NOT_RETRYABLE"
  | "PLAN_UNAVAILABLE"
  | "ORDER_NOT_PAYABLE"
  | "RATE_LIMITED"
  | "RATE_LIMIT_UNAVAILABLE"
  | "FEATURE_DISABLED"
  | "INTERNAL_ERROR"
  | "INVALID_RESET_TOKEN"
  | "RESET_TOKEN_EXPIRED"
  | "INVALID_VERIFY_TOKEN";

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

export const styleCost: Record<StyleId, number> = {
  realistic: 8,
  illustration: 6,
  anime: 6,
  product_photography: 7,
  poster: 9
};

export const qualityMultiplier: Record<Quality, number> = {
  draft: 0.7,
  standard: 1,
  high: 1.65
};

// 各模型相对 gpt-image-1 的积分成本倍率
export const modelCostMultiplier: Record<ModelId, number> = {
  mock: 1,
  "gpt-image-1": 1,
  "gpt-image-2": 1.5,
  "nano-banana-2": 1.2,
  "nano-banana-pro": 1.8,
  "seedream-4.5": 1.3
};

export const maxPromptLength = 1200;
export const maxQuantity = 4;

export function calculateCreditCost(input: {
  style: StyleId;
  quality: Quality;
  quantity: number;
  aspectRatio: AspectRatio;
  model?: ModelId;
}): number {
  const dimension = aspectRatioDimensions[input.aspectRatio];
  const megapixels = (dimension.width * dimension.height) / 1_000_000;
  const sizeMultiplier = megapixels > 1.4 ? 1.25 : 1;
  const modelMultiplier = modelCostMultiplier[input.model ?? "gpt-image-1"];
  return Math.ceil(
    styleCost[input.style] * qualityMultiplier[input.quality] * sizeMultiplier * modelMultiplier * input.quantity
  );
}

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
