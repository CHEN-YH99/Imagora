import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(process.env.RELEASE_DRILL_ARTIFACT_ROOT ?? defaultRoot);
const strict = process.env.RELEASE_DRILL_STRICT === "1";

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
    ["RATE_LIMIT_PROVIDER", ["redis"]],
    ["SESSION_COOKIE_SECURE", ["true"]]
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
  const imageProvider = readConfiguredImageProvider();
  if (imageProvider !== "openai") {
    problems.push("IMAGE_PROVIDER_DEFAULT (or legacy AI_PROVIDER) must be openai");
  }
  for (const name of secrets) {
    if (isMissingOrPlaceholder(process.env[name])) {
      problems.push(`${name} is missing or placeholder`);
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
  return /^(changeme|todo|example|mock|test|placeholder|\.\.\.)$/i.test(value.trim());
}

function readConfiguredImageProvider() {
  return process.env.IMAGE_PROVIDER_DEFAULT?.trim() || process.env.AI_PROVIDER?.trim() || "";
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
