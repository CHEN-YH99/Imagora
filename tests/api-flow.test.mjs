import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { JsonStore } from "../packages/database/dist/index.js";

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const defaultWriteOrigin = "http://127.0.0.1:3100";

test("api rejects bearer session auth in production config", async () => {
  const env = productionApiEnv({ ALLOW_BEARER_SESSION_AUTH: "true" });

  const result = await runProcess(process.execPath, ["apps/api/dist/main.js"], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /bearer session auth must be disabled/);
});

test("api rejects in-memory runtime state in production config", async () => {
  const env = productionApiEnv({ RUNTIME_STATE_PROVIDER: "memory" });

  const result = await runProcess(process.execPath, ["apps/api/dist/main.js"], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /RUNTIME_STATE_PROVIDER must be redis/);
});

test("api rejects production config without any alert channel", async () => {
  const env = productionApiEnv();
  delete env.ALERT_WEBHOOK_URL;
  delete env.ALERT_EMAIL_TO;

  const result = await runProcess(process.execPath, ["apps/api/dist/main.js"], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /at least one alert channel is required/);
});

test("api rejects production session cookies unless SameSite is explicitly Strict", async (t) => {
  for (const scenario of [
    { name: "missing", value: undefined, expected: /SESSION_COOKIE_SAMESITE is required/ },
    { name: "Lax", value: "Lax", expected: /SESSION_COOKIE_SAMESITE must be Strict/ },
    { name: "None", value: "None", expected: /SESSION_COOKIE_SAMESITE must be Strict/ }
  ]) {
    await t.test(scenario.name, async () => {
      const env = productionApiEnv();
      if (scenario.value === undefined) {
        delete env.SESSION_COOKIE_SAMESITE;
      } else {
        env.SESSION_COOKIE_SAMESITE = scenario.value;
      }
      const result = await runProcess(process.execPath, ["apps/api/dist/main.js"], env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, scenario.expected);
    });
  }
});

test("auth remains usable in local development when prisma database is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-auth-fallback-"));
  const port = await reserveUnusedPort();
  const unavailableDbPort = await reserveUnusedPort();
  const storePath = join(dir, "fallback-store.json");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    DATA_STORE: "prisma",
    DATABASE_URL: `postgresql://imagora:imagora@127.0.0.1:${unavailableDbPort}/imagora`,
    IMAGORA_STORE_PATH: storePath,
    IMAGORA_SEED_DEMO_DATA: "true",
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    RATE_LIMIT_PROVIDER: "memory",
    WEB_ORIGIN: "http://127.0.0.1:3100",
    CSRF_ALLOWED_ORIGINS: "http://127.0.0.1:3100"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, 12000);

    const browserOrigin = "http://localhost:3100";
    const preflight = await fetch(`${baseUrl}/api/auth/register`, {
      method: "OPTIONS",
      headers: {
        Origin: browserOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), browserOrigin);

    const email = `local-${crypto.randomUUID()}@imagora.local`;
    const password = "LocalStrong123!";
    const registered = await authPost(baseUrl, "/api/auth/register", { email, password }, browserOrigin);
    assert.equal(registered.data.user.email, email);

    const firstFallbackProof = await verifyCaptcha(baseUrl, browserOrigin);
    const secondFallbackProof = await verifyCaptcha(baseUrl, browserOrigin);
    const loggedIn = await authPost(
      baseUrl,
      "/api/auth/login",
      {
        email,
        password,
        captchaVerificationIds: [firstFallbackProof.data.verificationId, secondFallbackProof.data.verificationId]
      },
      browserOrigin
    );
    assert.equal(loggedIn.data.user.email, email);
  } finally {
    api.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth validates registration and login payloads at browser boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-auth-validation-"));
  const port = await reserveUnusedPort();
  const storePath = join(dir, "store.json");
  const origin = "http://127.0.0.1:3100";
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    DATA_STORE: "json",
    IMAGORA_STORE_PATH: storePath,
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    RATE_LIMIT_PROVIDER: "memory",
    WEB_ORIGIN: origin,
    CSRF_ALLOWED_ORIGINS: origin
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, 12000);

    const injectedNickname = await rawAuthPost(
      baseUrl,
      "/api/auth/register",
      {
        email: `nickname-${crypto.randomUUID()}@imagora.local`,
        password: "StrongLocal123!",
        nickname: "Injected"
      },
      origin
    );
    assert.equal(injectedNickname.status, 400);
    assert.equal(injectedNickname.payload.error.code, "VALIDATION_ERROR");

    const weakPassword = await rawAuthPost(
      baseUrl,
      "/api/auth/register",
      {
        email: `weak-${crypto.randomUUID()}@imagora.local`,
        password: "password"
      },
      origin
    );
    assert.equal(weakPassword.status, 400);
    assert.equal(weakPassword.payload.error.code, "VALIDATION_ERROR");

    const weakResetPassword = await rawAuthPost(
      baseUrl,
      "/api/auth/reset-password",
      {
        token: "missing-token",
        password: "password"
      },
      origin
    );
    assert.equal(weakResetPassword.status, 400);
    assert.equal(weakResetPassword.payload.error.code, "VALIDATION_ERROR");

    const email = `Mixed-${crypto.randomUUID()}@IMAGORA.LOCAL`;
    const registered = await authPost(
      baseUrl,
      "/api/auth/register",
      { email: `  ${email}  `, password: "StrongLocal123!" },
      origin
    );
    assert.equal(registered.data.user.email, email.toLowerCase());
    assert.notEqual(registered.data.user.nickname, "Injected");

    const firstValidationProof = await verifyCaptcha(baseUrl, origin);
    const secondValidationProof = await verifyCaptcha(baseUrl, origin);
    const loggedIn = await authPost(
      baseUrl,
      "/api/auth/login",
      {
        email: `  ${email.toUpperCase()}  `,
        password: "StrongLocal123!",
        captchaVerificationIds: [firstValidationProof.data.verificationId, secondValidationProof.data.verificationId]
      },
      origin
    );
    assert.equal(loggedIn.data.user.email, email.toLowerCase());

    const duplicate = await rawAuthPost(
      baseUrl,
      "/api/auth/register",
      { email: email.toLowerCase(), password: "StrongLocal123!" },
      origin
    );
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.payload.error.code, "CONFLICT");
    assert.equal(duplicate.payload.error.message, "Unable to create account with these credentials");
  } finally {
    api.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation creation remains durable and idempotent when redis enqueue is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-generation-enqueue-fallback-"));
  const port = await reserveUnusedPort();
  const unavailableRedisPort = await reserveUnusedPort();
  const storePath = join(dir, "store.json");
  const origin = "http://127.0.0.1:3100";
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    DATA_STORE: "json",
    IMAGORA_STORE_PATH: storePath,
    IMAGORA_SEED_DEMO_DATA: "true",
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    RATE_LIMIT_PROVIDER: "memory",
    QUEUE_PROVIDER: "bullmq",
    REDIS_URL: `redis://127.0.0.1:${unavailableRedisPort}`,
    GENERATION_QUEUE_COMMAND_TIMEOUT_MS: "100",
    GENERATION_ENQUEUE_RECONCILE_INTERVAL_MS: "60000",
    WEB_ORIGIN: origin,
    CSRF_ALLOWED_ORIGINS: origin
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, 12000);

    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const startingCredits = await get(baseUrl, "/api/users/me/credits", demo.session);
    const clientRequestId = randomUUID();
    const body = {
      clientRequestId,
      prompt: "A durable queue fallback test image",
      style: "realistic",
      aspectRatio: "1:1",
      quantity: 1,
      quality: "draft"
    };

    const firstResponse = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionHeaders(demo.session)
      },
      body: JSON.stringify(body)
    });
    const firstPayload = await firstResponse.json();
    assert.equal(firstResponse.status, 201, JSON.stringify(firstPayload));
    assert.equal(firstPayload.data.task.status, "PENDING");
    assert.equal(
      firstPayload.data.balanceAfter,
      startingCredits.data.account.balance - firstPayload.data.task.creditCost
    );

    const duplicateResponse = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionHeaders(demo.session)
      },
      body: JSON.stringify(body)
    });
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 200, JSON.stringify(duplicatePayload));
    assert.equal(duplicatePayload.data.task.id, firstPayload.data.task.id);
    assert.equal(duplicatePayload.data.task.status, "PENDING");
    assert.equal(duplicatePayload.data.balanceAfter, firstPayload.data.balanceAfter);

    const stored = await readStore(storePath);
    const matchingTasks = stored.generationTasks.filter(
      (task) => task.userId === demo.data.user.id && task.clientRequestId === clientRequestId
    );
    assert.equal(matchingTasks.length, 1);
    assert.equal(matchingTasks[0].status, "PENDING");
    assert.equal(
      stored.creditLedgerEntries.filter((entry) => entry.sourceId === matchingTasks[0].id && entry.type === "SPEND")
        .length,
      1
    );
    assert.equal(
      stored.creditLedgerEntries.filter((entry) => entry.sourceId === matchingTasks[0].id && entry.type === "REFUND")
        .length,
      0
    );
  } finally {
    api.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth login requires a valid one-time image captcha", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-auth-captcha-"));
  const port = await reserveUnusedPort();
  const storePath = join(dir, "store.json");
  const origin = "http://127.0.0.1:3100";
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    DATA_STORE: "json",
    IMAGORA_STORE_PATH: storePath,
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    RATE_LIMIT_PROVIDER: "memory",
    WEB_ORIGIN: origin,
    CSRF_ALLOWED_ORIGINS: origin
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const missingCaptcha = await rawAuthPost(
      baseUrl,
      "/api/auth/login",
      { email: "demo@imagora.local", password: "Demo123!" },
      origin
    );
    assert.equal(missingCaptcha.status, 400);
    assert.equal(missingCaptcha.payload.error.code, "CAPTCHA_REQUIRED");

    const captcha = await getCaptcha(baseUrl, origin);
    assert.match(captcha.data.imageSvg, /^<svg/);
    assert.match(captcha.data.instruction, /^请点击图中所有/);
    assert.ok(captcha.data.requiredSelections >= 2);
    assert.ok(captcha.data.requiredSelections <= 4);
    assert.ok(captcha.data.optionCount >= 12);
    assert.equal(captcha.data.answer.length, captcha.data.requiredSelections);

    const wrongCaptcha = await rawApiPost(
      baseUrl,
      "/api/auth/captcha/verify",
      {
        captchaId: captcha.data.captchaId,
        captchaSelections: [{ x: 0.01, y: 0.01 }]
      },
      origin
    );
    assert.equal(wrongCaptcha.status, 400);
    assert.equal(wrongCaptcha.payload.error.code, "CAPTCHA_INVALID");

    const duplicateCaptcha = await getCaptcha(baseUrl, origin);
    const repeatedSelection = duplicateCaptcha.data.answer[0];
    const duplicateSelectionLogin = await rawApiPost(
      baseUrl,
      "/api/auth/captcha/verify",
      {
        captchaId: duplicateCaptcha.data.captchaId,
        captchaSelections: Array.from({ length: duplicateCaptcha.data.requiredSelections }, () => repeatedSelection)
      },
      origin
    );
    assert.equal(duplicateSelectionLogin.status, 400);
    assert.equal(duplicateSelectionLogin.payload.error.code, "CAPTCHA_INVALID");

    const firstProof = await verifyCaptcha(baseUrl, origin);
    const secondProof = await verifyCaptcha(baseUrl, origin);
    assert.notEqual(firstProof.data.verificationId, secondProof.data.verificationId);

    const oneProofLogin = await rawAuthPost(
      baseUrl,
      "/api/auth/login",
      {
        email: "demo@imagora.local",
        password: "Demo123!",
        captchaVerificationIds: [firstProof.data.verificationId]
      },
      origin
    );
    assert.equal(oneProofLogin.status, 400);
    assert.equal(oneProofLogin.payload.error.code, "CAPTCHA_REQUIRED");

    const loggedIn = await authPost(
      baseUrl,
      "/api/auth/login",
      {
        email: "demo@imagora.local",
        password: "Demo123!",
        captchaVerificationIds: [firstProof.data.verificationId, secondProof.data.verificationId]
      },
      origin
    );
    assert.equal(loggedIn.data.user.email, "demo@imagora.local");

    const reusedCaptcha = await rawAuthPost(
      baseUrl,
      "/api/auth/login",
      {
        email: "demo@imagora.local",
        password: "Demo123!",
        captchaVerificationIds: [firstProof.data.verificationId, secondProof.data.verificationId]
      },
      origin
    );
    assert.equal(reusedCaptcha.status, 400);
    assert.equal(reusedCaptcha.payload.error.code, "CAPTCHA_INVALID");
  } finally {
    api.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("user image and generation task lists expose filtered offset pagination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-user-pagination-"));
  const port = await reserveUnusedPort();
  const storePath = join(dir, "store.json");
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    DATA_STORE: "json",
    IMAGORA_STORE_PATH: storePath,
    IMAGORA_SEED_DEMO_DATA: "true",
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    RATE_LIMIT_PROVIDER: "memory",
    WEB_ORIGIN: defaultWriteOrigin,
    CSRF_ALLOWED_ORIGINS: defaultWriteOrigin
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, 12000);
    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const userId = demo.data.user.id;
    const taskIds = Array.from({ length: 55 }, (_, index) => `pagination-task-${index + 1}`);
    const newerImageIds = Array.from({ length: 105 }, (_, index) => `pagination-new-image-${index + 1}`);
    const favoriteImageIds = Array.from({ length: 3 }, (_, index) => `pagination-favorite-image-${index + 1}`);

    await updateStoreJson(storePath, (store) => {
      store.generationTasks = store.generationTasks.filter((task) => task.userId !== userId);
      store.generatedImages = store.generatedImages.filter((image) => image.userId !== userId);
      store.imageFavorites = store.imageFavorites.filter((favorite) => favorite.userId !== userId);

      for (const [index, taskId] of taskIds.entries()) {
        const createdAt = new Date(Date.UTC(2026, 6, 17, 12, 0, index)).toISOString();
        store.generationTasks.push(createPaginationTask(taskId, userId, createdAt));
      }

      for (const [index, imageId] of newerImageIds.entries()) {
        const createdAt = new Date(Date.UTC(2026, 6, 17, 10, index, 0)).toISOString();
        store.generatedImages.push(createPaginationImage(imageId, taskIds[0], userId, createdAt));
      }
      for (const [index, imageId] of favoriteImageIds.entries()) {
        const createdAt = new Date(Date.UTC(2025, 0, index + 1, 10, 0, 0)).toISOString();
        store.generatedImages.push(createPaginationImage(imageId, taskIds[0], userId, createdAt));
        store.imageFavorites.push({ userId, imageId, createdAt });
      }
    });

    const unfilteredImages = await get(baseUrl, "/api/images?limit=100&offset=0", demo.session);
    assert.equal(unfilteredImages.data.images.length, 100);
    assert.equal(unfilteredImages.data.pageInfo.total, 108);
    assert.equal(unfilteredImages.data.pageInfo.hasMore, true);
    assert.equal(
      unfilteredImages.data.images.some((image) => favoriteImageIds.includes(image.id)),
      false,
      "older favorites should be outside the unfiltered first page"
    );

    const favoriteFirstPage = await get(baseUrl, "/api/images?favorite=true&limit=2&offset=0", demo.session);
    const favoriteSecondPage = await get(baseUrl, "/api/images?favorite=true&limit=2&offset=2", demo.session);
    assert.deepEqual(favoriteFirstPage.data.pageInfo, {
      offset: 0,
      limit: 2,
      total: 3,
      hasMore: true
    });
    assert.deepEqual(favoriteSecondPage.data.pageInfo, {
      offset: 2,
      limit: 2,
      total: 3,
      hasMore: false
    });
    const returnedFavoriteImages = [...favoriteFirstPage.data.images, ...favoriteSecondPage.data.images];
    const returnedFavoriteIds = returnedFavoriteImages.map((image) => image.id);
    assert.equal(new Set(returnedFavoriteIds).size, favoriteImageIds.length);
    assert.deepEqual(new Set(returnedFavoriteIds), new Set(favoriteImageIds));
    assert.ok(returnedFavoriteImages.every((image) => image.favorite));

    const nonFavoriteImages = await get(baseUrl, "/api/images?favorite=false&limit=5&offset=0", demo.session);
    assert.equal(nonFavoriteImages.data.pageInfo.total, newerImageIds.length);
    assert.ok(nonFavoriteImages.data.images.every((image) => image.favorite === false));

    const firstTaskPage = await get(baseUrl, "/api/generation/tasks?limit=50&offset=0", demo.session);
    const secondTaskPage = await get(baseUrl, "/api/generation/tasks?limit=50&offset=50", demo.session);
    assert.deepEqual(firstTaskPage.data.pageInfo, {
      offset: 0,
      limit: 50,
      total: taskIds.length,
      hasMore: true
    });
    assert.deepEqual(secondTaskPage.data.pageInfo, {
      offset: 50,
      limit: 50,
      total: taskIds.length,
      hasMore: false
    });
    assert.equal(secondTaskPage.data.tasks.length, 5);
    const returnedTaskIds = [...firstTaskPage.data.tasks, ...secondTaskPage.data.tasks].map((task) => task.id);
    assert.equal(new Set(returnedTaskIds).size, taskIds.length);
    assert.deepEqual(new Set(returnedTaskIds), new Set(taskIds));
  } finally {
    api.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api and worker complete generation and enforce admin safety rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-api-"));
  const port = 4700 + Math.floor(Math.random() * 400);
  const storePath = join(dir, "store.json");
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    IMAGORA_STORE_PATH: storePath,
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    ORDER_PENDING_TTL_MINUTES: "30",
    GENERATION_RUNNING_TIMEOUT_MS: "600000",
    WORKER_MAINTENANCE_INTERVAL_MS: "0",
    WORKER_POLL_INTERVAL_MS: "300"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });
  const worker = spawn(process.execPath, ["apps/worker/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const demoSession = demo.session;

    const bearerDenied = await fetch(`${baseUrl}/api/users/me/credits`, {
      headers: {
        Authorization: `Bearer ${demo.sessionValue}`
      }
    });
    const bearerDeniedPayload = await bearerDenied.json();
    assert.equal(bearerDenied.status, 401);
    assert.equal(bearerDeniedPayload.error.code, "UNAUTHORIZED");

    const cookieAuthenticated = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.ok(cookieAuthenticated.data.account.balance >= 0);

    const blockedOrigin = await fetch(`${baseUrl}/api/generation/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: "https://evil.example"
      },
      body: JSON.stringify({
        prompt: "blocked cross origin write",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      })
    });
    const blockedOriginPayload = await blockedOrigin.json();
    assert.equal(blockedOrigin.status, 403);
    assert.equal(blockedOriginPayload.error.code, "FORBIDDEN");

    const missingOrigin = await fetch(`${baseUrl}/api/generation/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession
      },
      body: JSON.stringify({
        prompt: "missing origin write",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      })
    });
    const missingOriginPayload = await missingOrigin.json();
    assert.equal(missingOrigin.status, 403);
    assert.equal(missingOriginPayload.error.code, "FORBIDDEN");

    const nestedWebhookPath = await fetch(`${baseUrl}/api/payments/webhooks/mock/nested`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    const nestedWebhookPayload = await nestedWebhookPath.json();
    assert.equal(nestedWebhookPath.status, 403);
    assert.equal(nestedWebhookPayload.error.code, "FORBIDDEN");

    const invalidUpload = await fetch(`${baseUrl}/api/uploads/reference-images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        fileName: "fake.png",
        mimeType: "image/png",
        contentBase64: Buffer.from("not an image").toString("base64")
      })
    });
    const invalidUploadPayload = await invalidUpload.json();
    assert.equal(invalidUpload.status, 400);
    assert.equal(invalidUploadPayload.error.code, "VALIDATION_ERROR");

    const oversizedInvalidUpload = await fetch(`${baseUrl}/api/uploads/reference-images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        fileName: "large-invalid.png",
        mimeType: "image/png",
        contentBase64: Buffer.from("not an image".repeat(20_000)).toString("base64")
      })
    });
    const oversizedInvalidUploadPayload = await oversizedInvalidUpload.json();
    assert.equal(oversizedInvalidUpload.status, 400);
    assert.equal(oversizedInvalidUploadPayload.error.code, "VALIDATION_ERROR");

    const uploadedReference = await post(
      baseUrl,
      "/api/uploads/reference-images",
      {
        fileName: "reference.png",
        mimeType: "image/png",
        contentBase64: onePixelPngBase64
      },
      demoSession
    );
    const duplicateReference = await post(
      baseUrl,
      "/api/uploads/reference-images",
      {
        fileName: "reference-copy.png",
        mimeType: "image/png",
        contentBase64: onePixelPngBase64
      },
      demoSession
    );
    assert.equal(uploadedReference.data.referenceImage.width, 1);
    assert.equal(uploadedReference.data.referenceImage.height, 1);
    assert.equal(duplicateReference.data.duplicate, true);
    assert.equal(duplicateReference.data.referenceImage.id, uploadedReference.data.referenceImage.id);

    const otherUser = await register(baseUrl, {
      email: `intruder-${crypto.randomUUID()}@imagora.local`,
      password: "Intruder123!"
    });
    const otherUserSession = otherUser.session;
    const forbiddenAdminUsers = await fetch(`${baseUrl}/api/admin/users`, {
      headers: {
        Cookie: demoSession
      }
    });
    const forbiddenAdminUsersPayload = await forbiddenAdminUsers.json();
    assert.equal(forbiddenAdminUsers.status, 403);
    assert.equal(forbiddenAdminUsersPayload.error.code, "FORBIDDEN");

    const foreignReferenceUse = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: otherUserSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        referenceImageId: uploadedReference.data.referenceImage.id,
        prompt: "Use another user reference",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      })
    });
    const foreignReferencePayload = await foreignReferenceUse.json();
    assert.equal(foreignReferenceUse.status, 404);
    assert.equal(foreignReferencePayload.error.code, "NOT_FOUND");

    const startingCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const clientRequestId = crypto.randomUUID();
    const generationPayload = {
      clientRequestId,
      referenceImageId: uploadedReference.data.referenceImage.id,
      prompt: "A clean isometric creative dashboard",
      negativePrompt: "low quality",
      style: "illustration",
      aspectRatio: "1:1",
      quantity: 1,
      quality: "draft",
      model: "gpt-image-2"
    };
    const created = await post(baseUrl, "/api/generation/tasks", generationPayload, demoSession);
    const duplicateCreated = await post(baseUrl, "/api/generation/tasks", generationPayload, demoSession);

    assert.equal(duplicateCreated.data.task.id, created.data.task.id);
    assert.equal(created.data.task.referenceImageId, uploadedReference.data.referenceImage.id);
    assert.equal(created.data.task.modelProvider, "mock");
    assert.equal(created.data.task.modelName, "mock:default");
    assert.equal(duplicateCreated.data.balanceAfter, created.data.balanceAfter);
    assert.equal(created.data.balanceAfter, startingCredits.data.account.balance - created.data.task.creditCost);

    const taskId = created.data.task.id;
    const completed = await waitForTask(baseUrl, demoSession, taskId);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.task.modelProvider, "mock");
    assert.equal(completed.data.task.modelName, "mock:default");
    assert.equal(completed.data.images.length, 1);
    const generatedImageId = completed.data.images[0].id;
    assert.equal(completed.data.images[0].publicUrl, "");
    assert.deepEqual(completed.data.images[0].generationMetadata, {
      taskId,
      prompt: generationPayload.prompt,
      negativePrompt: generationPayload.negativePrompt,
      style: generationPayload.style,
      aspectRatio: generationPayload.aspectRatio,
      quality: generationPayload.quality,
      quantity: generationPayload.quantity,
      modelProvider: "mock",
      modelName: "mock:default",
      width: completed.data.task.width,
      height: completed.data.task.height,
      creditCost: completed.data.task.creditCost,
      createdAt: completed.data.task.createdAt
    });
    assert.equal(completed.data.images[0].projectId, null);

    const projectCreated = await post(
      baseUrl,
      "/api/image-projects",
      {
        name: "品牌视觉资产",
        description: "用于管理已确认可复用的品牌生成图"
      },
      demoSession
    );
    assert.equal(projectCreated.data.project.name, "品牌视觉资产");
    assert.equal(projectCreated.data.project.description, "用于管理已确认可复用的品牌生成图");
    assert.equal(projectCreated.data.project.archivedAt, null);
    assert.equal(projectCreated.data.project.imageCount, 0);

    const movedToProject = await post(
      baseUrl,
      `/api/images/${generatedImageId}/project`,
      { projectId: projectCreated.data.project.id },
      demoSession
    );
    assert.equal(movedToProject.data.image.projectId, projectCreated.data.project.id);

    const projectImages = await get(
      baseUrl,
      `/api/images?projectId=${projectCreated.data.project.id}&limit=50`,
      demoSession
    );
    assert.deepEqual(
      projectImages.data.images.map((image) => image.id),
      [generatedImageId]
    );
    assert.equal(projectImages.data.images[0].generationMetadata.prompt, generationPayload.prompt);

    const projectUpdated = await patch(
      baseUrl,
      `/api/image-projects/${projectCreated.data.project.id}`,
      { name: "品牌主视觉", coverImageId: generatedImageId },
      demoSession
    );
    assert.equal(projectUpdated.data.project.name, "品牌主视觉");
    assert.equal(projectUpdated.data.project.coverImageId, generatedImageId);
    assert.equal(projectUpdated.data.project.imageCount, 1);

    const projectList = await get(baseUrl, "/api/image-projects", demoSession);
    assert.ok(projectList.data.projects.some((project) => project.id === projectCreated.data.project.id));
    assert.equal(
      projectList.data.projects.find((project) => project.id === projectCreated.data.project.id).imageCount,
      1
    );

    const foreignMove = await fetch(`${baseUrl}/api/images/${generatedImageId}/project`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: otherUserSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({ projectId: projectCreated.data.project.id })
    });
    const foreignMovePayload = await foreignMove.json();
    assert.equal(foreignMove.status, 404);
    assert.equal(foreignMovePayload.error.code, "NOT_FOUND");

    const archivedProject = await deleteRequest(
      baseUrl,
      `/api/image-projects/${projectCreated.data.project.id}`,
      demoSession
    );
    assert.equal(archivedProject.data.archived, true);
    const projectsAfterArchive = await get(baseUrl, "/api/image-projects", demoSession);
    assert.equal(
      projectsAfterArchive.data.projects.some((project) => project.id === projectCreated.data.project.id),
      false
    );

    const previewUrl = await post(baseUrl, `/api/images/${generatedImageId}/preview-url`, {}, demoSession);
    assert.match(previewUrl.data.url, /^data:image\/svg\+xml/);
    assert.ok(previewUrl.data.expiresAt);

    const downloadUrl = await post(baseUrl, `/api/images/${generatedImageId}/download-url`, {}, demoSession);
    assert.match(downloadUrl.data.url, /^mock-signed:\/\//);
    assert.match(downloadUrl.data.fileName, /^imagora-.+\.svg$/);
    assert.ok(downloadUrl.data.expiresAt);
    const foreignDownload = await fetch(`${baseUrl}/api/images/${generatedImageId}/download-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: otherUserSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({})
    });
    const foreignDownloadPayload = await foreignDownload.json();
    assert.equal(foreignDownload.status, 404);
    assert.equal(foreignDownloadPayload.error.code, "NOT_FOUND");
    const foreignPreview = await fetch(`${baseUrl}/api/images/${generatedImageId}/preview-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: otherUserSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({})
    });
    const foreignPreviewPayload = await foreignPreview.json();
    assert.equal(foreignPreview.status, 404);
    assert.equal(foreignPreviewPayload.error.code, "NOT_FOUND");
    const foreignFavoriteRemoval = await fetch(`${baseUrl}/api/images/${generatedImageId}/favorite`, {
      method: "DELETE",
      headers: {
        Cookie: otherUserSession,
        Origin: defaultWriteOrigin
      }
    });
    const foreignFavoriteRemovalPayload = await foreignFavoriteRemoval.json();
    assert.equal(foreignFavoriteRemoval.status, 404);
    assert.equal(foreignFavoriteRemovalPayload.error.code, "NOT_FOUND");

    const beforeFailedCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const failedCreated = await post(
      baseUrl,
      "/api/generation/tasks",
      {
        clientRequestId: crypto.randomUUID(),
        prompt: "A mock provider fail scenario",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      },
      demoSession
    );
    const failed = await waitForTask(baseUrl, demoSession, failedCreated.data.task.id);
    assert.equal(failed.data.task.status, "FAILED");
    assert.equal(failed.data.task.failureCode, "PROVIDER_FAILED");

    const afterFailedCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(afterFailedCredits.data.account.balance, beforeFailedCredits.data.account.balance);

    await forceStaleRunningTask(storePath, failedCreated.data.task.id);
    const failedAgain = await waitForTask(baseUrl, demoSession, failedCreated.data.task.id);
    assert.equal(failedAgain.data.task.status, "FAILED");

    const storeAfterRefund = await readStore(storePath);
    assert.equal(
      storeAfterRefund.creditLedgerEntries.filter(
        (entry) => entry.sourceId === failedCreated.data.task.id && entry.type === "REFUND"
      ).length,
      1
    );
    assert.equal(
      storeAfterRefund.creditLedgerEntries.filter(
        (entry) => entry.sourceId === failedCreated.data.task.id && entry.type === "SPEND"
      ).length,
      1
    );

    const beforePaymentCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const missingOrderClientRequestId = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({ planId: "starter", paymentProvider: "mock" })
    });
    const missingOrderClientRequestPayload = await missingOrderClientRequestId.json();
    assert.equal(missingOrderClientRequestId.status, 400);
    assert.equal(missingOrderClientRequestPayload.error.code, "VALIDATION_ERROR");

    const orderClientRequestId = crypto.randomUUID();
    const orderCreated = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: orderClientRequestId },
      demoSession
    );
    const duplicateOrderCreate = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: orderClientRequestId },
      demoSession
    );
    assert.equal(duplicateOrderCreate.data.order.id, orderCreated.data.order.id);
    const conflictingOrderCreate = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({ planId: "creator", paymentProvider: "mock", clientRequestId: orderClientRequestId })
    });
    const conflictingOrderPayload = await conflictingOrderCreate.json();
    assert.equal(conflictingOrderCreate.status, 409);
    assert.equal(conflictingOrderPayload.error.code, "CONFLICT");

    const sharedOrderClientRequestId = crypto.randomUUID();
    const demoSharedOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: sharedOrderClientRequestId },
      demoSession
    );
    const otherSharedOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: sharedOrderClientRequestId },
      otherUserSession
    );
    assert.notEqual(otherSharedOrder.data.order.id, demoSharedOrder.data.order.id);
    const demoSharedRetry = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: sharedOrderClientRequestId },
      demoSession
    );
    assert.equal(demoSharedRetry.data.order.id, demoSharedOrder.data.order.id);

    const providerEventId = `evt_${crypto.randomUUID()}`;
    const webhookPayload = {
      providerEventId,
      orderId: orderCreated.data.order.id,
      orderNo: orderCreated.data.order.orderNo,
      amountCents: orderCreated.data.order.amountCents,
      currency: orderCreated.data.order.currency
    };
    const webhookPaid = await post(baseUrl, "/api/payments/webhooks/mock", webhookPayload);
    const webhookDuplicate = await post(baseUrl, "/api/payments/webhooks/mock", webhookPayload);

    assert.equal(webhookPaid.data.credited, true);
    assert.equal(webhookPaid.data.duplicateEvent, false);
    assert.equal(webhookPaid.data.order.status, "PAID");
    assert.equal(
      webhookPaid.data.balanceAfter,
      beforePaymentCredits.data.account.balance + orderCreated.data.plan.credits
    );
    assert.equal(webhookDuplicate.data.credited, false);
    assert.equal(webhookDuplicate.data.duplicateEvent, true);
    assert.equal(webhookDuplicate.data.balanceAfter, webhookPaid.data.balanceAfter);

    const beforeMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const mismatchOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const mismatchWebhook = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: mismatchOrder.data.order.id,
      orderNo: mismatchOrder.data.order.orderNo,
      amountCents: mismatchOrder.data.order.amountCents + 1,
      currency: mismatchOrder.data.order.currency
    });
    const afterMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(mismatchWebhook.data.credited, false);
    assert.equal(mismatchWebhook.data.reason, "AMOUNT_MISMATCH");
    assert.equal(mismatchWebhook.data.order.status, "PENDING");
    assert.equal(afterMismatchCredits.data.account.balance, beforeMismatchCredits.data.account.balance);

    const beforeCurrencyMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const currencyMismatchOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const currencyMismatchWebhook = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: currencyMismatchOrder.data.order.id,
      orderNo: currencyMismatchOrder.data.order.orderNo,
      amountCents: currencyMismatchOrder.data.order.amountCents,
      currency: "EUR"
    });
    const afterCurrencyMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(currencyMismatchWebhook.data.credited, false);
    assert.equal(currencyMismatchWebhook.data.reason, "CURRENCY_MISMATCH");
    assert.equal(currencyMismatchWebhook.data.order.status, "PENDING");
    assert.equal(afterCurrencyMismatchCredits.data.account.balance, beforeCurrencyMismatchCredits.data.account.balance);

    const beforeOrderNoMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const orderNoMismatchOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const orderNoMismatchWebhook = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: orderNoMismatchOrder.data.order.id,
      orderNo: "IM-TAMPERED-ORDER-NO",
      amountCents: orderNoMismatchOrder.data.order.amountCents,
      currency: orderNoMismatchOrder.data.order.currency
    });
    const afterOrderNoMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(orderNoMismatchWebhook.data.credited, false);
    assert.equal(orderNoMismatchWebhook.data.reason, "ORDER_NO_MISMATCH");
    assert.equal(orderNoMismatchWebhook.data.order.status, "PENDING");
    assert.equal(afterOrderNoMismatchCredits.data.account.balance, beforeOrderNoMismatchCredits.data.account.balance);

    const storeAfterPayment = await readStore(storePath);
    assert.equal(
      storeAfterPayment.paymentEvents.filter((event) => event.providerEventId === providerEventId).length,
      1
    );
    assert.equal(
      storeAfterPayment.creditLedgerEntries.filter(
        (entry) =>
          entry.sourceId === orderCreated.data.order.id &&
          entry.idempotencyKey === `order-grant:${orderCreated.data.order.id}`
      ).length,
      1
    );

    const admin = await login(baseUrl, "admin@imagora.local", "Admin123!");
    const adminSession = admin.session;

    await removeOrderCreditGrant(storePath, orderCreated.data.order.id);
    const corruptedPaymentCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(
      corruptedPaymentCredits.data.account.balance,
      webhookPaid.data.balanceAfter - orderCreated.data.plan.credits
    );

    const paidOrderReconciliation = await post(
      baseUrl,
      "/api/admin/maintenance/reconcile",
      { reason: "补发已支付订单积分" },
      adminSession
    );
    assert.equal(paidOrderReconciliation.data.maintenance.reconciledPaidOrders, 1);
    const restoredPaymentCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(restoredPaymentCredits.data.account.balance, webhookPaid.data.balanceAfter);
    const storeAfterPaidOrderReconcile = await readStore(storePath);
    assert.equal(
      storeAfterPaidOrderReconcile.creditLedgerEntries.filter(
        (entry) =>
          entry.sourceId === orderCreated.data.order.id &&
          entry.idempotencyKey === `order-grant:${orderCreated.data.order.id}`
      ).length,
      1
    );
    assert.ok(
      storeAfterPaidOrderReconcile.adminAuditLogs.some(
        (entry) => entry.action === "maintenance.reconcile" && entry.reason === "补发已支付订单积分"
      )
    );

    const duplicateReconciliation = await post(
      baseUrl,
      "/api/admin/maintenance/reconcile",
      { reason: "确认没有重复补发" },
      adminSession
    );
    assert.equal(duplicateReconciliation.data.maintenance.reconciledPaidOrders, 0);

    const eventBackfillOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const beforeEventBackfillCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    await seedSucceededPaymentEvent(
      storePath,
      eventBackfillOrder.data.order.id,
      `evt_${crypto.randomUUID()}`,
      eventBackfillOrder.data.order.amountCents
    );
    const eventBackfillReconciliation = await post(
      baseUrl,
      "/api/admin/maintenance/reconcile",
      { reason: "回补漏记支付事件" },
      adminSession
    );
    assert.equal(eventBackfillReconciliation.data.maintenance.reconciledPaymentEvents, 1);
    assert.equal(eventBackfillReconciliation.data.maintenance.reconciledPaidOrders, 1);
    const afterEventBackfillCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(
      afterEventBackfillCredits.data.account.balance,
      beforeEventBackfillCredits.data.account.balance + eventBackfillOrder.data.plan.credits
    );

    const expiredOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    await markOrderExpired(storePath, expiredOrder.data.order.id);
    const ordersAfterExpiry = await get(baseUrl, "/api/orders", demoSession);
    assert.ok(ordersAfterExpiry.data.maintenance.closedExpiredOrders >= 1);
    const expiredAfterMaintenance = ordersAfterExpiry.data.orders.find(
      (order) => order.id === expiredOrder.data.order.id
    );
    assert.ok(expiredAfterMaintenance);
    assert.equal(expiredAfterMaintenance.status, "CLOSED");
    const closedPay = await fetch(`${baseUrl}/api/orders/${expiredOrder.data.order.id}/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({})
    });
    const closedPayPayload = await closedPay.json();
    assert.equal(closedPay.status, 400);
    assert.equal(closedPayPayload.error.code, "ORDER_NOT_PAYABLE");

    const lateWebhookOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const beforeLateWebhookCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    await markOrderExpired(storePath, lateWebhookOrder.data.order.id);
    await get(baseUrl, "/api/orders", demoSession);
    const lateWebhookPaid = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: lateWebhookOrder.data.order.id,
      orderNo: lateWebhookOrder.data.order.orderNo,
      amountCents: lateWebhookOrder.data.order.amountCents,
      currency: lateWebhookOrder.data.order.currency
    });
    assert.equal(lateWebhookPaid.data.credited, true);
    assert.equal(lateWebhookPaid.data.order.status, "PAID");
    assert.equal(
      lateWebhookPaid.data.balanceAfter,
      beforeLateWebhookCredits.data.account.balance + lateWebhookOrder.data.plan.credits
    );

    const adminUserSearch = await get(baseUrl, "/api/admin/users?search=demo%40imagora.local&limit=5", adminSession);
    assert.ok(adminUserSearch.data.users.some((user) => user.id === demo.data.user.id));

    const suspendedUser = await patch(
      baseUrl,
      `/api/admin/users/${otherUser.data.user.id}/status`,
      { status: "SUSPENDED", reason: "账号异常需要暂停" },
      adminSession
    );
    assert.equal(suspendedUser.data.user.status, "SUSPENDED");
    const suspendedUsers = await get(baseUrl, "/api/admin/users?status=SUSPENDED&limit=10", adminSession);
    assert.ok(suspendedUsers.data.users.some((user) => user.id === otherUser.data.user.id));
    assert.ok(suspendedUsers.data.users.every((user) => user.status === "SUSPENDED"));
    await patch(
      baseUrl,
      `/api/admin/users/${otherUser.data.user.id}/status`,
      { status: "ACTIVE", reason: "确认恢复正常使用" },
      adminSession
    );

    const beforeAdminAdjustment = await get(baseUrl, "/api/users/me/credits", demoSession);
    const adjustRequestId = "qa-adjust-idem-0001";
    const adjustedCredits = await post(
      baseUrl,
      `/api/admin/users/${demo.data.user.id}/credits/adjust`,
      { amount: 17, reason: "QA manual adjustment", clientRequestId: adjustRequestId },
      adminSession
    );
    assert.equal(adjustedCredits.data.account.balance, beforeAdminAdjustment.data.account.balance + 17);
    const ledgerAfterAdjustment = await get(baseUrl, "/api/users/me/credit-ledger?limit=100", demoSession);
    assert.ok(
      ledgerAfterAdjustment.data.entries.some(
        (entry) =>
          entry.type === "ADJUST" &&
          entry.amount === 17 &&
          entry.balanceAfter === adjustedCredits.data.account.balance &&
          entry.remark === "QA manual adjustment"
      )
    );

    // 重复提交同一 clientRequestId 不得叠加扣加积分，也不得重复写审计
    const replayedAdjustment = await post(
      baseUrl,
      `/api/admin/users/${demo.data.user.id}/credits/adjust`,
      { amount: 17, reason: "QA manual adjustment", clientRequestId: adjustRequestId },
      adminSession
    );
    assert.equal(replayedAdjustment.data.account.balance, adjustedCredits.data.account.balance);
    const ledgerAfterReplay = await get(baseUrl, "/api/users/me/credit-ledger?limit=100", demoSession);
    const adjustEntriesForKey = ledgerAfterReplay.data.entries.filter(
      (entry) => entry.type === "ADJUST" && entry.amount === 17 && entry.remark === "QA manual adjustment"
    );
    assert.equal(adjustEntriesForKey.length, 1);
    const adjustAuditLogs = await get(
      baseUrl,
      `/api/admin/audit-logs?action=user.credits.adjust&targetId=${demo.data.user.id}&limit=100`,
      adminSession
    );
    assert.equal(adjustAuditLogs.data.logs.filter((log) => log.reason === "QA manual adjustment").length, 1);

    const createdPlan = await post(
      baseUrl,
      "/api/admin/plans",
      {
        name: "QA Pack",
        description: "Automated admin plan",
        priceCents: 1234,
        currency: "CNY",
        credits: 345,
        validDays: 45,
        status: "ACTIVE",
        sortOrder: 77,
        reason: "新增测试套餐"
      },
      adminSession
    );
    assert.equal(createdPlan.data.plan.status, "ACTIVE");
    const publicPlansAfterCreate = await get(baseUrl, "/api/plans", demoSession);
    assert.ok(publicPlansAfterCreate.data.plans.some((plan) => plan.id === createdPlan.data.plan.id));

    const disabledPlan = await patch(
      baseUrl,
      `/api/admin/plans/${createdPlan.data.plan.id}`,
      { priceCents: 1599, credits: 420, status: "INACTIVE", sortOrder: 8, reason: "更新套餐定价" },
      adminSession
    );
    assert.equal(disabledPlan.data.plan.priceCents, 1599);
    assert.equal(disabledPlan.data.plan.credits, 420);
    assert.equal(disabledPlan.data.plan.status, "INACTIVE");
    const publicPlansAfterDisable = await get(baseUrl, "/api/plans", demoSession);
    assert.ok(!publicPlansAfterDisable.data.plans.some((plan) => plan.id === createdPlan.data.plan.id));
    const reactivatedPlan = await patch(
      baseUrl,
      `/api/admin/plans/${createdPlan.data.plan.id}`,
      { status: "ACTIVE", reason: "恢复套餐售卖" },
      adminSession
    );
    assert.equal(reactivatedPlan.data.plan.status, "ACTIVE");

    const succeededTasks = await get(baseUrl, "/api/admin/generation/tasks?status=SUCCEEDED&limit=5", adminSession);
    assert.ok(succeededTasks.data.tasks.some((task) => task.id === taskId));
    assert.ok(succeededTasks.data.tasks.every((task) => task.status === "SUCCEEDED"));

    const adminTaskDetail = await get(baseUrl, `/api/admin/generation/tasks/${taskId}`, adminSession);
    assert.equal(adminTaskDetail.data.task.id, taskId);
    assert.equal(adminTaskDetail.data.user.id, demo.data.user.id);
    assert.ok(adminTaskDetail.data.images.some((image) => image.id === generatedImageId));

    const futureCreatedFrom = encodeURIComponent("2999-01-01T00:00:00.000Z");
    const futureTasks = await get(
      baseUrl,
      `/api/admin/generation/tasks?status=SUCCEEDED&userId=${demo.data.user.id}&createdFrom=${futureCreatedFrom}&limit=10`,
      adminSession
    );
    assert.equal(futureTasks.data.tasks.length, 0);

    const paidOrders = await get(baseUrl, "/api/admin/orders?status=PAID&limit=10", adminSession);
    assert.ok(paidOrders.data.orders.every((order) => order.status === "PAID"));

    const paidOrderByNumber = await get(
      baseUrl,
      `/api/admin/orders?status=PAID&userId=${demo.data.user.id}&orderNo=${encodeURIComponent(orderCreated.data.order.orderNo)}&limit=20`,
      adminSession
    );
    assert.deepEqual(
      paidOrderByNumber.data.orders.map((order) => order.id),
      [orderCreated.data.order.id]
    );

    const adminOrderDetail = await get(baseUrl, `/api/admin/orders/${orderCreated.data.order.id}`, adminSession);
    assert.equal(adminOrderDetail.data.order.id, orderCreated.data.order.id);
    assert.equal(adminOrderDetail.data.user.id, demo.data.user.id);
    assert.equal(adminOrderDetail.data.plan.id, orderCreated.data.plan.id);

    const hiddenImage = await patch(
      baseUrl,
      `/api/admin/images/${generatedImageId}/visibility`,
      { visibility: "HIDDEN", reason: "隐藏测试图片" },
      adminSession
    );
    assert.equal(hiddenImage.data.image.visibility, "HIDDEN");
    const hiddenImages = await get(baseUrl, "/api/admin/images?visibility=HIDDEN&limit=10", adminSession);
    assert.ok(hiddenImages.data.images.some((image) => image.id === generatedImageId));
    assert.ok(hiddenImages.data.images.every((image) => image.visibility === "HIDDEN"));
    const adminImageDetail = await get(baseUrl, `/api/admin/images/${generatedImageId}`, adminSession);
    assert.equal(adminImageDetail.data.image.id, generatedImageId);
    assert.equal(adminImageDetail.data.user.id, demo.data.user.id);
    assert.equal(adminImageDetail.data.task.id, taskId);
    const futureHiddenImages = await get(
      baseUrl,
      `/api/admin/images?visibility=HIDDEN&userId=${demo.data.user.id}&createdFrom=${futureCreatedFrom}&limit=10`,
      adminSession
    );
    assert.equal(futureHiddenImages.data.images.length, 0);
    const visibleImagesAfterHide = await get(baseUrl, "/api/images?limit=50", demoSession);
    assert.ok(!visibleImagesAfterHide.data.images.some((image) => image.id === generatedImageId));

    const selfSuspend = await fetch(`${baseUrl}/api/admin/users/${admin.data.user.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({ status: "SUSPENDED", reason: "防止误封自己" })
    });
    const selfSuspendPayload = await selfSuspend.json();
    assert.equal(selfSuspend.status, 400);
    assert.equal(selfSuspendPayload.error.code, "VALIDATION_ERROR");

    const auditLogs = await get(baseUrl, "/api/admin/audit-logs", adminSession);
    for (const action of [
      "user.status.update",
      "user.credits.adjust",
      "plan.create",
      "plan.update",
      "image.visibility.update"
    ]) {
      assert.ok(
        auditLogs.data.logs.some((entry) => entry.action === action),
        `Missing audit action: ${action}`
      );
    }
    for (const [action, reason] of [
      ["maintenance.reconcile", "补发已支付订单积分"],
      ["maintenance.reconcile", "回补漏记支付事件"],
      ["user.status.update", "确认恢复正常使用"],
      ["user.credits.adjust", "QA manual adjustment"],
      ["plan.create", "新增测试套餐"],
      ["plan.update", "恢复套餐售卖"],
      ["image.visibility.update", "隐藏测试图片"]
    ]) {
      assert.ok(
        auditLogs.data.logs.some((entry) => entry.action === action && entry.reason === reason),
        `Missing audit reason for ${action}: ${reason}`
      );
    }
    const imageAuditLogs = await get(
      baseUrl,
      `/api/admin/audit-logs?action=image.visibility.update&targetType=IMAGE&targetId=${generatedImageId}&limit=20`,
      adminSession
    );
    assert.ok(imageAuditLogs.data.logs.length >= 1);
    assert.ok(
      imageAuditLogs.data.logs.every(
        (entry) =>
          entry.action === "image.visibility.update" &&
          entry.targetType === "IMAGE" &&
          entry.targetId === generatedImageId
      )
    );

    const metrics = await get(baseUrl, "/api/admin/metrics", adminSession);
    assert.ok(metrics.data.http.requestsTotal > 0);
    assert.ok(metrics.data.domain.tasksByStatus.SUCCEEDED >= 1);
    assert.ok(metrics.data.domain.generationFailureRate > 0);
    assert.ok(metrics.data.domain.averageQueueWaitMs >= 0);
    assert.ok(metrics.data.domain.referenceImagesTotal >= 1);
    assert.ok(metrics.data.domain.paymentEventsTotal >= 2);
    assert.ok(metrics.data.domain.paymentFailuresTotal >= 3);
    assert.ok(metrics.data.domain.refundFailuresTotal >= 0);
    assert.ok(metrics.data.alerts.some((alert) => alert.id === "generation.failure-rate"));
    assert.ok(metrics.data.alerts.some((alert) => alert.id === "payments.amount-mismatch"));
    assert.ok(
      metrics.data.alertNotifications.some(
        (notification) =>
          notification.alertId === "generation.failure-rate" &&
          notification.channel === "local" &&
          notification.status === "SENT"
      )
    );
    assert.ok(
      metrics.data.alertNotifications.some(
        (notification) =>
          notification.alertId === "payments.amount-mismatch" &&
          notification.channel === "local" &&
          notification.status === "SENT"
      )
    );
    const generationIncident = metrics.data.recentIncidents.find(
      (incident) => incident.taskId === failedCreated.data.task.id && incident.errorCode === "PROVIDER_FAILED"
    );
    assert.ok(generationIncident);
    assert.equal(generationIncident.area, "generation");
    assert.equal(generationIncident.status, "OPEN");
    assert.equal(generationIncident.errorCode, "PROVIDER_FAILED");
    assert.equal(generationIncident.userId, demo.data.user.id);
    const paymentIncident = metrics.data.recentIncidents.find(
      (incident) => incident.orderId === mismatchOrder.data.order.id
    );
    assert.ok(paymentIncident);
    assert.equal(paymentIncident.area, "payments");
    assert.equal(paymentIncident.status, "OPEN");
    assert.equal(paymentIncident.errorCode, "AMOUNT_MISMATCH");
    assert.equal(paymentIncident.requestId, mismatchWebhook.requestId);
    assert.equal(JSON.stringify(metrics.data.recentIncidents).includes("Demo123!"), false);
    assert.equal(JSON.stringify(metrics.data.recentIncidents).includes("Admin123!"), false);
    assert.equal(JSON.stringify(selfSuspendPayload).includes("stack"), false);

    await post(
      baseUrl,
      "/api/admin/safety-rules",
      { term: "blockedtest", action: "BLOCK", status: "ACTIVE" },
      adminSession
    );
    const blocked = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
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

    await post(
      baseUrl,
      "/api/admin/safety-rules",
      { term: "reviewtest", action: "REVIEW", status: "ACTIVE" },
      adminSession
    );
    const reviewRequired = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        prompt: "reviewtest creative brief",
        style: "poster",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "draft"
      })
    });
    const reviewRequiredPayload = await reviewRequired.json();
    assert.equal(reviewRequired.status, 400);
    assert.equal(reviewRequiredPayload.error.code, "CONTENT_REVIEW_REQUIRED");
    assert.equal(reviewRequiredPayload.error.details.status, "REVIEW_REQUIRED");

    const reviewQueue = await get(baseUrl, "/api/admin/safety-events?status=REVIEW_REQUIRED&limit=10", adminSession);
    const reviewEvent = reviewQueue.data.events.find((event) => event.reasonCode === "LOCAL_REVIEW_HIT");
    assert.ok(reviewEvent, `Missing review event in ${JSON.stringify(reviewQueue.data.events)}`);
    assert.equal(reviewEvent.status, "REVIEW_REQUIRED");
    assert.equal(reviewEvent.provider, "local-rules");

    const submittedAppeal = await post(
      baseUrl,
      "/api/safety-appeals",
      { safetyEventId: reviewEvent.id, reason: "这是合规产品海报测试内容，请人工复核误判。" },
      demoSession
    );
    assert.equal(submittedAppeal.data.appeal.status, "PENDING");
    assert.equal(submittedAppeal.data.appeal.safetyEventId, reviewEvent.id);

    const duplicateAppeal = await fetch(`${baseUrl}/api/safety-appeals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        safetyEventId: reviewEvent.id,
        reason: "重复提交同一个待处理申诉应该被拒绝。"
      })
    });
    const duplicateAppealPayload = await duplicateAppeal.json();
    assert.equal(duplicateAppeal.status, 409);
    assert.equal(duplicateAppealPayload.error.code, "CONFLICT");

    const ownAppeals = await get(baseUrl, "/api/safety-appeals", demoSession);
    assert.ok(ownAppeals.data.appeals.some((appeal) => appeal.id === submittedAppeal.data.appeal.id));

    const pendingAppeals = await get(baseUrl, "/api/admin/safety-appeals?status=PENDING&limit=10", adminSession);
    assert.ok(pendingAppeals.data.appeals.some((appeal) => appeal.id === submittedAppeal.data.appeal.id));

    const reviewedAppeal = await patch(
      baseUrl,
      `/api/admin/safety-appeals/${submittedAppeal.data.appeal.id}`,
      { status: "APPROVED", adminNote: "确认是误判，允许后续调整提示词重试。" },
      adminSession
    );
    assert.equal(reviewedAppeal.data.appeal.status, "APPROVED");
    assert.ok(reviewedAppeal.data.appeal.resolvedAt);

    const appealAuditLogs = await get(
      baseUrl,
      `/api/admin/audit-logs?action=safety-appeal.review&targetType=SAFETY_APPEAL&targetId=${submittedAppeal.data.appeal.id}&limit=5`,
      adminSession
    );
    assert.ok(appealAuditLogs.data.logs.some((entry) => entry.reason === "确认是误判，允许后续调整提示词重试。"));

    const reviewedEvent = await patch(
      baseUrl,
      `/api/admin/safety-events/${reviewEvent.id}`,
      { status: "PASSED", reason: "人工复核通过" },
      adminSession
    );
    assert.equal(reviewedEvent.data.event.status, "PASSED");
    const reviewAuditLogs = await get(
      baseUrl,
      `/api/admin/audit-logs?action=safety-event.review&targetType=SAFETY_EVENT&targetId=${reviewEvent.id}&limit=5`,
      adminSession
    );
    assert.ok(reviewAuditLogs.data.logs.some((entry) => entry.reason === "人工复核通过"));
  } finally {
    api.kill();
    worker.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api and worker complete generation with openai provider flow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-api-openai-"));
  const port = 4700 + Math.floor(Math.random() * 400);
  const storePath = join(dir, "store.json");
  const openAiServer = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "openai_req_split_1",
        output: {
          content: [{ type: "output_image", image_base64: onePixelPngBase64, mime_type: "image/png" }]
        }
      }
    },
    {
      status: 200,
      body: {
        id: "openai_req_split_2",
        output: {
          content: [
            { type: "output_text", text: "ignore this block" },
            { type: "output_image", result: `data:image/png;base64,${onePixelPngBase64}` }
          ]
        }
      }
    }
  ]);
  await openAiServer.listen();
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
    QUEUE_PROVIDER: "inline",
    IMAGE_PROVIDER_DEFAULT: "openai",
    IMAGE_MODEL_DEFAULT: "openai:gpt-image-2",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: `http://127.0.0.1:${openAiServer.port}`,
    OPENAI_TIMEOUT_MS: "1000",
    OPENAI_MAX_RETRIES: "0",
    OPENAI_RETRY_BASE_MS: "10"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });
  const worker = spawn(process.execPath, ["apps/worker/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const demoSession = demo.session;
    const startingCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const clientRequestId = crypto.randomUUID();
    const created = await post(
      baseUrl,
      "/api/generation/tasks",
      {
        clientRequestId,
        prompt: "A realistic product showcase on a white studio background",
        style: "product_photography",
        aspectRatio: "1:1",
        quantity: 2,
        quality: "standard"
      },
      demoSession
    );

    assert.equal(created.data.task.modelProvider, "openai");
    assert.equal(created.data.task.modelName, "openai:gpt-image-2");
    assert.equal(created.data.task.quantity, 2);
    assert.equal(created.data.balanceAfter, startingCredits.data.account.balance - created.data.task.creditCost);

    const completed = await waitForTask(baseUrl, demoSession, created.data.task.id);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.task.modelProvider, "openai");
    assert.equal(completed.data.task.modelName, "openai:gpt-image-2");
    assert.equal(completed.data.images.length, 2);
    for (const image of completed.data.images) {
      assert.equal(image.mimeType, "image/png");
      assert.match(image.storageKey, /\.png$/);
      assert.match(image.thumbnailKey, /-thumb\.jpg$/);
      assert.match(image.thumbnailUrl, /^data:image\/jpeg;base64,/);
      assert.notEqual(image.thumbnailUrl, image.publicUrl);
    }

    assert.equal(openAiServer.requests.length, 2);
    for (const request of openAiServer.requests) {
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/images/generations");
      assert.match(request.authorization ?? "", /^Bearer sk-test$/);
      const body = JSON.parse(request.body);
      assert.equal(body.model, "gpt-image-2");
      assert.equal(body.n, 1);
      assert.equal(body.output_format, "png");
      assert.equal(body.size, "1024x1024");
      assert.equal(body.quality, "medium");
      assert.match(body.prompt, /A realistic product showcase/);
      assert.match(body.prompt, /Style: product photography/);
      assert.match(body.prompt, /Aspect ratio: 1:1/);
    }

    const download = await post(baseUrl, `/api/images/${completed.data.images[0].id}/download-url`, {}, demoSession);
    assert.match(download.data.url, /^mock-signed:\/\//);
    assert.match(download.data.fileName, /\.png$/);

    const preview = await post(baseUrl, `/api/images/${completed.data.images[0].id}/preview-url`, {}, demoSession);
    assert.match(preview.data.url, /^data:image\/png;base64,/);
    assert.notEqual(preview.data.url, completed.data.images[0].thumbnailUrl);
  } finally {
    api.kill();
    worker.kill();
    await openAiServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation task status stays responsive while openai generation is still running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-api-openai-running-"));
  const port = await reserveUnusedPort();
  const storePath = join(dir, "store.json");
  const openAiServer = createFakeOpenAiServer([
    {
      delayMs: 2500,
      status: 200,
      body: {
        id: "openai_req_slow_1",
        data: [{ b64_json: onePixelPngBase64 }]
      }
    }
  ]);
  await openAiServer.listen();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    IMAGORA_STORE_PATH: storePath,
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    ORDER_PENDING_TTL_MINUTES: "30",
    WORKER_POLL_INTERVAL_MS: "100",
    QUEUE_PROVIDER: "inline",
    IMAGE_PROVIDER_DEFAULT: "openai",
    IMAGE_MODEL_DEFAULT: "openai:gpt-image-2",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: `http://127.0.0.1:${openAiServer.port}`,
    OPENAI_TIMEOUT_MS: "10000",
    OPENAI_MAX_RETRIES: "0",
    OPENAI_RETRY_BASE_MS: "10"
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
        prompt: "A realistic portrait photo with natural daylight",
        style: "realistic",
        aspectRatio: "1:1",
        quantity: 1,
        quality: "standard"
      },
      demo.session
    );

    await waitForCondition(() => openAiServer.requests.length === 1, 3000, 50, "Worker did not reach OpenAI provider");

    const detailStartedAt = Date.now();
    const detailSnapshot = await fetchJsonWithTimeout(
      `${baseUrl}/api/generation/tasks/${created.data.task.id}`,
      { headers: sessionHeaders(demo.session) },
      1500
    );
    const detailElapsedMs = Date.now() - detailStartedAt;
    assert.equal(detailSnapshot.response.status, 200);
    assert.ok(detailElapsedMs < 1500, `Task detail request took ${detailElapsedMs}ms`);
    assert.equal(detailSnapshot.payload.data.task.status, "RUNNING");

    const listStartedAt = Date.now();
    const listSnapshot = await fetchJsonWithTimeout(
      `${baseUrl}/api/generation/tasks?limit=5`,
      { headers: sessionHeaders(demo.session) },
      1500
    );
    const listElapsedMs = Date.now() - listStartedAt;
    assert.equal(listSnapshot.response.status, 200);
    assert.ok(listElapsedMs < 1500, `Task list request took ${listElapsedMs}ms`);
    assert.equal(listSnapshot.payload.data.tasks[0].id, created.data.task.id);
    assert.equal(listSnapshot.payload.data.tasks[0].status, "RUNNING");

    const completed = await waitForTask(baseUrl, demo.session, created.data.task.id);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.images.length, 1);
  } finally {
    api.kill();
    worker.kill();
    await openAiServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api and worker share the same relative json store across different process cwd values", async () => {
  const port = await reserveUnusedPort();
  const relativeStorePath = join(".tmp-test-store", `cwd-split-${randomUUID()}`, "store.json");
  const absoluteStorePath = join(process.cwd(), relativeStorePath);
  const absoluteStoreRoot = dirname(absoluteStorePath);
  const apiLocalStorePath = join(process.cwd(), "apps", "api", relativeStorePath);
  const workerLocalStorePath = join(process.cwd(), "apps", "worker", relativeStorePath);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    ALLOW_BEARER_SESSION_AUTH: "false",
    DATA_STORE: "json",
    IMAGORA_STORE_PATH: relativeStorePath,
    IMAGORA_SEED_DEMO_DATA: "true",
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    ORDER_PENDING_TTL_MINUTES: "30",
    WORKER_POLL_INTERVAL_MS: "200",
    QUEUE_PROVIDER: "inline",
    IMAGE_PROVIDER_DEFAULT: "mock",
    STORAGE_PROVIDER: "inline",
    PAYMENT_PROVIDER: "mock",
    SAFETY_PROVIDER: "local"
  };
  const api = spawn(process.execPath, ["dist/main.js"], {
    cwd: join(process.cwd(), "apps", "api"),
    env,
    stdio: "ignore"
  });
  const worker = spawn(process.execPath, ["dist/main.js"], {
    cwd: join(process.cwd(), "apps", "worker"),
    env,
    stdio: "ignore"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const created = await post(
      baseUrl,
      "/api/generation/tasks",
      {
        clientRequestId: randomUUID(),
        prompt: "A realistic studio product photo with clean lighting",
        style: "product_photography",
        aspectRatio: "16:9",
        quantity: 1,
        quality: "standard"
      },
      demo.session
    );

    const completed = await waitForTask(baseUrl, demo.session, created.data.task.id);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.images.length, 1);

    const store = await readStore(absoluteStorePath);
    const storedTask = store.generationTasks.find((task) => task.id === created.data.task.id);
    assert.ok(storedTask);
    assert.equal(storedTask.status, "SUCCEEDED");
    assert.equal(await pathExists(apiLocalStorePath), false);
    assert.equal(await pathExists(workerLocalStorePath), false);
  } finally {
    api.kill();
    worker.kill();
    await rm(absoluteStoreRoot, { recursive: true, force: true });
    await rm(dirname(apiLocalStorePath), { recursive: true, force: true });
    await rm(dirname(workerLocalStorePath), { recursive: true, force: true });
  }
});

test("api wires stripe provider into checkout, webhook signing and credit grant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-api-stripe-"));
  const port = await reserveUnusedPort();
  const storePath = join(dir, "store.json");
  const origin = "http://127.0.0.1:3100";
  const stripeServer = createFakeStripeServer();
  await stripeServer.listen();
  const stripeSecret = "sk_test_local_e2e";
  const webhookSecret = "whsec_local_e2e";
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
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: stripeSecret,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_API_BASE_URL: `http://127.0.0.1:${stripeServer.port}`,
    STRIPE_SUCCESS_URL: `${origin}/orders?paid=1`,
    STRIPE_CANCEL_URL: `${origin}/pricing?canceled=1`,
    STRIPE_TIMEOUT_MS: "5000",
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: "300",
    WEB_ORIGIN: origin,
    CSRF_ALLOWED_ORIGINS: origin
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const demo = await login(baseUrl, "demo@imagora.local", "Demo123!");
    const demoSession = demo.session;

    const wrongProviderReject = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: origin
      },
      body: JSON.stringify({ planId: "starter", paymentProvider: "mock", clientRequestId: crypto.randomUUID() })
    });
    const wrongProviderPayload = await wrongProviderReject.json();
    assert.equal(wrongProviderReject.status, 400);
    assert.equal(wrongProviderPayload.error.code, "VALIDATION_ERROR");

    const missingStripeOrderClientRequestId = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession,
        Origin: origin
      },
      body: JSON.stringify({ planId: "starter", paymentProvider: "stripe" })
    });
    const missingStripeOrderClientRequestPayload = await missingStripeOrderClientRequestId.json();
    assert.equal(missingStripeOrderClientRequestId.status, 400);
    assert.equal(missingStripeOrderClientRequestPayload.error.code, "VALIDATION_ERROR");

    const beforeCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    const stripeOrderClientRequestId = crypto.randomUUID();
    const orderCreated = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "stripe", clientRequestId: stripeOrderClientRequestId },
      demoSession
    );
    assert.equal(orderCreated.data.order.paymentProvider, "stripe");
    assert.equal(orderCreated.data.order.status, "PENDING");
    assert.ok(orderCreated.data.checkoutUrl);
    assert.match(orderCreated.data.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
    assert.equal(stripeServer.requests.length, 1);
    assert.equal(stripeServer.requests[0].path, "/v1/checkout/sessions");
    assert.match(stripeServer.requests[0].authorization ?? "", new RegExp(`^Bearer ${stripeSecret}$`));
    const checkoutBody = new URLSearchParams(stripeServer.requests[0].body);
    assert.equal(checkoutBody.get("metadata[orderId]"), orderCreated.data.order.id);
    assert.equal(checkoutBody.get("metadata[orderNo]"), orderCreated.data.order.orderNo);
    assert.equal(
      checkoutBody.get("line_items[0][price_data][unit_amount]"),
      String(orderCreated.data.order.amountCents)
    );
    assert.equal(
      checkoutBody.get("line_items[0][price_data][currency]"),
      orderCreated.data.order.currency.toLowerCase()
    );
    const duplicateOrderCreated = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "stripe", clientRequestId: stripeOrderClientRequestId },
      demoSession
    );
    assert.equal(duplicateOrderCreated.data.order.id, orderCreated.data.order.id);
    assert.equal(stripeServer.requests.length, 1);

    const sessionId = stripeServer.lastSessionId();
    const eventId = `evt_${crypto.randomUUID()}`;
    const payload = stripeEventPayload({
      eventId,
      sessionId,
      orderId: orderCreated.data.order.id,
      orderNo: orderCreated.data.order.orderNo,
      amountCents: orderCreated.data.order.amountCents,
      currency: orderCreated.data.order.currency
    });

    const missingSignature = await fetch(`${baseUrl}/api/payments/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    assert.equal(missingSignature.status, 400);

    const tamperedPayload = stripeEventPayload({
      eventId,
      sessionId,
      orderId: orderCreated.data.order.id,
      orderNo: orderCreated.data.order.orderNo,
      amountCents: orderCreated.data.order.amountCents + 1,
      currency: orderCreated.data.order.currency
    });
    const tamperedWebhook = await fetch(`${baseUrl}/api/payments/webhooks/stripe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": stripeSignatureHeader(webhookSecret, payload)
      },
      body: tamperedPayload
    });
    assert.equal(tamperedWebhook.status, 400);

    const webhookResponse = await postStripeWebhook(baseUrl, webhookSecret, payload);
    assert.equal(webhookResponse.status, 200);
    const webhookBody = await webhookResponse.json();
    assert.equal(webhookBody.data.credited, true);
    assert.equal(webhookBody.data.order.status, "PAID");
    assert.equal(webhookBody.data.order.paymentProvider, "stripe");
    assert.equal(webhookBody.data.balanceAfter, beforeCredits.data.account.balance + orderCreated.data.plan.credits);

    const duplicateWebhook = await postStripeWebhook(baseUrl, webhookSecret, payload);
    assert.equal(duplicateWebhook.status, 200);
    const duplicateBody = await duplicateWebhook.json();
    assert.equal(duplicateBody.data.credited, false);
    assert.equal(duplicateBody.data.duplicateEvent, true);
    assert.equal(duplicateBody.data.balanceAfter, webhookBody.data.balanceAfter);

    const afterCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(afterCredits.data.account.balance, webhookBody.data.balanceAfter);

    const orderAfterPay = await get(baseUrl, `/api/orders/${orderCreated.data.order.id}`, demoSession);
    assert.equal(orderAfterPay.data.order.status, "PAID");
    assert.equal(orderAfterPay.data.order.paymentProvider, "stripe");
    assert.equal(orderAfterPay.data.order.paymentIntentId, sessionId);

    const requestCountBeforePaidRetry = stripeServer.requests.length;
    const repayPaidOrder = await post(baseUrl, `/api/orders/${orderCreated.data.order.id}/pay`, {}, demoSession);
    assert.equal(repayPaidOrder.data.order.status, "PAID");
    assert.equal(repayPaidOrder.data.checkoutUrl, null);
    assert.equal(repayPaidOrder.data.balanceAfter, webhookBody.data.balanceAfter);
    assert.equal(stripeServer.requests.length, requestCountBeforePaidRetry);

    const amountMismatchOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "stripe", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const amountMismatchSession = stripeServer.lastSessionId();
    const amountMismatchPayload = stripeEventPayload({
      eventId: `evt_${crypto.randomUUID()}`,
      sessionId: amountMismatchSession,
      orderId: amountMismatchOrder.data.order.id,
      orderNo: amountMismatchOrder.data.order.orderNo,
      amountCents: amountMismatchOrder.data.order.amountCents + 1,
      currency: amountMismatchOrder.data.order.currency
    });
    const amountMismatchResponse = await postStripeWebhook(baseUrl, webhookSecret, amountMismatchPayload);
    assert.equal(amountMismatchResponse.status, 200);
    const amountMismatchBody = await amountMismatchResponse.json();
    assert.equal(amountMismatchBody.data.credited, false);
    assert.equal(amountMismatchBody.data.reason, "AMOUNT_MISMATCH");
    const amountMismatchAfter = await get(baseUrl, `/api/orders/${amountMismatchOrder.data.order.id}`, demoSession);
    assert.equal(amountMismatchAfter.data.order.status, "PENDING");

    const orderNoMismatchOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "stripe", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const orderNoMismatchSession = stripeServer.lastSessionId();
    const orderNoMismatchPayload = stripeEventPayload({
      eventId: `evt_${crypto.randomUUID()}`,
      sessionId: orderNoMismatchSession,
      orderId: orderNoMismatchOrder.data.order.id,
      orderNo: "IM-STRIPE-TAMPER",
      amountCents: orderNoMismatchOrder.data.order.amountCents,
      currency: orderNoMismatchOrder.data.order.currency
    });
    const orderNoMismatchResponse = await postStripeWebhook(baseUrl, webhookSecret, orderNoMismatchPayload);
    const orderNoMismatchBody = await orderNoMismatchResponse.json();
    assert.equal(orderNoMismatchBody.data.credited, false);
    assert.equal(orderNoMismatchBody.data.reason, "ORDER_NO_MISMATCH");

    const continueOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "stripe", clientRequestId: crypto.randomUUID() },
      demoSession
    );
    const continuePayResponse = await post(baseUrl, `/api/orders/${continueOrder.data.order.id}/pay`, {}, demoSession);
    assert.equal(continuePayResponse.data.order.status, "PENDING");
    assert.ok(continuePayResponse.data.checkoutUrl);
    assert.match(continuePayResponse.data.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);

    const storeAfter = await readStore(storePath);
    const stripeEvents = storeAfter.paymentEvents.filter((event) => event.provider === "stripe");
    assert.ok(stripeEvents.some((event) => event.providerEventId === eventId));
    assert.equal(stripeEvents.filter((event) => event.providerEventId === eventId).length, 1);
  } finally {
    api.kill();
    await stripeServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function productionApiEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: "production",
    WEB_ORIGIN: "https://imagora.example",
    DATABASE_URL: "postgresql://imagora:imagora@db.example:5432/imagora",
    REDIS_URL: "redis://redis.example:6379",
    OPENAI_API_KEY: "sk-test",
    S3_ENDPOINT: "https://s3.example",
    S3_BUCKET: "imagora",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_PUBLIC_BASE_URL: "https://cdn.example",
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_SUCCESS_URL: "https://imagora.example/payment/success",
    STRIPE_CANCEL_URL: "https://imagora.example/payment/cancel",
    OPENAI_TIMEOUT_MS: "300000",
    OPENAI_MAX_RETRIES: "1",
    GENERATION_RUNNING_TIMEOUT_MS: "1500000",
    MAILER_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example",
    SMTP_USER: "imagora",
    SMTP_PASSWORD: "smtp-secret",
    SMTP_FROM: "noreply@imagora.example",
    SAFETY_PROVIDER: "http",
    SAFETY_TEXT_ENDPOINT: "https://safety.example/text",
    SAFETY_IMAGE_ENDPOINT: "https://safety.example/image",
    DATA_STORE: "prisma",
    QUEUE_PROVIDER: "bullmq",
    IMAGE_PROVIDER_DEFAULT: "openai",
    IMAGE_MODEL_DEFAULT: "openai:gpt-image-2",
    STORAGE_PROVIDER: "s3",
    PAYMENT_PROVIDER: "stripe",
    RATE_LIMIT_PROVIDER: "redis",
    RUNTIME_STATE_PROVIDER: "redis",
    SESSION_COOKIE_SECURE: "true",
    SESSION_COOKIE_SAMESITE: "Strict",
    ALERT_EMAIL_TO: "ops@imagora.example",
    ALLOW_BEARER_SESSION_AUTH: "false",
    ...overrides
  };
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      const detail = stderr.trim() ? `\nstderr:\n${stderr.trim()}` : "";
      reject(new Error(`${command} ${args.join(" ")} timed out after 15000ms${detail}`));
    }, 15000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

async function login(baseUrl, email, password) {
  const firstProof = await verifyCaptcha(baseUrl);
  const secondProof = await verifyCaptcha(baseUrl);
  return authPost(baseUrl, "/api/auth/login", {
    email,
    password,
    captchaVerificationIds: [firstProof.data.verificationId, secondProof.data.verificationId]
  });
}

async function register(baseUrl, body) {
  return authPost(baseUrl, "/api/auth/register", body);
}

async function authPost(baseUrl, path, body, origin) {
  const response = await authFetch(baseUrl, path, body, origin);
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.ok(payload.data);
  assert.equal("token" in payload.data, false);

  const setCookie = readSetCookie(response);
  assert.match(setCookie, /^imagora_session=/);
  assert.match(setCookie, /;\s*HttpOnly/i);
  assert.match(setCookie, /;\s*SameSite=Strict/i);
  const session = setCookie.split(";")[0];
  const sessionValue = session.split("=").slice(1).join("=");
  assert.ok(sessionValue);
  return { ...payload, session, sessionValue };
}

async function rawAuthPost(baseUrl, path, body, origin) {
  const response = await authFetch(baseUrl, path, body, origin);
  return {
    status: response.status,
    payload: await response.json()
  };
}

async function rawApiPost(baseUrl, path, body, origin = defaultWriteOrigin) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {})
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    payload: await response.json()
  };
}

async function verifyCaptcha(baseUrl, origin = defaultWriteOrigin) {
  const captcha = await getCaptcha(baseUrl, origin);
  const response = await fetch(`${baseUrl}/api/auth/captcha/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {})
    },
    body: JSON.stringify({
      captchaId: captcha.data.captchaId,
      captchaSelections: captcha.data.answer
    })
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.ok(payload.data?.verificationId);
  assert.ok(payload.data?.expiresAt);
  return payload;
}

async function getCaptcha(baseUrl, origin = defaultWriteOrigin) {
  const response = await fetch(`${baseUrl}/api/auth/captcha`, {
    headers: origin ? { Origin: origin } : undefined
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.ok(payload.data?.captchaId);
  assert.ok(payload.data?.imageSvg);
  assert.ok(payload.data?.instruction);
  assert.ok(payload.data?.requiredSelections);
  assert.ok(payload.data?.optionCount >= 12);
  assert.ok(payload.data?.expiresAt);
  return payload;
}

async function authFetch(baseUrl, path, body, origin = defaultWriteOrigin) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {})
    },
    body: JSON.stringify(body)
  });
}

function reserveUnusedPort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function readSetCookie(response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const setCookie = getSetCookie ? getSetCookie()[0] : response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie;
}

async function waitForHealth(baseUrl, timeoutMs = 6000) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 200));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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

async function waitForCondition(check, timeoutMs = 3000, intervalMs = 50, message = "Condition not met") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(message);
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

async function patch(baseUrl, path, body, session) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
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

async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return {
      response,
      payload: await response.json()
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sessionHeaders(session) {
  return {
    Origin: defaultWriteOrigin,
    ...(session ? { Cookie: session } : {})
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readStore(storePath) {
  return new JsonStore(storePath).read();
}

async function updateStoreJson(storePath, updater) {
  return new JsonStore(storePath).update((store) => updater(store));
}

function createPaginationTask(id, userId, createdAt) {
  return {
    id,
    userId,
    clientRequestId: `client-${id}`,
    referenceImageId: null,
    prompt: `pagination prompt ${id}`,
    negativePrompt: null,
    style: "illustration",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "draft",
    modelProvider: "mock",
    modelName: "mock:default",
    status: "SUCCEEDED",
    creditCost: 1,
    providerCostCents: 0,
    failureCode: null,
    failureMessage: null,
    startedAt: createdAt,
    completedAt: createdAt,
    createdAt,
    updatedAt: createdAt
  };
}

function createPaginationImage(id, taskId, userId, createdAt) {
  return {
    id,
    taskId,
    userId,
    projectId: null,
    storageKey: `generated/${userId}/${id}.svg`,
    thumbnailKey: `generated/${userId}/${id}-thumb.svg`,
    thumbnailUrl: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    publicUrl: "",
    width: 1024,
    height: 1024,
    fileSize: 128,
    mimeType: "image/svg+xml",
    safetyStatus: "PASSED",
    visibility: "PRIVATE",
    generationMetadata: {
      taskId,
      prompt: `pagination image ${id}`,
      negativePrompt: null,
      style: "illustration",
      aspectRatio: "1:1",
      quality: "draft",
      quantity: 1,
      modelProvider: "mock",
      modelName: "mock:default",
      width: 1024,
      height: 1024,
      creditCost: 1,
      createdAt
    },
    deletedAt: null,
    createdAt
  };
}

async function forceStaleRunningTask(storePath, taskId) {
  await updateStoreJson(storePath, (store) => {
    const task = store.generationTasks.find((item) => item.id === taskId);
    assert.ok(task);
    task.status = "RUNNING";
    task.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    task.completedAt = null;
    task.updatedAt = task.startedAt;
  });
}

async function removeOrderCreditGrant(storePath, orderId) {
  await updateStoreJson(storePath, (store) => {
    const entryIndex = store.creditLedgerEntries.findIndex(
      (entry) => entry.sourceId === orderId && entry.idempotencyKey === `order-grant:${orderId}`
    );
    assert.notEqual(entryIndex, -1);
    const [entry] = store.creditLedgerEntries.splice(entryIndex, 1);
    const account = store.creditAccounts.find((item) => item.userId === entry.userId);
    assert.ok(account);
    account.balance -= entry.amount;
    account.totalEarned -= entry.amount;
    account.updatedAt = new Date().toISOString();
  });
}

async function seedSucceededPaymentEvent(storePath, orderId, providerEventId, amountCents) {
  await updateStoreJson(storePath, (store) => {
    const order = store.orders.find((item) => item.id === orderId);
    assert.ok(order);
    const now = new Date().toISOString();
    store.paymentEvents.push({
      id: crypto.randomUUID(),
      provider: "mock",
      providerEventId,
      orderId,
      eventType: "payment.succeeded",
      payload: {
        providerEventId,
        orderId,
        orderNo: order.orderNo,
        amountCents,
        currency: order.currency
      },
      processedAt: now,
      createdAt: now
    });
  });
}

async function markOrderExpired(storePath, orderId) {
  await updateStoreJson(storePath, (store) => {
    const order = store.orders.find((item) => item.id === orderId);
    assert.ok(order);
    const expiredAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    order.createdAt = expiredAt;
    order.updatedAt = expiredAt;
  });
}

function createFakeStripeServer() {
  const requests = [];
  let port = 0;
  let lastSessionId = null;
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      const sessionId = `cs_test_${requests.length}_${Math.random().toString(36).slice(2, 10)}`;
      lastSessionId = sessionId;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: sessionId,
          url: `https://checkout.stripe.test/pay/${sessionId}`
        })
      );
    });
  });

  return {
    requests,
    get port() {
      return port;
    },
    lastSessionId() {
      return lastSessionId;
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

function stripeEventPayload({ eventId, sessionId, orderId, orderNo, amountCents, currency }) {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        amount_total: amountCents,
        currency: currency.toLowerCase(),
        client_reference_id: orderId,
        payment_intent: sessionId,
        payment_status: "paid",
        metadata: {
          orderId,
          orderNo
        }
      }
    }
  });
}

function stripeSignatureHeader(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function postStripeWebhook(baseUrl, secret, payload) {
  return fetch(`${baseUrl}/api/payments/webhooks/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": stripeSignatureHeader(secret, payload)
    },
    body: payload
  });
}

function createFakeOpenAiServer(responses) {
  const requests = [];
  let port = 0;
  const server = createHttpServer((request, response) => {
    const next = responses.shift();
    assert.ok(next, "Unexpected OpenAI request");
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", async () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      if (next.delayMs) {
        await sleep(next.delayMs);
      }
      response.statusCode = next.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(next.body));
    });
  });

  return {
    requests,
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
