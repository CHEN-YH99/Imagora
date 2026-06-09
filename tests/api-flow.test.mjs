import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("api and worker complete generation and enforce admin safety rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-api-"));
  const port = 4700 + Math.floor(Math.random() * 400);
  const storePath = join(dir, "store.json");
  const env = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    IMAGORA_STORE_PATH: storePath,
    WORKER_POLL_INTERVAL_MS: "300"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });
  const worker = spawn(process.execPath, ["apps/worker/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const demo = await post(baseUrl, "/api/auth/login", {
      email: "demo@imagora.local",
      password: "Demo123!"
    });
    const demoToken = demo.data.token;
    const created = await post(
      baseUrl,
      "/api/generation/tasks",
      {
        clientRequestId: crypto.randomUUID(),
        prompt: "A clean isometric creative dashboard",
        negativePrompt: "low quality",
        style: "illustration",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      },
      demoToken
    );

    const taskId = created.data.task.id;
    const completed = await waitForTask(baseUrl, demoToken, taskId);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.images.length, 1);

    const admin = await post(baseUrl, "/api/auth/login", {
      email: "admin@imagora.local",
      password: "Admin123!"
    });
    await post(
      baseUrl,
      "/api/admin/safety-rules",
      { term: "blockedtest", action: "BLOCK", status: "ACTIVE" },
      admin.data.token
    );
    const blocked = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${demoToken}`
      },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        prompt: "blockedtest creative brief",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      })
    });
    const blockedPayload = await blocked.json();
    assert.equal(blocked.status, 400);
    assert.equal(blockedPayload.error.code, "CONTENT_BLOCKED");
  } finally {
    api.kill();
    worker.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(200);
  }
  throw new Error("API health check timed out");
}

async function waitForTask(baseUrl, token, taskId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await get(baseUrl, `/api/generation/tasks/${taskId}`, token);
    if (["SUCCEEDED", "FAILED", "BLOCKED"].includes(response.data.task.status)) {
      return response;
    }
    await sleep(300);
  }
  throw new Error("Task did not complete");
}

async function post(baseUrl, path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function get(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
