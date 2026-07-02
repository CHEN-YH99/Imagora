import assert from "node:assert/strict";
import test from "node:test";
import { creditSourceRemainders, expireCredits } from "../packages/shared/dist/index.js";

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
