import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let apiBaseUrl = normalizeBaseUrl(process.env.API_BASE_URL ?? "http://127.0.0.1:4100");
const requests = readPositiveInt("LOAD_REQUESTS", 120);
const concurrency = readPositiveInt("LOAD_CONCURRENCY", 12);
const p95ThresholdMs = readPositiveInt("LOAD_P95_MS", 1000);
const averageThresholdMs = readPositiveInt("LOAD_AVG_MS", 500);
const failureRateMax = readRate("LOAD_FAILURE_RATE_MAX", 0);
const targets = readTargets(process.env.LOAD_TARGETS ?? "/health,/api/features");
const manageApi = readBoolean("LOAD_MANAGE_API", process.env.API_BASE_URL === undefined);
const loadTimeoutMs = readPositiveInt("LOAD_TIMEOUT_MS", 60_000);
const managedApiStorePath = process.env.LOAD_STORE_PATH
  ? resolve(process.env.LOAD_STORE_PATH)
  : resolve(tmpdir(), `imagora-load-store-${Date.now()}-${process.pid}.json`);
const managedProcesses = [];

try {
  if (manageApi) {
    await ensureApiService();
  }

  const summaries = [];
  for (const path of targets) {
    summaries.push(await runTarget(path));
  }

  const summary = {
    apiBaseUrl,
    requests,
    concurrency,
    thresholds: {
      averageMs: averageThresholdMs,
      p95Ms: p95ThresholdMs,
      failureRateMax
    },
    targets: summaries
  };

  console.log(JSON.stringify(summary, null, 2));

  if (summaries.some((item) => item.failed > 0 || !item.passed)) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopManagedProcesses();
}

async function runTarget(path) {
  let completed = 0;
  let failed = 0;
  let scheduled = 0;
  const durations = [];
  const startedAt = performance.now();
  const target = new URL(path, `${apiBaseUrl.replace(/\/$/, "")}/`).toString();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const requestIndex = scheduled;
        if (requestIndex >= requests) {
          return;
        }
        scheduled += 1;
        const started = performance.now();
        try {
          const response = await fetch(target);
          const duration = performance.now() - started;
          durations.push(duration);
          if (response.ok) {
            completed += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      }
    })
  );

  durations.sort((left, right) => left - right);
  const elapsedMs = performance.now() - startedAt;
  const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
  const failureRate = requests > 0 ? failed / requests : 1;
  const metrics = {
    path,
    target,
    completed,
    failed,
    failureRate: Number(failureRate.toFixed(4)),
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: Number((completed / Math.max(elapsedMs / 1000, 0.001)).toFixed(2)),
    averageMs: Math.round(average),
    p95Ms: Math.round(percentile(durations, 0.95)),
    p99Ms: Math.round(percentile(durations, 0.99))
  };
  return {
    ...metrics,
    passed:
      metrics.failureRate <= failureRateMax &&
      metrics.averageMs <= averageThresholdMs &&
      metrics.p95Ms <= p95ThresholdMs
  };
}

async function ensureApiService() {
  assertLocalUrl(apiBaseUrl, "API_BASE_URL");
  if (await probeApiHealth()) {
    return;
  }

  apiBaseUrl = await findAvailableBaseUrl(apiBaseUrl);
  await assertReadable(
    resolve(rootDir, "apps", "api", "dist", "main.js"),
    "API build output is missing. Run `npm run build` first."
  );

  const url = new URL(apiBaseUrl);
  const port = url.port || defaultPort(url.protocol);
  const child = spawn(process.execPath, [resolve(rootDir, "apps", "api", "dist", "main.js")], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      API_HOST: url.hostname,
      API_PORT: port,
      WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://127.0.0.1:3100",
      DATA_STORE: "json",
      IMAGORA_STORE_PATH: managedApiStorePath,
      IMAGORA_SEED_DEMO_DATA: "false",
      IMAGORA_BOOTSTRAP_ADMIN_EMAIL:
        process.env.LOAD_ADMIN_EMAIL ?? process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL ?? "admin@imagora.local",
      IMAGORA_BOOTSTRAP_ADMIN_PASSWORD:
        process.env.LOAD_ADMIN_PASSWORD ?? process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD ?? "ChangeMe123!",
      IMAGE_PROVIDER_DEFAULT: process.env.LOAD_IMAGE_PROVIDER ?? process.env.LOAD_AI_PROVIDER ?? "",
      IMAGE_MODEL_DEFAULT: process.env.LOAD_IMAGE_MODEL ?? "",
      PAYMENT_PROVIDER: process.env.LOAD_PAYMENT_PROVIDER ?? "mock",
      STORAGE_PROVIDER: process.env.LOAD_STORAGE_PROVIDER ?? "inline",
      QUEUE_PROVIDER: process.env.LOAD_QUEUE_PROVIDER ?? "inline",
      MAILER_PROVIDER: process.env.LOAD_MAILER_PROVIDER ?? "console",
      SAFETY_PROVIDER: process.env.LOAD_SAFETY_PROVIDER ?? "local",
      RATE_LIMIT_PROVIDER: process.env.LOAD_RATE_LIMIT_PROVIDER ?? "memory",
      SESSION_COOKIE_SECURE: "false"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  managedProcesses.push(trackManagedProcess("api", child));
  await waitForCondition(probeApiHealth, loadTimeoutMs, "api health");
}

async function probeApiHealth() {
  try {
    const response = await fetch(`${apiBaseUrl}/health`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return payload?.status === "ok" && payload?.service === "imagora-api";
  } catch {
    return false;
  }
}

async function findAvailableBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.hostname = normalizeManagedLocalHostname(url.hostname);
  const startPort = Number(url.port || defaultPort(url.protocol));
  for (let offset = 0; offset < 20; offset += 1) {
    const port = startPort + offset;
    if (await isPortAvailable(url.hostname, port)) {
      url.port = String(port);
      return normalizeBaseUrl(url.toString());
    }
  }
  throw new Error(`No available localhost port found near ${baseUrl}`);
}

function isPortAvailable(host, port) {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailable(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

function trackManagedProcess(name, child) {
  const stderr = [];
  const stdout = [];
  child.stdout?.on("data", (chunk) => {
    stdout.push(chunk.toString("utf8"));
    if (stdout.length > 40) {
      stdout.shift();
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 40) {
      stderr.shift();
    }
  });
  return { name, child, stdout, stderr };
}

async function waitForCondition(probe, timeoutMs, name) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) {
      return;
    }
    const crashed = managedProcesses.find((processState) => processState.child.exitCode !== null);
    if (crashed) {
      throw new Error(`${crashed.name} exited before ${name} became ready.\n${summarizeProcessOutput(crashed)}`);
    }
    await sleep(250);
  }
  const latest = managedProcesses.at(-1);
  const detail = latest ? `\n${summarizeProcessOutput(latest)}` : "";
  throw new Error(`timed out waiting for ${name}${detail}`);
}

function summarizeProcessOutput(processState) {
  const stderr = processState.stderr.join("").trim();
  const stdout = processState.stdout.join("").trim();
  if (stderr) {
    return `[${processState.name} stderr]\n${stderr}`;
  }
  if (stdout) {
    return `[${processState.name} stdout]\n${stdout}`;
  }
  return `[${processState.name}] no output captured`;
}

async function stopManagedProcesses() {
  for (const processState of [...managedProcesses].reverse()) {
    const { child } = processState;
    if (child.exitCode !== null || child.killed) {
      continue;
    }
    child.kill();
    await onceExit(child);
  }
}

async function onceExit(child) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

async function assertReadable(path, message) {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}

function assertLocalUrl(baseUrl, variableName) {
  const url = new URL(baseUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error(`${variableName} must point to localhost when LOAD_MANAGE_API=true`);
  }
}

function normalizeManagedLocalHostname(hostname) {
  return hostname === "localhost" ? "127.0.0.1" : hostname;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/$/, "");
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : "80";
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return values[index];
}

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readRate(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

function readTargets(value) {
  const paths = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("/") || item.startsWith("http") ? item : `/${item}`));
  return paths.length ? Array.from(new Set(paths)) : ["/health"];
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
