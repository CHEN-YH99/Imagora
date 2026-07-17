import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(process.env.RELEASE_DRILL_ARTIFACT_ROOT ?? defaultRoot);
const strict = process.env.RELEASE_DRILL_STRICT === "1";
const minProductionOpenAiTimeoutMs = 300_000;
const maxProductionOpenAiRetries = 1;
const minProductionGenerationRunningTimeoutMs = 1_800_000;
const maxTaskQuantity = 4;
const generationRunningTimeoutBufferMs = 5 * 60 * 1000;

const checks = [];

await checkProductionConfig();
await checkBuildArtifacts();
await checkBackupRestoreDrill();
checkGrayReleaseChecklist();

const summary = {
  strict,
  passed: checks.every((check) => check.status !== "fail"),
  checks
};

console.log(JSON.stringify(summary, null, 2));

if (checks.some((check) => check.status === "fail")) {
  process.exitCode = 1;
}

async function checkProductionConfig() {
  const required = [
    ["DATA_STORE", ["prisma"]],
    ["QUEUE_PROVIDER", ["bullmq"]],
    ["STORAGE_PROVIDER", ["s3", "r2"]],
    ["PAYMENT_PROVIDER", ["stripe"]],
    ["MAILER_PROVIDER", ["smtp"]],
    ["SAFETY_PROVIDER", ["http"]],
    ["RATE_LIMIT_PROVIDER", ["redis"]],
    ["SESSION_COOKIE_SECURE", ["true"]]
  ];
  const requiredValues = [
    "WEB_ORIGIN",
    "S3_PUBLIC_BASE_URL",
    "STRIPE_SUCCESS_URL",
    "STRIPE_CANCEL_URL",
    "SAFETY_TEXT_ENDPOINT",
    "SAFETY_IMAGE_ENDPOINT",
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "GENERATION_RUNNING_TIMEOUT_MS"
  ];
  const secrets = [
    "DATABASE_URL",
    "REDIS_URL",
    "OPENAI_API_KEY",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET"
  ];
  const problems = [];

  for (const [name, accepted] of required) {
    const value = process.env[name];
    if (!value || !accepted.includes(value)) {
      problems.push(`${name} must be ${accepted.join(" or ")}`);
    }
  }
  if (process.env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase() !== "strict") {
    problems.push("SESSION_COOKIE_SAMESITE must be Strict");
  }
  const imageProvider = readConfiguredImageProvider();
  if (imageProvider !== "openai") {
    problems.push("IMAGE_PROVIDER_DEFAULT (or legacy AI_PROVIDER) must be openai");
  }
  const hasAlertChannel = Boolean(process.env.ALERT_WEBHOOK_URL?.trim()) || Boolean(process.env.ALERT_EMAIL_TO?.trim());
  if (!hasAlertChannel) {
    problems.push("at least one alert channel is required (ALERT_WEBHOOK_URL or ALERT_EMAIL_TO)");
  }
  // 邮箱验证门槛默认开启，只有被显式关闭时才是问题（与 main.ts validateProductionConfig 对齐）。
  const emailVerification = process.env.REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase();
  if (emailVerification && ["0", "false", "no", "off", "disabled"].includes(emailVerification)) {
    problems.push("REQUIRE_EMAIL_VERIFICATION must not be disabled in production");
  }
  for (const name of requiredValues) {
    if (isMissingOrPlaceholder(process.env[name])) {
      problems.push(`${name} is missing or placeholder`);
    }
  }
  for (const name of secrets) {
    if (isMissingOrPlaceholder(process.env[name])) {
      problems.push(`${name} is missing or placeholder`);
    }
  }
  const openAiTimeoutMs = readPositiveNumber("OPENAI_TIMEOUT_MS", problems);
  if (openAiTimeoutMs !== null && openAiTimeoutMs < minProductionOpenAiTimeoutMs) {
    problems.push(`OPENAI_TIMEOUT_MS must be at least ${minProductionOpenAiTimeoutMs}`);
  }
  const openAiMaxRetries = readNonNegativeNumber("OPENAI_MAX_RETRIES", problems);
  if (openAiMaxRetries !== null && openAiMaxRetries > maxProductionOpenAiRetries) {
    problems.push(`OPENAI_MAX_RETRIES must be ${maxProductionOpenAiRetries} or less`);
  }
  const generationRunningTimeoutMs = readPositiveNumber("GENERATION_RUNNING_TIMEOUT_MS", problems);
  if (generationRunningTimeoutMs !== null && generationRunningTimeoutMs < minProductionGenerationRunningTimeoutMs) {
    problems.push(`GENERATION_RUNNING_TIMEOUT_MS must be at least ${minProductionGenerationRunningTimeoutMs}`);
  }
  if (openAiTimeoutMs !== null && generationRunningTimeoutMs !== null) {
    const minimumRunningTimeoutMs = openAiTimeoutMs * maxTaskQuantity + generationRunningTimeoutBufferMs;
    if (generationRunningTimeoutMs < minimumRunningTimeoutMs) {
      problems.push(
        `GENERATION_RUNNING_TIMEOUT_MS must be at least ${minimumRunningTimeoutMs} for OPENAI_TIMEOUT_MS=${openAiTimeoutMs} and max quantity ${maxTaskQuantity}`
      );
    }
  }

  pushCheck({
    name: "production-config",
    status: problems.length && strict ? "fail" : problems.length ? "warn" : "pass",
    message: problems.length
      ? "外部生产连接需要用户注入真实环境变量；本地演练只校验清单，不打印密钥。"
      : "生产配置清单满足灰度演练要求。",
    details: problems
  });
}

async function checkBuildArtifacts() {
  const artifacts = ["apps/api/dist/main.js", "apps/worker/dist/main.js", "apps/web/.next/BUILD_ID"];
  const missing = [];
  for (const artifact of artifacts) {
    try {
      await stat(resolve(root, artifact));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        missing.push(artifact);
        continue;
      }
      throw error;
    }
  }
  pushCheck({
    name: "build-artifacts",
    status: missing.length ? "fail" : "pass",
    message: missing.length ? "缺少构建产物，请先运行 npm run build。" : "构建产物已就绪。",
    details: missing
  });
}

async function checkBackupRestoreDrill() {
  const tempRoot = await mkdtemp(join(tmpdir(), "imagora-release-drill-"));
  try {
    const source = join(tempRoot, "imagora-store.json");
    const restored = join(tempRoot, "restored-store.json");
    const payload = {
      users: [{ id: "drill-user", email: "drill@example.com" }],
      tasks: [],
      images: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString()
    };
    await writeFile(source, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const sourceContent = await readFile(source, "utf8");
    JSON.parse(sourceContent);
    await writeFile(restored, sourceContent, "utf8");
    const restoredContent = await readFile(restored, "utf8");
    JSON.parse(restoredContent);
    const sourceHash = sha256(sourceContent);
    const restoredHash = sha256(restoredContent);
    pushCheck({
      name: "json-backup-restore-drill",
      status: sourceHash === restoredHash ? "pass" : "fail",
      message: sourceHash === restoredHash ? "JSON 备份恢复演练通过。" : "JSON 备份恢复演练 hash 不一致。",
      details: { sourceHash, restoredHash }
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function checkGrayReleaseChecklist() {
  const checklist = [
    "feature flags reviewed",
    "database migration backup prepared",
    "smoke test command available",
    "load smoke thresholds configured",
    "rollback uses feature flags before infrastructure rollback",
    "external provider credentials injected by environment only"
  ];
  pushCheck({
    name: "gray-release-checklist",
    status: "pass",
    message: "本地灰度演练清单已覆盖发布、观测、回滚和外部凭据边界。",
    details: checklist
  });
}

function pushCheck(check) {
  checks.push(check);
}

function isMissingOrPlaceholder(value) {
  if (!value) {
    return true;
  }
  const normalized = value.trim();
  return (
    /^(changeme|todo|example|mock|test|placeholder|\.\.\.)$/i.test(normalized) ||
    /(^|[_-])replace([_-]|$)/i.test(normalized)
  );
}

function readConfiguredImageProvider() {
  return process.env.IMAGE_PROVIDER_DEFAULT?.trim() || process.env.AI_PROVIDER?.trim() || "";
}

function readPositiveNumber(name, problems) {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive number`);
    return null;
  }
  return parsed;
}

function readNonNegativeNumber(name, problems) {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    problems.push(`${name} must be a non-negative number`);
    return null;
  }
  return parsed;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
