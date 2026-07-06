import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverScript = resolve(root, "infra/scripts/e2e-web-server.mjs");
const playwrightCli = resolve(root, "node_modules/@playwright/test/cli.js");
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? (await defaultBaseUrl());
const args = process.argv.slice(2);

const server = spawn(process.execPath, [serverScript], {
  cwd: root,
  env: {
    ...process.env,
    PLAYWRIGHT_BASE_URL: baseUrl
  },
  stdio: "inherit",
  windowsHide: true
});

let serverExited = false;
let stoppingServer = false;
server.once("exit", (code) => {
  serverExited = true;
  if (!stoppingServer && code !== 0) {
    console.error(`E2E web server exited before tests completed with code ${code ?? "unknown"}.`);
  }
});

try {
  await waitForServer();
  const exitCode = await runPlaywright();
  process.exitCode = exitCode;
} finally {
  await stopServer();
}

async function waitForServer() {
  const timeoutMs = 120_000;
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    if (serverExited) {
      throw new Error("E2E web server exited before it became ready.");
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
      lastError = `${baseUrl} returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for E2E web server at ${baseUrl}. Last error: ${lastError}`);
}

function runPlaywright() {
  return new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, [playwrightCli, "test", ...args], {
      cwd: root,
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_WEB_SERVER: "1",
        PLAYWRIGHT_BASE_URL: baseUrl
      },
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveCode(code ?? 1));
  });
}

async function stopServer() {
  if (serverExited || !server.pid) {
    return;
  }
  stoppingServer = true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill("SIGTERM");
  }
  const stopped = await Promise.race([
    new Promise((resolveStopped) => server.once("exit", () => resolveStopped(true))),
    delay(5000).then(() => false)
  ]);
  if (!stopped && !server.killed) {
    server.kill("SIGKILL");
  }
}

async function defaultBaseUrl() {
  const defaultUrl = "http://127.0.0.1:3100";
  if (await isPortFree(3100, "127.0.0.1")) {
    return defaultUrl;
  }
  const port = await findAvailablePort("127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

async function isPortFree(port, host) {
  const server = createServer();
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      server.once("error", rejectOpen);
      server.listen(port, host, resolveOpen);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
}

async function findAvailablePort(host) {
  const server = createServer();
  try {
    const address = await new Promise((resolveAddress, rejectAddress) => {
      server.once("error", rejectAddress);
      server.listen(0, host, () => resolveAddress(server.address()));
    });
    if (!address || typeof address === "string") {
      throw new Error("Unable to reserve an available E2E port.");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
}
