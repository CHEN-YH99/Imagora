import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

test("load smoke checks multiple targets and threshold metrics", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/api/features") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { features: {} } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const result = await runNodeScript("infra/scripts/load-smoke.mjs", {
      API_BASE_URL: `http://127.0.0.1:${address.port}`,
      LOAD_REQUESTS: "6",
      LOAD_CONCURRENCY: "2",
      LOAD_TARGETS: "/health,/api/features",
      LOAD_AVG_MS: "1000",
      LOAD_P95_MS: "1000",
      LOAD_FAILURE_RATE_MAX: "0"
    });
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.targets.length, 2);
    assert.ok(summary.targets.every((target) => target.passed));
    assert.deepEqual(
      summary.targets.map((target) => target.path),
      ["/health", "/api/features"]
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
