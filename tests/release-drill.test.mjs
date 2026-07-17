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

test("postgres backup and restore scripts wrap pg_dump with manifest verification", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "imagora-postgres-backup-"));
  const backupDir = join(tempRoot, "backups");
  const fakeDumpBin = await writeFakePgDump(tempRoot);
  const fakeRestoreBin = await writeFakePgRestore(tempRoot);
  const restoreMarker = join(tempRoot, "restore-marker.json");

  const backup = await runNodeScript("infra/scripts/backup-postgres.mjs", [], {
    DATABASE_URL: "postgresql://imagora:secret@127.0.0.1:5432/imagora",
    POSTGRES_BACKUP_DIR: backupDir,
    PG_DUMP_BIN: fakeDumpBin
  });
  assert.equal(backup.code, 0, backup.stderr);
  assert.doesNotMatch(backup.stdout, /secret/);
  const backupSummary = JSON.parse(backup.stdout);
  await stat(backupSummary.backup);
  const manifest = JSON.parse(await readFile(backupSummary.manifest, "utf8"));
  assert.equal(manifest.sha256, backupSummary.sha256);
  assert.equal(manifest.database, "postgresql://imagora:[redacted]@127.0.0.1:5432/imagora");

  const restore = await runNodeScript("infra/scripts/restore-postgres.mjs", [backupSummary.backup], {
    DATABASE_URL: "postgresql://imagora:secret@127.0.0.1:5432/imagora",
    PG_RESTORE_BIN: fakeRestoreBin,
    PG_RESTORE_MARKER: restoreMarker
  });
  assert.equal(restore.code, 0, restore.stderr);
  assert.doesNotMatch(restore.stdout, /secret/);
  const restoreSummary = JSON.parse(restore.stdout);
  const marker = JSON.parse(await readFile(restoreMarker, "utf8"));
  assert.equal(restoreSummary.sha256, backupSummary.sha256);
  assert.ok(marker.args.includes("--clean"));
  assert.ok(marker.args.includes("--if-exists"));

  await writeFile(backupSummary.backup, "tampered-postgres-dump\n", "utf8");
  const tamperedRestore = await runNodeScript("infra/scripts/restore-postgres.mjs", [backupSummary.backup], {
    DATABASE_URL: "postgresql://imagora:secret@127.0.0.1:5432/imagora",
    PG_RESTORE_BIN: fakeRestoreBin,
    PG_RESTORE_MARKER: restoreMarker
  });
  assert.equal(tamperedRestore.code, 1);
  assert.match(tamperedRestore.stderr, /manifest sha256 mismatch/);
  assert.doesNotMatch(tamperedRestore.stderr, /secret/);

  const orphanBackup = join(tempRoot, "orphan.dump");
  await writeFile(orphanBackup, "orphan-postgres-dump\n", "utf8");
  const missingManifestRestore = await runNodeScript("infra/scripts/restore-postgres.mjs", [orphanBackup], {
    DATABASE_URL: "postgresql://imagora:secret@127.0.0.1:5432/imagora",
    PG_RESTORE_BIN: fakeRestoreBin,
    PG_RESTORE_MARKER: restoreMarker
  });
  assert.equal(missingManifestRestore.code, 1);
  assert.match(missingManifestRestore.stderr, /manifest missing/);
  assert.doesNotMatch(missingManifestRestore.stderr, /secret/);
});

test("production worker drains active generation jobs before shutdown", async () => {
  const compose = await readFile("infra/docker-compose.prod.yml", "utf8");
  const workerBlock = compose.match(/\n {2}worker:\n(?<body>[\s\S]*?)(?:\n {2}web:|\nvolumes:)/)?.groups?.body ?? "";
  const workerSource = await readFile("apps/worker/src/main.ts", "utf8");
  const supervisorSource = await readFile("infra/scripts/worker-supervisor.mjs", "utf8");

  assert.match(workerBlock, /restart:\s*unless-stopped/);
  assert.match(workerBlock, /healthcheck:/);
  assert.match(workerBlock, /node/);
  assert.match(workerBlock, /worker-supervisor\.mjs/);
  assert.match(workerBlock, /stop_grace_period:\s*\$\{WORKER_STOP_GRACE_PERIOD:-32m\}/);
  assert.match(workerBlock, /WORKER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS:\s*\$\{[^}]*:-1860000\}/);

  assert.match(workerSource, /process\.on\("SIGINT"/);
  assert.match(workerSource, /process\.on\("SIGTERM"/);
  assert.match(workerSource, /await activeWorker\.close\(\)/);
  assert.match(workerSource, /await activeTick/);
  assert.match(workerSource, /clearInterval\(inlineTimer\)/);

  assert.match(supervisorSource, /WORKER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS/);
  assert.match(supervisorSource, /child\.kill\(signal === "SIGINT" \? "SIGINT" : "SIGTERM"\)/);
  assert.match(supervisorSource, /finishShutdown\(\)/);
  assert.doesNotMatch(supervisorSource, /}, 3_000\)/);
});

test("worker shutdown is idempotent and waits for active work", async () => {
  const { createWorkerShutdownController } = await import("../apps/worker/dist/shutdown-runtime.js");
  const events = [];
  let releaseActiveWork;
  const activeWork = new Promise((resolve) => {
    releaseActiveWork = resolve;
  });
  const controller = createWorkerShutdownController({
    stopAcceptingWork() {
      events.push("stop-accepting");
    },
    async closeGenerationWorker() {
      events.push("close-queue-worker");
    },
    async waitForInlineWork() {
      events.push("wait-active-work");
      await activeWork;
    },
    onStarted(signal) {
      events.push(`started:${signal}`);
    },
    onCompleted(signal) {
      events.push(`completed:${signal}`);
    },
    onFailed(error, signal) {
      events.push(`failed:${signal}:${String(error)}`);
    }
  });

  const firstShutdown = controller.shutdown("SIGTERM");
  const repeatedShutdown = controller.shutdown("SIGINT");
  assert.strictEqual(repeatedShutdown, firstShutdown);
  assert.equal(controller.isShuttingDown(), true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events, ["stop-accepting", "started:SIGTERM", "close-queue-worker", "wait-active-work"]);

  releaseActiveWork();
  await firstShutdown;
  assert.deepEqual(events, [
    "stop-accepting",
    "started:SIGTERM",
    "close-queue-worker",
    "wait-active-work",
    "completed:SIGTERM"
  ]);
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

test("release drill treats replacement placeholders as missing production secrets", async () => {
  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/release-drill.mjs", [], {
    ...productionReadyEnv(),
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    RELEASE_DRILL_STRICT: "1",
    OPENAI_API_KEY: "sk-live-replace-this",
    S3_ACCESS_KEY_ID: "replace-r2-access-key",
    STRIPE_WEBHOOK_SECRET: "whsec_replace_this"
  });

  assert.equal(result.code, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  const productionConfig = summary.checks.find((check) => check.name === "production-config");
  assert.equal(productionConfig.status, "fail");
  assert.match(productionConfig.details.join("\n"), /OPENAI_API_KEY is missing or placeholder/);
  assert.match(productionConfig.details.join("\n"), /S3_ACCESS_KEY_ID is missing or placeholder/);
  assert.match(productionConfig.details.join("\n"), /STRIPE_WEBHOOK_SECRET is missing or placeholder/);
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

test("p0 external readiness script requires gray-release smoke evidence", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    packageJson.scripts["p0:check:external"],
    "node infra/scripts/p0-readiness.mjs --require-external-smoke"
  );

  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/p0-readiness.mjs", ["--require-external-smoke"], {
    ...productionReadyEnv(),
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    P0_EXTERNAL_SMOKE_PASSED: "0",
    P0_EXTERNAL_SMOKE_EVIDENCE: ""
  });

  assert.equal(result.code, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, false);
  const externalSmoke = summary.checks.find((check) => check.name === "external-provider-smoke");
  assert.equal(externalSmoke.status, "fail");
  assert.match(externalSmoke.message, /真实 OpenAI\/S3\/Stripe\/SMTP\/Safety 联调尚未提供验收证据/);
});

test("release drill flags production config that explicitly disables email verification", async () => {
  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/release-drill.mjs", [], {
    ...productionReadyEnv(),
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    RELEASE_DRILL_STRICT: "1",
    REQUIRE_EMAIL_VERIFICATION: "false"
  });

  assert.equal(result.code, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  const productionConfig = summary.checks.find((check) => check.name === "production-config");
  assert.equal(productionConfig.status, "fail");
  assert.match(productionConfig.details.join("\n"), /REQUIRE_EMAIL_VERIFICATION must not be disabled in production/);
});

test("release drill accepts production config that leaves email verification at its default", async () => {
  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/release-drill.mjs", [], {
    ...productionReadyEnv(),
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    RELEASE_DRILL_STRICT: "1"
  });

  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const productionConfig = summary.checks.find((check) => check.name === "production-config");
  assert.equal(productionConfig.status, "pass");
  assert.doesNotMatch(productionConfig.details.join("\n"), /REQUIRE_EMAIL_VERIFICATION/);
});

test("release drill accepts case-insensitive Strict SameSite configuration", async () => {
  const tempRoot = await createFakeBuildArtifacts();
  const result = await runNodeScript("infra/scripts/release-drill.mjs", [], {
    ...productionReadyEnv(),
    SESSION_COOKIE_SAMESITE: "strict",
    RELEASE_DRILL_ARTIFACT_ROOT: tempRoot,
    RELEASE_DRILL_STRICT: "1"
  });

  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const productionConfig = summary.checks.find((check) => check.name === "production-config");
  assert.equal(productionConfig.status, "pass");
});

test("production env template documents P0 provider defaults without development fallbacks", async () => {
  const template = await readFile(".env.production.example", "utf8");
  const gitignore = await readFile(".gitignore", "utf8");
  const values = parseEnvTemplate(template);

  assert.equal(values.DATA_STORE, "prisma");
  assert.equal(values.QUEUE_PROVIDER, "bullmq");
  assert.match(values.STORAGE_PROVIDER, /^(s3|r2)$/);
  assert.equal(values.PAYMENT_PROVIDER, "stripe");
  assert.equal(values.MAILER_PROVIDER, "smtp");
  assert.equal(values.SAFETY_PROVIDER, "http");
  assert.equal(values.RATE_LIMIT_PROVIDER, "redis");
  assert.equal(values.SESSION_COOKIE_SECURE, "true");
  assert.equal(values.SESSION_COOKIE_SAMESITE, "Strict");
  assert.equal(values.IMAGE_PROVIDER_DEFAULT, "openai");
  assert.equal(values.OPENAI_TIMEOUT_MS, "300000");
  assert.equal(values.OPENAI_MAX_RETRIES, "1");
  assert.equal(values.GENERATION_RUNNING_TIMEOUT_MS, "1800000");
  assert.equal(values.WORKER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS, "1860000");
  assert.equal(values.WORKER_STOP_GRACE_PERIOD, "32m");
  assert.ok(values.ALERT_WEBHOOK_URL || values.ALERT_EMAIL_TO);

  for (const name of productionEnvNames()) {
    assert.ok(Object.hasOwn(values, name), `${name} is missing from .env.production.example`);
  }

  const forbiddenDevelopmentDefaults = [
    /^QUEUE_PROVIDER=inline$/m,
    /^STORAGE_PROVIDER=inline$/m,
    /^PAYMENT_PROVIDER=mock$/m,
    /^MAILER_PROVIDER=console$/m,
    /^SAFETY_PROVIDER=local$/m,
    /^RATE_LIMIT_PROVIDER=memory$/m,
    /^SESSION_COOKIE_SECURE=false$/m,
    /^SESSION_COOKIE_SAMESITE=(?:Lax|None)$/m
  ];
  for (const pattern of forbiddenDevelopmentDefaults) {
    assert.doesNotMatch(template, pattern);
  }

  assert.match(gitignore, /^\.env\.production$/m);
});

test("p2 runtime Dockerfiles install production dependencies without copying builder dev node_modules", async () => {
  const dockerfiles = [
    { path: "infra/Dockerfile.api", workspace: "apps/api" },
    { path: "infra/Dockerfile.worker", workspace: "apps/worker" },
    { path: "infra/Dockerfile.web", workspace: "apps/web" }
  ];

  for (const dockerfile of dockerfiles) {
    const content = await readFile(dockerfile.path, "utf8");
    assert.doesNotMatch(content, /COPY --from=builder \/app\/node_modules \.\/node_modules/);
    assert.match(content, new RegExp(`npm ci --omit=dev --workspace ${escapeRegExp(dockerfile.workspace)}`));
    assert.match(content, /ARG NPM_REGISTRY=https:\/\/registry\.npmmirror\.com/);
  }

  const databasePackage = JSON.parse(await readFile("packages/database/package.json", "utf8"));
  assert.ok(databasePackage.dependencies.prisma, "Prisma CLI is required by the production migration container");
  assert.equal(databasePackage.devDependencies.prisma, undefined);
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
    SESSION_COOKIE_SAMESITE: "Strict",
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
    OPENAI_TIMEOUT_MS: "300000",
    OPENAI_MAX_RETRIES: "1",
    S3_ENDPOINT: "https://r2.imagora.example",
    S3_BUCKET: "imagora-prod",
    S3_ACCESS_KEY_ID: "r2-access-key",
    S3_SECRET_ACCESS_KEY: "r2-secret-key",
    STRIPE_SECRET_KEY: "sk_live_production_shaped",
    STRIPE_WEBHOOK_SECRET: "whsec_production_shaped",
    ALERT_WEBHOOK_URL: "https://alerts.imagora.example/webhook",
    GENERATION_RUNNING_TIMEOUT_MS: "1800000"
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
    "SESSION_COOKIE_SAMESITE",
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
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "ALERT_WEBHOOK_URL",
    "GENERATION_RUNNING_TIMEOUT_MS",
    "ALERT_EMAIL_TO"
  ];
}

function parseEnvTemplate(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    values[name] = value;
  }
  return values;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeFakePgDump(tempRoot) {
  const script = join(tempRoot, "fake-pg-dump.mjs");
  await writeFile(
    script,
    [
      "import { writeFile } from 'node:fs/promises';",
      "const fileArg = process.argv.find((arg) => arg.startsWith('--file='));",
      "if (!fileArg) process.exit(2);",
      "await writeFile(fileArg.slice('--file='.length), 'fake-postgres-dump\\n', 'utf8');"
    ].join("\n"),
    "utf8"
  );
  return writeNodeCommand(tempRoot, "pg_dump", script);
}

async function writeFakePgRestore(tempRoot) {
  const script = join(tempRoot, "fake-pg-restore.mjs");
  await writeFile(
    script,
    [
      "import { writeFile } from 'node:fs/promises';",
      "const marker = process.env.PG_RESTORE_MARKER;",
      "if (!marker) process.exit(2);",
      "await writeFile(marker, JSON.stringify({ args: process.argv.slice(2) }), 'utf8');"
    ].join("\n"),
    "utf8"
  );
  return writeNodeCommand(tempRoot, "pg_restore", script);
}

async function writeNodeCommand(tempRoot, name, script) {
  if (process.platform === "win32") {
    const command = join(tempRoot, `${name}.cmd`);
    await writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return command;
  }
  const command = join(tempRoot, name);
  await writeFile(command, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return command;
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
