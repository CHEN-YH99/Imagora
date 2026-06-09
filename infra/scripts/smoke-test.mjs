const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:3100";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "admin@imagora.local";
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD ?? "Admin123!";

const checks = [
  ["api health", checkApiHealth],
  ["feature flags", checkFeatureFlags],
  ["admin metrics", checkAdminMetrics],
  ["web home", checkWebHome]
];

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

async function checkApiHealth() {
  const health = await getJson(`${apiBaseUrl}/health`);
  assertEqual(health.status, "ok", "health status should be ok");
}

async function checkFeatureFlags() {
  const envelope = await getJson(`${apiBaseUrl}/api/features`);
  assertTruthy(envelope.data?.features, "features payload is missing");
}

async function checkAdminMetrics() {
  const login = await postJson(`${apiBaseUrl}/api/auth/login`, {
    email: adminEmail,
    password: adminPassword
  });
  const token = login.data?.token;
  assertTruthy(token, "admin token is missing");
  const metrics = await getJson(`${apiBaseUrl}/api/admin/metrics`, token);
  assertTruthy(metrics.data?.service, "service metrics are missing");
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

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
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
