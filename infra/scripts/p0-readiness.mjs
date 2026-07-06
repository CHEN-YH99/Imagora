import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const checks = [];

checks.push(await runStrictReleaseDrill());
checks.push(checkExternalProviderSmoke());

const summary = {
  name: "p0-readiness",
  strict: true,
  passed: checks.every((check) => check.status !== "fail"),
  checks
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.passed) {
  process.exitCode = 1;
}

async function runStrictReleaseDrill() {
  const result = await runNodeScript("infra/scripts/release-drill.mjs", {
    ...process.env,
    RELEASE_DRILL_STRICT: "1"
  });
  const releaseSummary = parseJsonSummary(result.stdout);

  if (!releaseSummary) {
    return {
      name: "strict-release-drill",
      status: "fail",
      message: "严格发布演练没有返回可解析的 JSON 摘要。",
      details: {
        exitCode: result.code,
        stderr: result.stderr ? "release-drill wrote stderr; inspect local command output" : ""
      }
    };
  }

  return {
    name: "strict-release-drill",
    status: result.code === 0 && releaseSummary.passed ? "pass" : "fail",
    message:
      result.code === 0 && releaseSummary.passed
        ? "生产配置、构建产物、备份恢复与灰度清单通过严格演练。"
        : "严格发布演练未通过，不能进入 P0。",
    details: releaseSummary.checks
  };
}

function checkExternalProviderSmoke() {
  const requiredProviders = ["openai", "s3-or-r2", "stripe", "smtp", "http-safety"];
  const requireExternalSmoke = booleanEnv("P0_REQUIRE_EXTERNAL_SMOKE", false);
  const externalSmokePassed = booleanEnv("P0_EXTERNAL_SMOKE_PASSED", false);
  const evidence = process.env.P0_EXTERNAL_SMOKE_EVIDENCE?.trim() ?? "";
  const hasEvidence = evidence.length > 0 && !isPlaceholder(evidence);

  if (requireExternalSmoke && (!externalSmokePassed || !hasEvidence)) {
    return {
      name: "external-provider-smoke",
      status: "fail",
      message: "真实 OpenAI/S3/Stripe/SMTP/Safety 联调尚未提供验收证据。",
      details: {
        requiredProviders,
        requiredEvidence:
          "Set P0_EXTERNAL_SMOKE_PASSED=1 and P0_EXTERNAL_SMOKE_EVIDENCE to the gray-release run id or URL.",
        commands: externalSmokeCommands()
      }
    };
  }

  if (requireExternalSmoke) {
    return {
      name: "external-provider-smoke",
      status: "pass",
      message: "真实外部 Provider smoke 已由环境证据显式确认。",
      details: {
        requiredProviders,
        evidence: "provided"
      }
    };
  }

  return {
    name: "external-provider-smoke",
    status: "manual",
    message: "真实 OpenAI/S3/Stripe/SMTP/Safety 联调需要灰度环境和外部账号；本地 P0 只确认仓库内门禁。",
    details: {
      requiredProviders,
      commands: externalSmokeCommands()
    }
  };
}

function externalSmokeCommands() {
  return [
    "API_BASE_URL=https://<gray-api> WEB_BASE_URL=https://<gray-web> SMOKE_MANAGE_SERVICES=0 npm run smoke",
    "API_BASE_URL=https://<gray-api> LOAD_MANAGE_API=0 LOAD_FAILURE_RATE_MAX=0 npm run load:smoke",
    "P0_REQUIRE_EXTERNAL_SMOKE=1 P0_EXTERNAL_SMOKE_PASSED=1 P0_EXTERNAL_SMOKE_EVIDENCE=<run-id-or-url> npm run p0:check"
  ];
}

function runNodeScript(script, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script], {
      cwd: rootDir,
      env,
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
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonSummary(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

function isPlaceholder(value) {
  return /^(changeme|todo|example|mock|test|placeholder|\.\.\.)$/i.test(value.trim());
}
