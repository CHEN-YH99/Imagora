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
