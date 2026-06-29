import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "../packages/database/dist/index.js";

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("api rejects bearer session auth in production config", async () => {
  const env = {
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
    DATA_STORE: "prisma",
    QUEUE_PROVIDER: "bullmq",
    AI_PROVIDER: "openai",
    STORAGE_PROVIDER: "s3",
    PAYMENT_PROVIDER: "stripe",
    RATE_LIMIT_PROVIDER: "redis",
    SESSION_COOKIE_SECURE: "true",
    ALLOW_BEARER_SESSION_AUTH: "true"
  };

  const result = await runProcess(process.execPath, ["apps/api/dist/main.js"], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /bearer session auth must be disabled/);
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
    await waitForHealth(baseUrl);

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
    await waitForHealth(baseUrl);

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

    const invalidUpload = await fetch(`${baseUrl}/api/uploads/reference-images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: demoSession
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
        Cookie: demoSession
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
        Cookie: otherUserSession
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
      quality: "draft"
    };
    const created = await post(baseUrl, "/api/generation/tasks", generationPayload, demoSession);
    const duplicateCreated = await post(baseUrl, "/api/generation/tasks", generationPayload, demoSession);

    assert.equal(duplicateCreated.data.task.id, created.data.task.id);
    assert.equal(created.data.task.referenceImageId, uploadedReference.data.referenceImage.id);
    assert.equal(duplicateCreated.data.balanceAfter, created.data.balanceAfter);
    assert.equal(created.data.balanceAfter, startingCredits.data.account.balance - created.data.task.creditCost);

    const taskId = created.data.task.id;
    const completed = await waitForTask(baseUrl, demoSession, taskId);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.images.length, 1);
    const generatedImageId = completed.data.images[0].id;

    const downloadUrl = await post(baseUrl, `/api/images/${generatedImageId}/download-url`, {}, demoSession);
    assert.match(downloadUrl.data.url, /^mock-signed:\/\//);
    assert.match(downloadUrl.data.fileName, /^imagora-.+\.svg$/);
    assert.ok(downloadUrl.data.expiresAt);
    const foreignDownload = await fetch(`${baseUrl}/api/images/${generatedImageId}/download-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: otherUserSession
      },
      body: JSON.stringify({})
    });
    const foreignDownloadPayload = await foreignDownload.json();
    assert.equal(foreignDownload.status, 404);
    assert.equal(foreignDownloadPayload.error.code, "NOT_FOUND");

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
    const orderCreated = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock" },
      demoSession
    );
    const providerEventId = `evt_${crypto.randomUUID()}`;
    const webhookPayload = {
      providerEventId,
      orderId: orderCreated.data.order.id,
      amountCents: orderCreated.data.order.amountCents
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
      { planId: "starter", paymentProvider: "mock" },
      demoSession
    );
    const mismatchWebhook = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: mismatchOrder.data.order.id,
      amountCents: mismatchOrder.data.order.amountCents + 1
    });
    const afterMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    assert.equal(mismatchWebhook.data.credited, false);
    assert.equal(mismatchWebhook.data.reason, "AMOUNT_MISMATCH");
    assert.equal(mismatchWebhook.data.order.status, "PENDING");
    assert.equal(afterMismatchCredits.data.account.balance, beforeMismatchCredits.data.account.balance);

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
      { planId: "starter", paymentProvider: "mock" },
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
      { planId: "starter", paymentProvider: "mock" },
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
        Cookie: demoSession
      },
      body: JSON.stringify({})
    });
    const closedPayPayload = await closedPay.json();
    assert.equal(closedPay.status, 400);
    assert.equal(closedPayPayload.error.code, "ORDER_NOT_PAYABLE");

    const lateWebhookOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock" },
      demoSession
    );
    const beforeLateWebhookCredits = await get(baseUrl, "/api/users/me/credits", demoSession);
    await markOrderExpired(storePath, lateWebhookOrder.data.order.id);
    await get(baseUrl, "/api/orders", demoSession);
    const lateWebhookPaid = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: lateWebhookOrder.data.order.id,
      amountCents: lateWebhookOrder.data.order.amountCents
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
    const adjustedCredits = await post(
      baseUrl,
      `/api/admin/users/${demo.data.user.id}/credits/adjust`,
      { amount: 17, reason: "QA manual adjustment" },
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

    const createdPlan = await post(
      baseUrl,
      "/api/admin/plans",
      {
        name: "QA Pack",
        description: "Automated admin plan",
        priceCents: 1234,
        currency: "USD",
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
    const paidOrders = await get(baseUrl, "/api/admin/orders?status=PAID&limit=10", adminSession);
    assert.ok(paidOrders.data.orders.every((order) => order.status === "PAID"));

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
    const visibleImagesAfterHide = await get(baseUrl, "/api/images?limit=50", demoSession);
    assert.ok(!visibleImagesAfterHide.data.images.some((image) => image.id === generatedImageId));

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

    const metrics = await get(baseUrl, "/api/admin/metrics", adminSession);
    assert.ok(metrics.data.http.requestsTotal > 0);
    assert.ok(metrics.data.domain.tasksByStatus.SUCCEEDED >= 1);
    assert.ok(metrics.data.domain.referenceImagesTotal >= 1);
    assert.ok(metrics.data.domain.paymentEventsTotal >= 2);
    assert.ok(metrics.data.alerts.some((alert) => alert.id === "generation.failure-rate"));
    assert.ok(metrics.data.alerts.some((alert) => alert.id === "payments.amount-mismatch"));

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
        Cookie: demoSession
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

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, 5000);

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

async function rawApiPost(baseUrl, path, body, origin) {
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

async function verifyCaptcha(baseUrl, origin) {
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

async function getCaptcha(baseUrl, origin) {
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

async function authFetch(baseUrl, path, body, origin) {
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

async function readStore(storePath) {
  return new JsonStore(storePath).read();
}

async function updateStoreJson(storePath, updater) {
  return new JsonStore(storePath).update((store) => updater(store));
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
      payload: { providerEventId, orderId, amountCents },
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
