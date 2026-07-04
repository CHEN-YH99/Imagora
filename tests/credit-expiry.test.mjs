import assert from "node:assert/strict";
import test from "node:test";
import {
  creditSourceRemainders,
  expireCredits,
  refundFailureCount,
  refundTaskCredits,
  runGenerationMaintenance,
  taskRefundedCredits
} from "../packages/shared/dist/index.js";

function makeAccount(userId, balance, totalEarned, totalSpent = 0) {
  return { userId, balance, totalEarned, totalSpent, updatedAt: new Date().toISOString() };
}

function grant(id, userId, amount, createdAt, expiresAt) {
  return {
    id,
    userId,
    type: "GRANT",
    amount,
    balanceAfter: amount,
    sourceType: "ORDER",
    sourceId: `order-${id}`,
    idempotencyKey: `order-grant:${id}`,
    remark: "batch",
    createdAt,
    expiresAt
  };
}

function spend(id, userId, amount, createdAt) {
  return {
    id,
    userId,
    type: "SPEND",
    amount: -amount,
    balanceAfter: 0,
    sourceType: "TASK",
    sourceId: `task-${id}`,
    idempotencyKey: `task-spend:${id}`,
    remark: "spend",
    createdAt,
    expiresAt: null
  };
}

function taskSpend(taskId, userId, amount, createdAt) {
  return {
    id: `spend-${taskId}`,
    userId,
    type: "SPEND",
    amount: -amount,
    balanceAfter: 0,
    sourceType: "TASK",
    sourceId: taskId,
    idempotencyKey: `task-spend:${taskId}`,
    remark: "task spend",
    createdAt,
    expiresAt: null
  };
}

function generationTask(id, status, createdAt, startedAt = null, creditCost = 40) {
  return {
    id,
    userId: "u1",
    clientRequestId: `request-${id}`,
    referenceImageId: null,
    prompt: "A test prompt",
    negativePrompt: null,
    style: "poster",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "draft",
    modelProvider: "mock",
    modelName: "mock",
    status,
    creditCost,
    providerCostCents: 0,
    failureCode: null,
    failureMessage: null,
    startedAt,
    completedAt: null,
    createdAt,
    updatedAt: createdAt
  };
}

const DAY = 24 * 60 * 60 * 1000;

test("expired batch is reclaimed by its remaining amount", () => {
  const past = new Date(Date.now() - DAY).toISOString();
  const older = new Date(Date.now() - 10 * DAY).toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 100, 100, 0)],
    creditLedgerEntries: [grant("b1", "u1", 100, older, past)]
  };

  const expired = expireCredits(data);
  assert.equal(expired, 1);
  assert.equal(data.creditAccounts[0].balance, 0);
  assert.equal(data.creditLedgerEntries.length, 2);
  const expireEntry = data.creditLedgerEntries.find((entry) => entry.type === "EXPIRE");
  assert.equal(expireEntry.amount, -100);
  assert.equal(expireEntry.sourceId, "b1");
});

test("partially spent batch only expires its remainder", () => {
  const past = new Date(Date.now() - DAY).toISOString();
  const older = new Date(Date.now() - 10 * DAY).toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 60, 100, 40)],
    creditLedgerEntries: [grant("b1", "u1", 100, older, past), spend("s1", "u1", 40, older)]
  };

  const expired = expireCredits(data);
  assert.equal(expired, 1);
  assert.equal(data.creditAccounts[0].balance, 0);
  const expireEntry = data.creditLedgerEntries.find((entry) => entry.type === "EXPIRE");
  assert.equal(expireEntry.amount, -60);
});

test("idempotent: second scan does not double-expire", () => {
  const past = new Date(Date.now() - DAY).toISOString();
  const older = new Date(Date.now() - 10 * DAY).toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 100, 100, 0)],
    creditLedgerEntries: [grant("b1", "u1", 100, older, past)]
  };

  expireCredits(data);
  const secondPass = expireCredits(data);
  assert.equal(secondPass, 0);
  assert.equal(data.creditAccounts[0].balance, 0);
  assert.equal(data.creditLedgerEntries.filter((entry) => entry.type === "EXPIRE").length, 1);
});

test("future batch is not expired", () => {
  const future = new Date(Date.now() + 10 * DAY).toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 100, 100, 0)],
    creditLedgerEntries: [grant("b1", "u1", 100, new Date().toISOString(), future)]
  };

  const expired = expireCredits(data);
  assert.equal(expired, 0);
  assert.equal(data.creditAccounts[0].balance, 100);
});

test("earliest-expiry batch is consumed first (FIFO by expiry)", () => {
  // 两个批次：b1 更早到期但更晚发放，b2 更晚到期。消耗应优先归属最早到期的 b1。
  const soon = new Date(Date.now() + 2 * DAY).toISOString();
  const later = new Date(Date.now() + 30 * DAY).toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 150, 200, 50)],
    creditLedgerEntries: [
      grant("b1", "u1", 100, new Date().toISOString(), soon),
      grant("b2", "u1", 100, new Date(Date.now() - DAY).toISOString(), later),
      spend("s1", "u1", 50, new Date().toISOString())
    ]
  };

  const remainders = creditSourceRemainders(data.creditLedgerEntries);
  // 50 消耗优先扣最早到期的 b1，b1 剩 50，b2 保持 100
  assert.equal(remainders.get("b1"), 50);
  assert.equal(remainders.get("b2"), 100);
});

test("permanent credits (no expiry) never expire", () => {
  const data = {
    creditAccounts: [makeAccount("u1", 100, 100, 0)],
    creditLedgerEntries: [grant("b1", "u1", 100, new Date().toISOString(), null)]
  };

  const expired = expireCredits(data);
  assert.equal(expired, 0);
  assert.equal(data.creditAccounts[0].balance, 100);
});

test("invariant: sum of remainders equals balance after expiry", () => {
  const past = new Date(Date.now() - DAY).toISOString();
  const future = new Date(Date.now() + 30 * DAY).toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 150, 200, 50)],
    creditLedgerEntries: [
      grant("b1", "u1", 100, new Date(Date.now() - 10 * DAY).toISOString(), past),
      grant("b2", "u1", 100, new Date().toISOString(), future),
      spend("s1", "u1", 50, new Date(Date.now() - 5 * DAY).toISOString())
    ]
  };

  expireCredits(data);
  const remainders = creditSourceRemainders(data.creditLedgerEntries);
  const sumRemainders = [...remainders.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(sumRemainders, data.creditAccounts[0].balance);
});

test("refund task credits is idempotent and does not inflate total earned", () => {
  const now = new Date().toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 60, 100, 40)],
    creditLedgerEntries: [taskSpend("task-refund", "u1", 40, now)],
    generationTasks: [generationTask("task-refund", "FAILED", now)]
  };
  const task = data.generationTasks[0];

  const firstRefund = refundTaskCredits(data, task, 40, "Task failed before image delivery", now);
  const secondRefund = refundTaskCredits(data, task, 40, "Task failed before image delivery", now);

  assert.equal(firstRefund.refunded, true);
  assert.equal(secondRefund.refunded, false);
  assert.equal(data.creditAccounts[0].balance, 100);
  assert.equal(data.creditAccounts[0].totalEarned, 100);
  assert.equal(data.creditAccounts[0].totalSpent, 0);
  assert.equal(taskRefundedCredits(data, task.id), 40);
  assert.equal(data.creditLedgerEntries.filter((entry) => entry.idempotencyKey === `task-refund:${task.id}`).length, 1);
});

test("generation maintenance refunds stale pending/running and unreconciled terminal tasks", () => {
  const now = new Date("2026-07-04T12:00:00.000Z").toISOString();
  const stale = new Date("2026-07-04T11:40:00.000Z").toISOString();
  const data = {
    creditAccounts: [makeAccount("u1", 20, 140, 120)],
    creditLedgerEntries: [
      taskSpend("pending-stale", "u1", 40, stale),
      taskSpend("running-stale", "u1", 40, stale),
      taskSpend("blocked-missing-refund", "u1", 40, stale)
    ],
    generationTasks: [
      generationTask("pending-stale", "PENDING", stale, null, 40),
      generationTask("running-stale", "RUNNING", stale, stale, 40),
      generationTask("blocked-missing-refund", "BLOCKED", stale, stale, 40)
    ]
  };

  const result = runGenerationMaintenance(data, {
    now,
    pendingTimeoutMs: 5 * 60 * 1000,
    runningTimeoutMs: 10 * 60 * 1000
  });
  const secondPass = runGenerationMaintenance(data, {
    now,
    pendingTimeoutMs: 5 * 60 * 1000,
    runningTimeoutMs: 10 * 60 * 1000
  });

  assert.equal(result.failedPendingTasks, 1);
  assert.equal(result.failedRunningTasks, 1);
  assert.equal(result.reconciledRefunds, 3);
  assert.equal(result.refundedCredits, 120);
  assert.equal(secondPass.reconciledRefunds, 0);
  assert.equal(data.creditAccounts[0].balance, 140);
  assert.equal(data.creditAccounts[0].totalEarned, 140);
  assert.equal(data.creditAccounts[0].totalSpent, 0);
  assert.equal(data.generationTasks.find((task) => task.id === "pending-stale").failureCode, "QUEUE_TIMEOUT");
  assert.equal(data.generationTasks.find((task) => task.id === "running-stale").failureCode, "WORKER_TIMEOUT");
  assert.equal(refundFailureCount(data), 0);
});

test("refund failure count flags terminal tasks with incomplete refunds", () => {
  const now = new Date("2026-07-04T12:00:00.000Z").toISOString();
  const task = generationTask("partial-refund", "FAILED", now, now, 40);
  const data = {
    creditAccounts: [makeAccount("u1", 70, 100, 30)],
    creditLedgerEntries: [
      taskSpend(task.id, "u1", 40, now),
      {
        id: "refund-partial-refund",
        userId: "u1",
        type: "REFUND",
        amount: 10,
        balanceAfter: 70,
        sourceType: "TASK",
        sourceId: task.id,
        idempotencyKey: `task-partial-refund:${task.id}`,
        remark: "partial refund",
        createdAt: now,
        expiresAt: null
      }
    ],
    generationTasks: [task]
  };

  assert.equal(refundFailureCount(data), 1);

  const result = runGenerationMaintenance(data, { now });

  assert.equal(result.reconciledRefunds, 1);
  assert.equal(result.refundedCredits, 30);
  assert.equal(refundFailureCount(data), 0);
  assert.equal(data.creditAccounts[0].balance, 100);
  assert.equal(data.creditAccounts[0].totalSpent, 0);
});
