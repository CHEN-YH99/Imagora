import { randomUUID } from "node:crypto";
import { maxPromptLength, maxQuantity } from "@imagora/shared";
import { z } from "zod";
import { envNumber } from "./runtime.js";

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

export const captchaRequiredRounds = 2;

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

export const registerSchema = z
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
export const loginSchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema,
    captchaVerificationIds: z.array(z.string().uuid()).max(captchaRequiredRounds).optional()
  })
  .strict();

export const captchaVerifySchema = z
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

export const requestPasswordResetSchema = z.object({
  email: emailSchema
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: newPasswordSchema
  })
  .strict();

export const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional()
});

export const changePasswordSchema = z
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

export const changeEmailSchema = z
  .object({
    newEmail: emailSchema,
    currentPassword: loginPasswordSchema
  })
  .strict();

// 注销账户：需要当前密码确认身份，reason 可选用于审计留档。
export const deleteAccountSchema = z
  .object({
    currentPassword: loginPasswordSchema,
    reason: z.string().trim().max(500).optional()
  })
  .strict();

export const generationInputSchema = z.object({
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

export const referenceUploadSchema = z.object({
  fileName: z.string().min(1).max(180),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  contentBase64: z.string().min(16).max(envNumber("UPLOAD_MAX_BASE64_CHARS", 8_000_000))
});

export const fileSignatureQuerySchema = z.object({
  expiresAt: z.string().regex(/^\d+$/, "expiresAt must be a millisecond timestamp"),
  signature: z.string().regex(/^[a-f0-9]{64}$/, "signature must be a 64-char hex digest")
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const adminRangeQuerySchema = paginationSchema.extend({
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional()
});

export const optionalPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const userStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "DELETED"]);
const userRoleSchema = z.enum(["USER", "ADMIN"]);
const taskStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "BLOCKED"]);
const imageVisibilitySchema = z.enum(["PRIVATE", "PUBLIC", "HIDDEN"]);
const orderStatusSchema = z.enum(["PENDING", "PAID", "CANCELED", "REFUNDED", "CLOSED"]);

export const taskQuerySchema = paginationSchema.extend({
  status: taskStatusSchema.optional()
});

export const adminUserQuerySchema = paginationSchema.extend({
  status: userStatusSchema.optional(),
  role: userRoleSchema.optional(),
  search: z.string().trim().max(120).optional()
});

export const adminTaskQuerySchema = adminRangeQuerySchema.extend({
  status: taskStatusSchema.optional(),
  userId: z.string().min(1).optional()
});

export const adminImageQuerySchema = adminRangeQuerySchema.extend({
  visibility: imageVisibilitySchema.optional(),
  userId: z.string().min(1).optional()
});

export const adminOrderQuerySchema = adminRangeQuerySchema.extend({
  status: orderStatusSchema.optional(),
  userId: z.string().min(1).optional(),
  orderNo: z.string().trim().min(1).max(80).optional()
});

export const adminAuditQuerySchema = paginationSchema.extend({
  adminUserId: z.string().min(1).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  targetType: z.string().trim().min(1).max(80).optional(),
  targetId: z.string().trim().min(1).max(120).optional()
});

export const idParamSchema = z.object({ taskId: z.string().min(1) });
export const imageParamSchema = z.object({ imageId: z.string().min(1) });
export const orderParamSchema = z.object({ orderId: z.string().min(1) });
export const userParamSchema = z.object({ userId: z.string().min(1) });
export const planParamSchema = z.object({ planId: z.string().min(1) });
export const paymentWebhookParamSchema = z.object({ provider: z.string().min(1) });

export const createOrderSchema = z.object({
  planId: z.string().min(1),
  paymentProvider: z.enum(["mock", "stripe", "wechat", "alipay"]).default("mock"),
  clientRequestId: z.string().min(8).max(120).optional()
});

export const adminReasonSchema = z.object({ reason: z.string().trim().min(3).max(240) });
const statusSchema = z.object({ status: userStatusSchema });
const visibilitySchema = z.object({ visibility: imageVisibilitySchema });
export const adjustCreditSchema = z.object({
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
export const adminStatusSchema = statusSchema.merge(adminReasonSchema);
export const adminVisibilitySchema = visibilitySchema.merge(adminReasonSchema);
export const adminPlanSchema = planSchema.merge(adminReasonSchema);
export const adminPlanPatchSchema = planPatchSchema.merge(adminReasonSchema);
export const safetyRuleParamSchema = z.object({ ruleId: z.string().min(1) });
export const safetyRuleSchema = z.object({
  term: z.string().min(2).max(120),
  action: z.enum(["BLOCK", "REVIEW"]),
  status: z.enum(["ACTIVE", "INACTIVE"])
});
export const safetyRulePatchSchema = safetyRuleSchema.partial();
export const safetyEventParamSchema = z.object({ eventId: z.string().min(1) });
export const safetyEventQuerySchema = z.object({
  status: z.enum(["PASSED", "BLOCKED", "REVIEW_REQUIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export const safetyEventReviewSchema = z.object({ status: z.enum(["PASSED", "BLOCKED"]) }).merge(adminReasonSchema);
export const safetyAppealParamSchema = z.object({ appealId: z.string().min(1) });
export const safetyAppealCreateSchema = z.object({
  safetyEventId: z.string().min(1),
  reason: z.string().min(10).max(1000)
});
export const safetyAppealAdminQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
export const safetyAppealReviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNote: z.string().min(1).max(500).optional()
});

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}

function normalizePasswordForBlocklist(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
