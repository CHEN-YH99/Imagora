import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDir = resolve(root, "apps/web");
const nextCli = await resolveNextCli();
const preflight = resolve(root, "infra/scripts/dev-preflight.mjs");
const baseUrl = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100");
const port = baseUrl.port || defaultPort(baseUrl.protocol);
const buildId = resolve(webDir, ".next", "BUILD_ID");

await access(nextCli);
await access(buildId);
await runPreflight();

const nextProcess = spawn(process.execPath, [nextCli, "start", "-p", port, "-H", baseUrl.hostname], {
  cwd: webDir,
  env: {
    ...process.env,
    BROWSER: "none"
  },
  stdio: "inherit",
  windowsHide: true
});

let stopping = false;
let forcedExitTimer = null;

nextProcess.on("exit", (code, signal) => {
  if (forcedExitTimer) {
    clearTimeout(forcedExitTimer);
  }
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

nextProcess.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}

async function runPreflight() {
  const preflightProcess = spawn(process.execPath, [preflight, port], {
    cwd: webDir,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  const code = await new Promise((resolveCode, reject) => {
    preflightProcess.once("error", reject);
    preflightProcess.once("exit", (exitCode) => resolveCode(exitCode ?? 0));
  });
  if (code !== 0) {
    process.exit(code);
  }
}

function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  if (!nextProcess.killed) {
    nextProcess.kill(signal);
  }
  forcedExitTimer = setTimeout(() => {
    if (!nextProcess.killed) {
      nextProcess.kill("SIGKILL");
    }
    process.exit(1);
  }, 5000);
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : "80";
}

async function resolveNextCli() {
  const candidates = [
    resolve(root, "apps/web/node_modules/next/dist/bin/next"),
    resolve(root, "node_modules/next/dist/bin/next")
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0];
}
