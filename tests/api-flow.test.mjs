import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("api and worker complete generation and enforce admin safety rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-api-"));
  const port = 4700 + Math.floor(Math.random() * 400);
  const storePath = join(dir, "store.json");
  const env = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    IMAGORA_STORE_PATH: storePath,
    ORDER_PENDING_TTL_MINUTES: "30",
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

    const invalidUpload = await fetch(`${baseUrl}/api/uploads/reference-images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${demoToken}`
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

    const uploadedReference = await post(
      baseUrl,
      "/api/uploads/reference-images",
      {
        fileName: "reference.png",
        mimeType: "image/png",
        contentBase64: onePixelPngBase64
      },
      demoToken
    );
    const duplicateReference = await post(
      baseUrl,
      "/api/uploads/reference-images",
      {
        fileName: "reference-copy.png",
        mimeType: "image/png",
        contentBase64: onePixelPngBase64
      },
      demoToken
    );
    assert.equal(uploadedReference.data.referenceImage.width, 1);
    assert.equal(uploadedReference.data.referenceImage.height, 1);
    assert.equal(duplicateReference.data.duplicate, true);
    assert.equal(duplicateReference.data.referenceImage.id, uploadedReference.data.referenceImage.id);

    const otherUser = await post(baseUrl, "/api/auth/register", {
      email: `intruder-${crypto.randomUUID()}@imagora.local`,
      password: "Intruder123!",
      nickname: "Intruder"
    });
    const forbiddenAdminUsers = await fetch(`${baseUrl}/api/admin/users`, {
      headers: {
        Authorization: `Bearer ${demoToken}`
      }
    });
    const forbiddenAdminUsersPayload = await forbiddenAdminUsers.json();
    assert.equal(forbiddenAdminUsers.status, 403);
    assert.equal(forbiddenAdminUsersPayload.error.code, "FORBIDDEN");

    const foreignReferenceUse = await fetch(`${baseUrl}/api/generation/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${otherUser.data.token}`
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

    const startingCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
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
    const created = await post(
      baseUrl,
      "/api/generation/tasks",
      generationPayload,
      demoToken
    );
    const duplicateCreated = await post(baseUrl, "/api/generation/tasks", generationPayload, demoToken);

    assert.equal(duplicateCreated.data.task.id, created.data.task.id);
    assert.equal(created.data.task.referenceImageId, uploadedReference.data.referenceImage.id);
    assert.equal(duplicateCreated.data.balanceAfter, created.data.balanceAfter);
    assert.equal(created.data.balanceAfter, startingCredits.data.account.balance - created.data.task.creditCost);

    const taskId = created.data.task.id;
    const completed = await waitForTask(baseUrl, demoToken, taskId);
    assert.equal(completed.data.task.status, "SUCCEEDED");
    assert.equal(completed.data.images.length, 1);
    const generatedImageId = completed.data.images[0].id;

    const downloadUrl = await post(baseUrl, `/api/images/${generatedImageId}/download-url`, {}, demoToken);
    assert.match(downloadUrl.data.url, /^mock-signed:\/\//);
    assert.match(downloadUrl.data.fileName, /^imagora-.+\.svg$/);
    assert.ok(downloadUrl.data.expiresAt);
    const foreignDownload = await fetch(`${baseUrl}/api/images/${generatedImageId}/download-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${otherUser.data.token}`
      },
      body: JSON.stringify({})
    });
    const foreignDownloadPayload = await foreignDownload.json();
    assert.equal(foreignDownload.status, 404);
    assert.equal(foreignDownloadPayload.error.code, "NOT_FOUND");

    const beforeFailedCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
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
      demoToken
    );
    const failed = await waitForTask(baseUrl, demoToken, failedCreated.data.task.id);
    assert.equal(failed.data.task.status, "FAILED");
    assert.equal(failed.data.task.failureCode, "PROVIDER_FAILED");

    const afterFailedCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    assert.equal(afterFailedCredits.data.account.balance, beforeFailedCredits.data.account.balance);

    await forceStaleRunningTask(storePath, failedCreated.data.task.id);
    const failedAgain = await waitForTask(baseUrl, demoToken, failedCreated.data.task.id);
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

    const beforePaymentCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    const orderCreated = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock" },
      demoToken
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
    assert.equal(webhookPaid.data.balanceAfter, beforePaymentCredits.data.account.balance + orderCreated.data.plan.credits);
    assert.equal(webhookDuplicate.data.credited, false);
    assert.equal(webhookDuplicate.data.duplicateEvent, true);
    assert.equal(webhookDuplicate.data.balanceAfter, webhookPaid.data.balanceAfter);

    const beforeMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    const mismatchOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock" },
      demoToken
    );
    const mismatchWebhook = await post(baseUrl, "/api/payments/webhooks/mock", {
      providerEventId: `evt_${crypto.randomUUID()}`,
      orderId: mismatchOrder.data.order.id,
      amountCents: mismatchOrder.data.order.amountCents + 1
    });
    const afterMismatchCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
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
        (entry) => entry.sourceId === orderCreated.data.order.id && entry.idempotencyKey === `order-grant:${orderCreated.data.order.id}`
      ).length,
      1
    );

    const admin = await post(baseUrl, "/api/auth/login", {
      email: "admin@imagora.local",
      password: "Admin123!"
    });

    await removeOrderCreditGrant(storePath, orderCreated.data.order.id);
    const corruptedPaymentCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    assert.equal(corruptedPaymentCredits.data.account.balance, webhookPaid.data.balanceAfter - orderCreated.data.plan.credits);

    const paidOrderReconciliation = await post(baseUrl, "/api/admin/maintenance/reconcile", {}, admin.data.token);
    assert.equal(paidOrderReconciliation.data.maintenance.reconciledPaidOrders, 1);
    const restoredPaymentCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    assert.equal(restoredPaymentCredits.data.account.balance, webhookPaid.data.balanceAfter);
    const storeAfterPaidOrderReconcile = await readStore(storePath);
    assert.equal(
      storeAfterPaidOrderReconcile.creditLedgerEntries.filter(
        (entry) => entry.sourceId === orderCreated.data.order.id && entry.idempotencyKey === `order-grant:${orderCreated.data.order.id}`
      ).length,
      1
    );
    assert.ok(storeAfterPaidOrderReconcile.adminAuditLogs.some((entry) => entry.action === "maintenance.reconcile"));

    const duplicateReconciliation = await post(baseUrl, "/api/admin/maintenance/reconcile", {}, admin.data.token);
    assert.equal(duplicateReconciliation.data.maintenance.reconciledPaidOrders, 0);

    const eventBackfillOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock" },
      demoToken
    );
    const beforeEventBackfillCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    await seedSucceededPaymentEvent(
      storePath,
      eventBackfillOrder.data.order.id,
      `evt_${crypto.randomUUID()}`,
      eventBackfillOrder.data.order.amountCents
    );
    const eventBackfillReconciliation = await post(baseUrl, "/api/admin/maintenance/reconcile", {}, admin.data.token);
    assert.equal(eventBackfillReconciliation.data.maintenance.reconciledPaymentEvents, 1);
    assert.equal(eventBackfillReconciliation.data.maintenance.reconciledPaidOrders, 1);
    const afterEventBackfillCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    assert.equal(
      afterEventBackfillCredits.data.account.balance,
      beforeEventBackfillCredits.data.account.balance + eventBackfillOrder.data.plan.credits
    );

    const expiredOrder = await post(
      baseUrl,
      "/api/orders",
      { planId: "starter", paymentProvider: "mock" },
      demoToken
    );
    await markOrderExpired(storePath, expiredOrder.data.order.id);
    const ordersAfterExpiry = await get(baseUrl, "/api/orders", demoToken);
    assert.ok(ordersAfterExpiry.data.maintenance.closedExpiredOrders >= 1);
    const expiredAfterMaintenance = ordersAfterExpiry.data.orders.find((order) => order.id === expiredOrder.data.order.id);
    assert.ok(expiredAfterMaintenance);
    assert.equal(expiredAfterMaintenance.status, "CLOSED");
    const closedPay = await fetch(`${baseUrl}/api/orders/${expiredOrder.data.order.id}/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${demoToken}`
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
      demoToken
    );
    const beforeLateWebhookCredits = await get(baseUrl, "/api/users/me/credits", demoToken);
    await markOrderExpired(storePath, lateWebhookOrder.data.order.id);
    await get(baseUrl, "/api/orders", demoToken);
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

    const adminUserSearch = await get(baseUrl, "/api/admin/users?search=demo%40imagora.local&limit=5", admin.data.token);
    assert.ok(adminUserSearch.data.users.some((user) => user.id === demo.data.user.id));

    const suspendedUser = await patch(
      baseUrl,
      `/api/admin/users/${otherUser.data.user.id}/status`,
      { status: "SUSPENDED" },
      admin.data.token
    );
    assert.equal(suspendedUser.data.user.status, "SUSPENDED");
    const suspendedUsers = await get(baseUrl, "/api/admin/users?status=SUSPENDED&limit=10", admin.data.token);
    assert.ok(suspendedUsers.data.users.some((user) => user.id === otherUser.data.user.id));
    assert.ok(suspendedUsers.data.users.every((user) => user.status === "SUSPENDED"));
    await patch(baseUrl, `/api/admin/users/${otherUser.data.user.id}/status`, { status: "ACTIVE" }, admin.data.token);

    const beforeAdminAdjustment = await get(baseUrl, "/api/users/me/credits", demoToken);
    const adjustedCredits = await post(
      baseUrl,
      `/api/admin/users/${demo.data.user.id}/credits/adjust`,
      { amount: 17, reason: "QA manual adjustment" },
      admin.data.token
    );
    assert.equal(adjustedCredits.data.account.balance, beforeAdminAdjustment.data.account.balance + 17);
    const ledgerAfterAdjustment = await get(baseUrl, "/api/users/me/credit-ledger?limit=100", demoToken);
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
        sortOrder: 77
      },
      admin.data.token
    );
    assert.equal(createdPlan.data.plan.status, "ACTIVE");
    const publicPlansAfterCreate = await get(baseUrl, "/api/plans", demoToken);
    assert.ok(publicPlansAfterCreate.data.plans.some((plan) => plan.id === createdPlan.data.plan.id));

    const disabledPlan = await patch(
      baseUrl,
      `/api/admin/plans/${createdPlan.data.plan.id}`,
      { priceCents: 1599, credits: 420, status: "INACTIVE", sortOrder: 8 },
      admin.data.token
    );
    assert.equal(disabledPlan.data.plan.priceCents, 1599);
    assert.equal(disabledPlan.data.plan.credits, 420);
    assert.equal(disabledPlan.data.plan.status, "INACTIVE");
    const publicPlansAfterDisable = await get(baseUrl, "/api/plans", demoToken);
    assert.ok(!publicPlansAfterDisable.data.plans.some((plan) => plan.id === createdPlan.data.plan.id));
    const reactivatedPlan = await patch(
      baseUrl,
      `/api/admin/plans/${createdPlan.data.plan.id}`,
      { status: "ACTIVE" },
      admin.data.token
    );
    assert.equal(reactivatedPlan.data.plan.status, "ACTIVE");

    const succeededTasks = await get(baseUrl, "/api/admin/generation/tasks?status=SUCCEEDED&limit=5", admin.data.token);
    assert.ok(succeededTasks.data.tasks.some((task) => task.id === taskId));
    assert.ok(succeededTasks.data.tasks.every((task) => task.status === "SUCCEEDED"));
    const paidOrders = await get(baseUrl, "/api/admin/orders?status=PAID&limit=10", admin.data.token);
    assert.ok(paidOrders.data.orders.every((order) => order.status === "PAID"));

    const hiddenImage = await patch(
      baseUrl,
      `/api/admin/images/${generatedImageId}/visibility`,
      { visibility: "HIDDEN" },
      admin.data.token
    );
    assert.equal(hiddenImage.data.image.visibility, "HIDDEN");
    const hiddenImages = await get(baseUrl, "/api/admin/images?visibility=HIDDEN&limit=10", admin.data.token);
    assert.ok(hiddenImages.data.images.some((image) => image.id === generatedImageId));
    assert.ok(hiddenImages.data.images.every((image) => image.visibility === "HIDDEN"));
    const visibleImagesAfterHide = await get(baseUrl, "/api/images?limit=50", demoToken);
    assert.ok(!visibleImagesAfterHide.data.images.some((image) => image.id === generatedImageId));

    const auditLogs = await get(baseUrl, "/api/admin/audit-logs", admin.data.token);
    for (const action of ["user.status.update", "user.credits.adjust", "plan.create", "plan.update", "image.visibility.update"]) {
      assert.ok(auditLogs.data.logs.some((entry) => entry.action === action), `Missing audit action: ${action}`);
    }

    const metrics = await get(baseUrl, "/api/admin/metrics", admin.data.token);
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

async function patch(baseUrl, path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
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

async function readStore(storePath) {
  return JSON.parse(await readFile(storePath, "utf8"));
}

async function writeStoreJson(storePath, store) {
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function updateStoreJson(storePath, updater) {
  const store = await readStore(storePath);
  updater(store);
  await writeStoreJson(storePath, store);
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
