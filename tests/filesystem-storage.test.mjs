import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemObjectStorage } from "../packages/storage/dist/index.js";

test("filesystem storage resolves relative LOCAL_STORAGE_DIR from the workspace root across process cwd", async () => {
  const repoRoot = process.cwd();
  const relativeStorageDir = `.tmp/storage-cwd-${randomUUID()}`;
  const key = `generated/test-${randomUUID()}.txt`;
  const previous = snapshotEnv(["LOCAL_STORAGE_DIR", "LOCAL_STORAGE_SIGNING_SECRET", "LOCAL_STORAGE_PUBLIC_PATH"]);

  try {
    process.env.LOCAL_STORAGE_DIR = relativeStorageDir;
    process.env.LOCAL_STORAGE_SIGNING_SECRET = "cwd-stable-storage-secret";
    delete process.env.LOCAL_STORAGE_PUBLIC_PATH;

    process.chdir(join(repoRoot, "apps", "worker"));
    const writer = new FilesystemObjectStorage();
    await writer.putObject({
      key,
      body: "same file",
      mimeType: "text/plain"
    });

    process.chdir(join(repoRoot, "apps", "api"));
    const reader = new FilesystemObjectStorage();
    const signedUrl = await reader.getSignedUrl(key, 60);
    const url = new URL(`http://imagora.local${signedUrl}`);
    const filePath = reader.verifyAndResolve(
      key,
      Number(url.searchParams.get("expiresAt")),
      url.searchParams.get("signature") ?? ""
    );

    assert.equal(await readFile(filePath, "utf8"), "same file");
    assert.equal(filePath.startsWith(join(repoRoot, relativeStorageDir)), true, filePath);
  } finally {
    process.chdir(repoRoot);
    restoreEnv(previous);
    await rm(join(repoRoot, relativeStorageDir), { recursive: true, force: true });
    await rm(join(repoRoot, "apps", "worker", relativeStorageDir), { recursive: true, force: true });
    await rm(join(repoRoot, "apps", "api", relativeStorageDir), { recursive: true, force: true });
  }
});

// filesystem 存储模式端到端：图片写本地磁盘，数据库只存 local://key，
// 前端拿到的是 /api/files/<key>?expiresAt=&signature= 签名 URL，由 API 校验后回读。
test("filesystem storage serves signed image files and rejects tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-fs-"));
  const port = 5600 + Math.floor(Math.random() * 300);
  const storePath = join(dir, "store.json");
  const storageDir = join(dir, "generated-files");

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
    STORAGE_PROVIDER: "filesystem",
    LOCAL_STORAGE_DIR: storageDir,
    LOCAL_STORAGE_SIGNING_SECRET: "test-fs-signing-secret",
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
        prompt: "A cozy reading nook lit by warm afternoon light",
        style: "illustration",
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
    // 缩略图应被就地签名成 /api/files 相对路径，且携带过期与签名参数。
    assert.match(image.thumbnailUrl, /^\/api\/files\/generated\//, image.thumbnailUrl);
    assert.match(image.thumbnailUrl, /[?&]expiresAt=\d+/, image.thumbnailUrl);
    assert.match(image.thumbnailUrl, /[?&]signature=[0-9a-f]{64}/, image.thumbnailUrl);

    // 直接 GET 签名缩略图应回读到文件本体。
    const thumbResponse = await fetch(`${baseUrl}${image.thumbnailUrl}`);
    assert.equal(thumbResponse.status, 200, `thumbnail fetch failed: ${thumbResponse.status}`);
    const thumbBody = Buffer.from(await thumbResponse.arrayBuffer());
    assert.ok(thumbBody.byteLength > 0, "thumbnail body was empty");

    // 全尺寸预览走按需签名接口，同样应可直连回读。
    const preview = await post(baseUrl, `/api/images/${image.id}/preview-url`, {}, demo.session);
    assert.match(preview.data.url, /^\/api\/files\/generated\//, preview.data.url);
    const previewResponse = await fetch(`${baseUrl}${preview.data.url}`);
    assert.equal(previewResponse.status, 200, `preview fetch failed: ${previewResponse.status}`);

    // 下载链接同样走 /api/files 签名。
    const download = await post(baseUrl, `/api/images/${image.id}/download-url`, {}, demo.session);
    assert.match(download.data.url, /^\/api\/files\/generated\//, download.data.url);

    // 篡改签名必须被拒。
    const tampered = image.thumbnailUrl.replace(/signature=[0-9a-f]+/, "signature=" + "0".repeat(64));
    const tamperedResponse = await fetch(`${baseUrl}${tampered}`);
    assert.equal(tamperedResponse.status, 403, `tampered signature was not rejected: ${tamperedResponse.status}`);

    // 过期链接必须被拒。
    const key = image.thumbnailUrl.split("?")[0];
    const expiredUrl = `${key}?expiresAt=1&signature=${"0".repeat(64)}`;
    const expiredResponse = await fetch(`${baseUrl}${expiredUrl}`);
    assert.equal(expiredResponse.status, 403, `expired signature was not rejected: ${expiredResponse.status}`);
  } finally {
    api.kill();
    worker.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

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

function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
