import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let apiBaseUrl = normalizeBaseUrl(process.env.API_BASE_URL ?? "http://127.0.0.1:4100");
let webBaseUrl = normalizeBaseUrl(process.env.WEB_BASE_URL ?? "http://127.0.0.1:3100");
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL ?? "admin@imagora.local";
const adminPassword =
  process.env.SMOKE_ADMIN_PASSWORD ?? process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD ?? "ChangeMe123!";
const smokeTimeoutMs = numberEnv("SMOKE_TIMEOUT_MS", 60_000);
const manageServices = booleanEnv("SMOKE_MANAGE_SERVICES", true);
const reuseRunningServices = booleanEnv("SMOKE_REUSE_RUNNING_SERVICES", false);
const managedApiStorePath = process.env.SMOKE_STORE_PATH
  ? resolve(process.env.SMOKE_STORE_PATH)
  : resolve(tmpdir(), `imagora-smoke-store-${Date.now()}-${process.pid}.json`);
const captchaColumns = 4;
const captchaRows = 3;
const captchaTiles = captchaColumns * captchaRows;
const managedProcesses = [];

const captchaSignatures = new Map(
  [
    ["奶牛", { fill: "#f8fafc", accent: "#0f172a" }],
    ["鸭子", { fill: "#fef3c7", accent: "#f59e0b" }],
    ["熊猫", { fill: "#f8fafc", accent: "#111827" }],
    ["兔子", { fill: "#ffe4e6", accent: "#fb7185" }],
    ["狐狸", { fill: "#ffedd5", accent: "#f97316" }],
    ["海豹", { fill: "#e0f2fe", accent: "#0284c7" }],
    ["猫", { fill: "#fef9c3", accent: "#ca8a04" }],
    ["狗", { fill: "#f5e8d8", accent: "#92400e" }],
    ["猫头鹰", { fill: "#ede9fe", accent: "#7c3aed" }],
    ["乌龟", { fill: "#dcfce7", accent: "#16a34a" }],
    ["绵羊", { fill: "#f8fafc", accent: "#64748b" }],
    ["松鼠", { fill: "#fed7aa", accent: "#ea580c" }]
  ].map(([label, signature]) => [label, normalizeSignature(signature)])
);

const checks = [
  ["api health", checkApiHealth],
  ["feature flags", checkFeatureFlags],
  ["admin metrics", checkAdminMetrics],
  ["web home", checkWebHome]
];

try {
  if (manageServices) {
    await ensureLocalServices();
  }

  for (const [name, check] of checks) {
    try {
      await check();
      console.log(`[smoke] ok ${name}`);
    } catch (error) {
      console.error(`[smoke] failed ${name}`);
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await stopManagedProcesses();
}

async function checkApiHealth() {
  const health = await getJson(`${apiBaseUrl}/health`);
  assertEqual(health.status, "ok", "health status should be ok");
  assertEqual(health.service, "imagora-api", "health service should be imagora-api");
}

async function checkFeatureFlags() {
  const envelope = await getJson(`${apiBaseUrl}/api/features`);
  assertTruthy(envelope.data?.features, "features payload is missing");
}

async function checkAdminMetrics() {
  const sessionCookie = await loginAdmin();
  const metrics = await getJson(`${apiBaseUrl}/api/admin/metrics`, {
    headers: { Cookie: sessionCookie }
  });
  assertTruthy(metrics.data?.service, "service metrics are missing");
  assertTruthy(metrics.data?.http, "http metrics are missing");
  assertTruthy(metrics.data?.domain, "domain metrics are missing");
  assertTruthy(Array.isArray(metrics.data?.alerts), "alerts array is missing");
}

async function checkWebHome() {
  const response = await fetch(webBaseUrl);
  if (!response.ok) {
    throw new Error(`web returned ${response.status}`);
  }
  const html = await response.text();
  assertTruthy(html.includes("Imagora"), "web home did not include product name");
}

async function loginAdmin() {
  const verificationIds = [];
  for (let round = 0; round < 2; round += 1) {
    const captcha = await getJson(`${apiBaseUrl}/api/auth/captcha`);
    const selections = solveCaptcha(captcha.data);
    const verification = await postJson(`${apiBaseUrl}/api/auth/captcha/verify`, {
      captchaId: captcha.data?.captchaId,
      captchaSelections: selections
    });
    assertTruthy(verification.data?.verificationId, "captcha verification id is missing");
    verificationIds.push(verification.data.verificationId);
  }

  const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      captchaVerificationIds: verificationIds
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`/api/auth/login returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  assertTruthy(payload.data?.user, "admin login user payload is missing");
  const setCookie = readSetCookie(response);
  assertTruthy(setCookie, "admin session cookie is missing");
  return setCookie.split(";")[0];
}

function solveCaptcha(captcha) {
  assertTruthy(captcha?.captchaId, "captcha id is missing");
  if (Array.isArray(captcha?.answer) && captcha.answer.length > 0) {
    return captcha.answer;
  }

  const targetLabel = readTargetLabel(captcha);
  const signature = captchaSignatures.get(targetLabel);
  if (!signature) {
    throw new Error(`unsupported captcha target: ${targetLabel}`);
  }

  const svg = String(captcha.imageSvg ?? "");
  const tileGroups = [
    ...svg.matchAll(
      /<g><rect\b[^>]*fill="([^"]+)"[^>]*\/>(.*?)<circle\b[^>]*r="2"\s+fill="(?:#dbeafe|#ccfbf1)"\/><\/g>/gs
    )
  ];
  assertEqual(tileGroups.length, captchaTiles, `captcha tile count should be ${captchaTiles}`);

  const selections = tileGroups.flatMap((match, index) => {
    const fill = normalizeColor(match[1]);
    const innerSvg = normalizeColor(match[2] ?? "");
    const isMatch = fill === signature.fill && innerSvg.includes(signature.accent);
    return isMatch ? [selectionFromIndex(index)] : [];
  });

  assertEqual(
    selections.length,
    Number(captcha.requiredSelections),
    `captcha selections should match required count for ${targetLabel}`
  );
  return selections;
}

function readTargetLabel(captcha) {
  if (typeof captcha?.targetLabel === "string" && captcha.targetLabel.length > 0) {
    return captcha.targetLabel;
  }
  if (typeof captcha?.instruction === "string") {
    const match = captcha.instruction.match(/请点击图中所有(.+)$/);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error("captcha target label is missing");
}

function selectionFromIndex(index) {
  return {
    x: ((index % captchaColumns) + 0.5) / captchaColumns,
    y: (Math.floor(index / captchaColumns) + 0.5) / captchaRows
  };
}

function normalizeSignature(signature) {
  return {
    fill: normalizeColor(signature.fill),
    accent: normalizeColor(signature.accent)
  };
}

function normalizeColor(value) {
  return String(value).trim().toLowerCase();
}

async function ensureLocalServices() {
  apiBaseUrl = await prepareManagedServiceUrl(apiBaseUrl, "API_BASE_URL", probeApiHealthAt);
  webBaseUrl = await prepareManagedServiceUrl(webBaseUrl, "WEB_BASE_URL", probeWebHomeAt);
  await ensureApiService();
  await ensureWebService();
}

async function ensureApiService() {
  if (reuseRunningServices && (await probeApiHealth())) {
    return;
  }
  assertLocalUrl(apiBaseUrl, "API_BASE_URL");
  await assertReadable(
    resolve(rootDir, "apps", "api", "dist", "main.js"),
    "API build output is missing. Run `npm run build` first."
  );

  const url = new URL(apiBaseUrl);
  const port = url.port || defaultPort(url.protocol);
  const env = {
    ...process.env,
    NODE_ENV: "development",
    API_HOST: url.hostname,
    API_PORT: port,
    WEB_ORIGIN: webBaseUrl,
    DATA_STORE: "json",
     IMAGORA_STORE_PATH: managedApiStorePath,
     IMAGORA_SEED_DEMO_DATA: "false",
     IMAGORA_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
     IMAGORA_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      IMAGE_PROVIDER_DEFAULT: process.env.SMOKE_IMAGE_PROVIDER ?? process.env.SMOKE_AI_PROVIDER ?? "",
      IMAGE_MODEL_DEFAULT: process.env.SMOKE_IMAGE_MODEL ?? "",
      PAYMENT_PROVIDER: process.env.SMOKE_PAYMENT_PROVIDER ?? "mock",
      STORAGE_PROVIDER: process.env.SMOKE_STORAGE_PROVIDER ?? "inline",
      QUEUE_PROVIDER: process.env.SMOKE_QUEUE_PROVIDER ?? "inline",
    MAILER_PROVIDER: process.env.SMOKE_MAILER_PROVIDER ?? "console",
    SAFETY_PROVIDER: process.env.SMOKE_SAFETY_PROVIDER ?? "local",
    RATE_LIMIT_PROVIDER: process.env.SMOKE_RATE_LIMIT_PROVIDER ?? "memory",
    SESSION_COOKIE_SECURE: "false"
  };
  const child = spawn(process.execPath, [resolve(rootDir, "apps", "api", "dist", "main.js")], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  managedProcesses.push(trackManagedProcess("api", child));
  await waitForCondition(probeApiHealth, smokeTimeoutMs, "api health");
}

async function ensureWebService() {
  if (reuseRunningServices && (await probeWebHome())) {
    return;
  }
  assertLocalUrl(webBaseUrl, "WEB_BASE_URL");
  await assertReadable(
    resolve(rootDir, "apps", "web", ".next", "BUILD_ID"),
    "Web build output is missing. Run `npm run build` first."
  );

  const url = new URL(webBaseUrl);
  const nextBin = resolve(rootDir, "node_modules", "next", "dist", "bin", "next");
  await assertReadable(nextBin, "Next.js CLI is missing. Run `npm install` first.");

  const child = spawn(
    process.execPath,
    [nextBin, "start", "-p", url.port || defaultPort(url.protocol), "-H", url.hostname],
    {
      cwd: resolve(rootDir, "apps", "web"),
      env: {
        ...process.env,
        PORT: url.port || defaultPort(url.protocol),
        HOSTNAME: url.hostname,
        NEXT_PUBLIC_API_BASE_URL: apiBaseUrl
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  managedProcesses.push(trackManagedProcess("web", child));
  await waitForCondition(probeWebHome, smokeTimeoutMs, "web home");
}

async function probeApiHealth() {
  return probeApiHealthAt(apiBaseUrl);
}

async function probeApiHealthAt(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return payload?.status === "ok" && payload?.service === "imagora-api";
  } catch {
    return false;
  }
}

async function probeWebHome() {
  return probeWebHomeAt(webBaseUrl);
}

async function probeWebHomeAt(baseUrl) {
  try {
    const response = await fetch(baseUrl);
    if (!response.ok) {
      return false;
    }
    const html = await response.text();
    return html.includes("Imagora");
  } catch {
    return false;
  }
}

async function prepareManagedServiceUrl(baseUrl, variableName, probe) {
  assertLocalUrl(baseUrl, variableName);
  if (reuseRunningServices && (await probe(baseUrl))) {
    return normalizeBaseUrl(baseUrl);
  }
  return findAvailableBaseUrl(baseUrl);
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
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
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

async function onceExit(child) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function assertLocalUrl(baseUrl, variableName) {
  const url = new URL(baseUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error(`${variableName} must point to localhost when SMOKE_MANAGE_SERVICES=true`);
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

async function assertReadable(path, message) {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function readSetCookie(response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  return getSetCookie ? getSetCookie()[0] : response.headers.get("set-cookie");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function assertTruthy(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
