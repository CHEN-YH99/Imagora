import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

test("E2E startup rejects occupied ports and leaves the existing server running", { timeout: 10000 }, async () => {
  const existing = createServer((_request, response) => response.end("existing service"));
  await new Promise((resolve, reject) => {
    existing.once("error", reject);
    existing.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const baseUrl = `http://127.0.0.1:${existing.address().port}`;
  try {
    const child = spawn(process.execPath, ["infra/scripts/e2e-web-server.mjs"], {
      env: { ...process.env, PLAYWRIGHT_BASE_URL: baseUrl },
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1);
    assert.match(output, /E2E port \d+ is unavailable; existing services were left running/);
    assert.equal(existing.listening, true);
    assert.equal(await (await fetch(baseUrl)).text(), "existing service");
  } finally {
    existing.closeAllConnections();
    await new Promise((resolve) => existing.close(resolve));
  }
});
