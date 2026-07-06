import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("json backup writes a manifest and restore verifies content hash", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "imagora-json-backup-"));
  const storePath = join(tempRoot, "imagora-store.json");
  const backupDir = join(tempRoot, "backups");
  const restoredPath = join(tempRoot, "restored-store.json");
  await writeFile(storePath, `${JSON.stringify({ users: [], tasks: [], images: [] }, null, 2)}\n`, "utf8");

  const backup = await runNodeScript("infra/scripts/backup-json-store.mjs", [], {
    IMAGORA_STORE_PATH: storePath,
    BACKUP_DIR: backupDir
  });
  assert.equal(backup.code, 0, backup.stderr);
  const backupSummary = JSON.parse(backup.stdout);
  await stat(backupSummary.backup);
  const manifest = JSON.parse(await readFile(backupSummary.manifest, "utf8"));
  assert.equal(manifest.sha256, backupSummary.sha256);

  const restore = await runNodeScript("infra/scripts/restore-json-store.mjs", [backupSummary.backup], {
    IMAGORA_STORE_PATH: restoredPath
  });
  assert.equal(restore.code, 0, restore.stderr);
  const restoreSummary = JSON.parse(restore.stdout);
  assert.equal(restoreSummary.sha256, backupSummary.sha256);
});

test("release drill reports external configuration gaps without printing secret values", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "imagora-release-artifacts-"));
  await mkdir(join(tempRoot, "apps/api/dist"), { recursive: true });
  await mkdir(join(tempRoot, "apps/worker/dist"), { recursive: true });
  await mkdir(join(tempRoot, "apps/web/.next"), { recursive: true });
  await writeFile(join(tempRoot, "apps/api/dist/main.js"), "", "utf8");
  await writeFile(join(tempRoot, "apps/worker/dist/main.js"), "", "utf8");
  await writeFile(join(tempRoot, "apps/web/.next/BUILD_ID"), "test-build", "utf8");

  const result = await runNodeScript("infra/scripts/release-drill.mjs", [], {
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    RELEASE_DRILL_STRICT: "0"
  });
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, true);
  assert.match(result.stdout, /production-config/);
  const productionConfig = summary.checks.find((check) => check.name === "production-config");
  assert.equal(productionConfig.status, "warn");
  assert.match(productionConfig.details.join("\n"), /SAFETY_PROVIDER must be http/);
  assert.match(productionConfig.details.join("\n"), /MAILER_PROVIDER must be smtp/);
  assert.match(productionConfig.details.join("\n"), /SAFETY_TEXT_ENDPOINT is missing or placeholder/);
  assert.match(productionConfig.details.join("\n"), /SMTP_HOST is missing or placeholder/);
  assert.doesNotMatch(result.stdout, /sk_live_|whsec_|OPENAI_API_KEY=/);
});

test("p0 readiness command fails safely on missing production providers without leaking secret values", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["p0:check"], "node infra/scripts/p0-readiness.mjs");
  assert.equal(packageJson.scripts["p0:check:strict"], "node infra/scripts/p0-readiness.mjs");

  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/p0-readiness.mjs", [], {
    ...emptyProductionEnv(),
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    DATA_STORE: "json",
    QUEUE_PROVIDER: "inline",
    STORAGE_PROVIDER: "inline",
    PAYMENT_PROVIDER: "mock",
    MAILER_PROVIDER: "console",
    SAFETY_PROVIDER: "local",
    RATE_LIMIT_PROVIDER: "memory",
    SESSION_COOKIE_SECURE: "false",
    OPENAI_API_KEY: "sk_live_should_not_print",
    STRIPE_WEBHOOK_SECRET: "whsec_should_not_print"
  });

  assert.equal(result.code, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.name, "p0-readiness");
  assert.equal(summary.passed, false);
  assert.equal(summary.strict, true);
  const releaseDrill = summary.checks.find((check) => check.name === "strict-release-drill");
  assert.equal(releaseDrill.status, "fail");
  assert.match(JSON.stringify(releaseDrill.details), /DATA_STORE must be prisma/);
  assert.match(JSON.stringify(releaseDrill.details), /SAFETY_PROVIDER must be http/);
  assert.doesNotMatch(result.stdout, /sk_live_should_not_print|whsec_should_not_print|OPENAI_API_KEY=/);
});

test("p0 readiness passes repo-owned gates with production-shaped config and keeps external smoke explicit", async () => {
  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/p0-readiness.mjs", [], {
    ...productionReadyEnv(),
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    P0_REQUIRE_EXTERNAL_SMOKE: "0"
  });

  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.name, "p0-readiness");
  assert.equal(summary.passed, true);
  const releaseDrill = summary.checks.find((check) => check.name === "strict-release-drill");
  assert.equal(releaseDrill.status, "pass");
  const externalSmoke = summary.checks.find((check) => check.name === "external-provider-smoke");
  assert.equal(externalSmoke.status, "manual");
  assert.match(externalSmoke.message, /真实 OpenAI\/S3\/Stripe\/SMTP\/Safety 联调需要灰度环境/);
  assert.deepEqual(externalSmoke.details.requiredProviders, ["openai", "s3-or-r2", "stripe", "smtp", "http-safety"]);
});

test("p0 documentation records the command and real external smoke boundary", async () => {
  const readme = await readFile("README.md", "utf8");
  const infraReadme = await readFile("infra/README.md", "utf8");

  assert.match(readme, /npm run p0:check/);
  assert.match(infraReadme, /npm run p0:check/);
  assert.match(infraReadme, /P0_REQUIRE_EXTERNAL_SMOKE=1/);
  assert.match(infraReadme, /真实 OpenAI、S3\/R2、Stripe、SMTP、第三方安全审核/);
});

async function createFakeBuildArtifacts() {
  const tempRoot = await mkdtemp(join(tmpdir(), "imagora-release-artifacts-"));
  await mkdir(join(tempRoot, "apps/api/dist"), { recursive: true });
  await mkdir(join(tempRoot, "apps/worker/dist"), { recursive: true });
  await mkdir(join(tempRoot, "apps/web/.next"), { recursive: true });
  await writeFile(join(tempRoot, "apps/api/dist/main.js"), "", "utf8");
  await writeFile(join(tempRoot, "apps/worker/dist/main.js"), "", "utf8");
  await writeFile(join(tempRoot, "apps/web/.next/BUILD_ID"), "test-build", "utf8");
  return tempRoot;
}

function emptyProductionEnv() {
  return Object.fromEntries(productionEnvNames().map((name) => [name, ""]));
}

function productionReadyEnv() {
  return {
    ...emptyProductionEnv(),
    DATA_STORE: "prisma",
    QUEUE_PROVIDER: "bullmq",
    STORAGE_PROVIDER: "s3",
    PAYMENT_PROVIDER: "stripe",
    MAILER_PROVIDER: "smtp",
    SAFETY_PROVIDER: "http",
    RATE_LIMIT_PROVIDER: "redis",
    SESSION_COOKIE_SECURE: "true",
    IMAGE_PROVIDER_DEFAULT: "openai",
    IMAGE_MODEL_DEFAULT: "openai:gpt-image-2",
    WEB_ORIGIN: "https://imagora.example",
    S3_PUBLIC_BASE_URL: "https://cdn.imagora.example",
    STRIPE_SUCCESS_URL: "https://imagora.example/orders?paid=1",
    STRIPE_CANCEL_URL: "https://imagora.example/pricing?canceled=1",
    SAFETY_TEXT_ENDPOINT: "https://safety.imagora.example/text",
    SAFETY_IMAGE_ENDPOINT: "https://safety.imagora.example/image",
    SMTP_HOST: "smtp.imagora.example",
    SMTP_USER: "imagora-mailer",
    SMTP_PASSWORD: "smtp-production-secret",
    SMTP_FROM: "noreply@imagora.example",
    DATABASE_URL: "postgresql://imagora:secret@db.imagora.example:5432/imagora",
    REDIS_URL: "redis://redis.imagora.example:6379",
    OPENAI_API_KEY: "sk-live-production-shaped",
    S3_ENDPOINT: "https://r2.imagora.example",
    S3_BUCKET: "imagora-prod",
    S3_ACCESS_KEY_ID: "r2-access-key",
    S3_SECRET_ACCESS_KEY: "r2-secret-key",
    STRIPE_SECRET_KEY: "sk_live_production_shaped",
    STRIPE_WEBHOOK_SECRET: "whsec_production_shaped",
    ALERT_WEBHOOK_URL: "https://alerts.imagora.example/webhook"
  };
}

function productionEnvNames() {
  return [
    "DATA_STORE",
    "QUEUE_PROVIDER",
    "STORAGE_PROVIDER",
    "PAYMENT_PROVIDER",
    "MAILER_PROVIDER",
    "SAFETY_PROVIDER",
    "RATE_LIMIT_PROVIDER",
    "SESSION_COOKIE_SECURE",
    "IMAGE_PROVIDER_DEFAULT",
    "AI_PROVIDER",
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
    "DATABASE_URL",
    "REDIS_URL",
    "OPENAI_API_KEY",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "ALERT_WEBHOOK_URL",
    "ALERT_EMAIL_TO"
  ];
}

function runNodeScript(script, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
