import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("postgres load smoke requires a database URL", async () => {
  const result = await runNodeScript("infra/scripts/postgres-load-smoke.mjs", {
    DATABASE_URL: "",
    POSTGRES_LOAD_DATABASE_URL: ""
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /POSTGRES_LOAD_DATABASE_URL or DATABASE_URL is required/);
});

test("postgres load smoke exposes deterministic metric helpers", async () => {
  const { summarizeLatencies } = await import("../infra/scripts/postgres-load-smoke.mjs");

  assert.deepEqual(summarizeLatencies([9, 1, 5, 3, 7], 5, 0), {
    requests: 5,
    failures: 0,
    failureRate: 0,
    averageMs: 5,
    p95Ms: 9,
    p99Ms: 9
  });
});

function runNodeScript(script, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
