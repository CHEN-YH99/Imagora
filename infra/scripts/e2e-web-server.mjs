import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDir = resolve(root, "apps/web");
const nextCli = resolve(root, "node_modules/next/dist/bin/next");
const preflight = resolve(root, "infra/scripts/dev-preflight.mjs");

await access(nextCli);
await runPreflight();

const nextProcess = spawn(process.execPath, [nextCli, "dev", "-p", "3100", "--webpack"], {
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
  const preflightProcess = spawn(process.execPath, [preflight, "3100"], {
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
