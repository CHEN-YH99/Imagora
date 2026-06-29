import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("worker stores SVG thumbnails with matching SVG metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-thumb-"));
  const port = 5100 + Math.floor(Math.random() * 400);
  const storePath = join(dir, "store.json");
  const objectStorage = createCaptureObjectStorageServer();

  await objectStorage.listen();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    IMAGORA_STORE_PATH: storePath,
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    ORDER_PENDING_TTL_MINUTES: "30",
    WORKER_POLL_INTERVAL_MS: "300",
    STORAGE_PROVIDER: "s3",
    S3_ENDPOINT: `http://127.0.0.1:${objectStorage.port}`,
    S3_BUCKET: "imagora",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_PUBLIC_BASE_URL: "https://cdn.example",
    DOWNLOAD_URL_TTL_MINUTES: "20000"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });
  const worker = spawn(process.execPath, ["apps/worker/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const created = await post(
      baseUrl,
      "/api/generation/tasks",
      {
        clientRequestId: randomUUID(),
        prompt: "An editorial image grid for a launch campaign",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      },
      demo.session
    );
    const completed = await waitForTask(baseUrl, demo.session, created.data.task.id);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.images.length, 1);

    const image = completed.data.images[0];
    assert.equal(image.mimeType, "image/svg+xml");
    assert.match(image.storageKey, /\.svg$/);
    assert.match(image.thumbnailKey, /-thumb\.svg$/);
    assert.match(image.thumbnailUrl, /^https:\/\/cdn\.example\/generated\//);
    assert.match(image.thumbnailUrl, /-thumb\.svg$/);
    assert.notEqual(image.thumbnailUrl, image.publicUrl);

    const originalUpload = objectStorage.puts.find((upload) => upload.path.endsWith(`/${image.storageKey}`));
    const thumbnailUpload = objectStorage.puts.find((upload) => upload.path.endsWith(`/${image.thumbnailKey}`));
    assert.ok(originalUpload, `Missing original upload for ${image.storageKey}`);
    assert.ok(thumbnailUpload, `Missing thumbnail upload for ${image.thumbnailKey}`);
    assert.equal(originalUpload.headers["content-type"], "image/svg+xml");
    assert.equal(thumbnailUpload.headers["content-type"], "image/svg+xml");
    assert.match(originalUpload.body.toString("utf8"), /^<svg[\s>]/);
    assert.match(thumbnailUpload.body.toString("utf8"), /^<svg[\s>]/);
    assert.match(thumbnailUpload.body.toString("utf8"), /width="320"/);
    assert.match(thumbnailUpload.body.toString("utf8"), /height="320"/);

    const download = await post(baseUrl, `/api/images/${image.id}/download-url`, {}, demo.session);
    const signedUrl = new URL(download.data.url);
    const expiresAtMs = new Date(download.data.expiresAt).getTime();
    assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "604800");
    assert.ok(expiresAtMs - Date.now() <= 604_805_000);

    const deleted = await deleteRequest(baseUrl, `/api/images/${image.id}`, demo.session);
    assert.equal(deleted.data.deleted, true);
    assert.ok(objectStorage.deletes.some((deletedPath) => deletedPath.endsWith(`/${image.storageKey}`)));
    assert.ok(objectStorage.deletes.some((deletedPath) => deletedPath.endsWith(`/${image.thumbnailKey}`)));
  } finally {
    api.kill();
    worker.kill();
    await objectStorage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function createCaptureObjectStorageServer() {
  const puts = [];
  const deletes = [];
  let port = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (request.method === "PUT") {
        puts.push({
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks)
        });
        response.statusCode = 200;
        response.end("");
        return;
      }

      if (request.method === "DELETE") {
        deletes.push(request.url ?? "");
        response.statusCode = 204;
        response.end("");
        return;
      }

      response.statusCode = 200;
      response.end("");
    });
  });

  return {
    puts,
    deletes,
    get port() {
      return port;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          assert.ok(address && typeof address === "object");
          port = address.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function login(baseUrl, email, password) {
  const firstProof = await verifyCaptcha(baseUrl);
  const secondProof = await verifyCaptcha(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      captchaVerificationIds: [firstProof.data.verificationId, secondProof.data.verificationId]
    })
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  assert.ok(setCookie);
  return { ...payload, session: setCookie.split(";")[0] };
}

async function verifyCaptcha(baseUrl) {
  const captcha = await getCaptcha(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/captcha/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      captchaId: captcha.data.captchaId,
      captchaSelections: captcha.data.answer
    })
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.ok(payload.data?.verificationId);
  return payload;
}

async function getCaptcha(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/captcha`);
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.ok(payload.data?.captchaId);
  assert.ok(payload.data?.requiredSelections);
  assert.ok(payload.data?.answer);
  return payload;
}

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

async function waitForTask(baseUrl, session, taskId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await get(baseUrl, `/api/generation/tasks/${taskId}`, session);
    if (["SUCCEEDED", "FAILED", "BLOCKED"].includes(response.data.task.status)) {
      return response;
    }
    await sleep(300);
  }
  throw new Error("Task did not complete");
}

async function post(baseUrl, path, body, session) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionHeaders(session)
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function deleteRequest(baseUrl, path, session) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: sessionHeaders(session)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function get(baseUrl, path, session) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: sessionHeaders(session)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

function sessionHeaders(session) {
  return session ? { Cookie: session } : {};
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
