import {
  assertProductionOpenAiGenerationConfig,
  readOpenAiGenerationRuntimeConfig,
  resolveDefaultImageModel,
  resolveDefaultImageProvider
} from "@imagora/ai-providers";
import { maxQuantity } from "@imagora/shared";
import { envBool } from "./runtime.js";

interface ProductionConfigOptions {
  allowBearerSessionAuth: () => boolean;
  isProduction: boolean;
  requireEmailVerification: () => boolean;
}

export function validateProductionConfig(options: ProductionConfigOptions): void {
  if (!options.isProduction) {
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
  if (!options.requireEmailVerification()) {
    throw new Error("Unsafe production config: REQUIRE_EMAIL_VERIFICATION must not be disabled in production");
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
  requireProductionRuntimeStateProvider();
  if (options.allowBearerSessionAuth()) {
    throw new Error("Unsafe production config: bearer session auth must be disabled");
  }
  if (!envBool("SESSION_COOKIE_SECURE", false)) {
    throw new Error("Unsafe production config: SESSION_COOKIE_SECURE must be true");
  }
  requireProductionSessionCookieSameSite();
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

function requireProductionRuntimeStateProvider(): void {
  const provider = process.env.RUNTIME_STATE_PROVIDER?.trim() || "redis";
  if (provider !== "redis") {
    throw new Error("Unsafe production config: RUNTIME_STATE_PROVIDER must be redis");
  }
}

function requireProductionSessionCookieSameSite(): void {
  const sameSite = requireProductionValue("SESSION_COOKIE_SAMESITE").toLowerCase();
  if (sameSite !== "strict") {
    throw new Error("Unsafe production config: SESSION_COOKIE_SAMESITE must be Strict");
  }
}

function rejectLocalhostProductionValue(name: string): void {
  const value = requireProductionValue(name);
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value)) {
    throw new Error(`Unsafe production config: ${name} must not point at localhost`);
  }
}
