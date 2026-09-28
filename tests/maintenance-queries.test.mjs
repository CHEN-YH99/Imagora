import assert from "node:assert/strict";
import test from "node:test";
import { expireCredits, runGenerationMaintenance } from "../packages/shared/dist/index.js";
import {
  readPrismaCreditExpiryUsers,
  readPrismaGenerationCandidates,
  selectCreditExpiryUsers,
  selectGenerationCandidates,
  trimPrismaIncidents
} from "../packages/database/dist/maintenance-queries.js";

const now = "2026-09-28T12:00:00.000Z";
const cutoff = "2026-09-28T11:00:00.000Z";
const earlier = "2026-09-28T10:00:00.000Z";
const future = "2026-09-28T13:00:00.000Z";

test("generation candidates include both timeouts and missing terminal refunds without over-refunding", () => {
  const data = storeData();
  data.generationTasks = [
    task("pending-due", "PENDING", cutoff),
    task("pending-fresh", "PENDING", now),
    task("pending-invalid", "PENDING", "invalid"),
    task("running-due", "RUNNING", now, cutoff),
    task("running-fresh", "RUNNING", earlier, now),
    task("running-unstarted", "RUNNING", earlier),
    task("failed", "FAILED"),
    task("blocked", "BLOCKED"),
    task("canceled-partial", "CANCELED"),
    task("failed-canonical-refund", "FAILED"),
    task("failed-refunded", "FAILED"),
    task("failed-without-spend", "FAILED"),
    task("failed-wrong-source", "FAILED"),
    task("failed-free", "FAILED", earlier, null, 0),
    task("succeeded", "SUCCEEDED")
  ];
  data.creditLedgerEntries = data.generationTasks
    .filter((item) => item.id !== "failed-without-spend")
    .map((item) => ledger(`spend-${item.id}`, item.id, "SPEND", -40));
  data.creditLedgerEntries.find((item) => item.sourceId === "failed-wrong-source").sourceType = "ORDER";
  data.creditLedgerEntries.push(
    ledger("partial", "canceled-partial", "REFUND", 10),
    ledger("canonical", "failed-canonical-refund", "REFUND", 10, "task-refund:failed-canonical-refund"),
    ledger("fully-refunded", "failed-refunded", "REFUND", 40),
    ledger("wrong-sign-spend", "failed-without-spend", "SPEND", 40),
    ledger("wrong-sign-refund", "failed", "REFUND", -100),
    ledger("unrelated-grant", "failed-without-spend", "GRANT", 40)
  );
  const snapshot = globalThis.structuredClone(data);
  const query = { pendingBefore: cutoff, runningBefore: cutoff, limit: 100 };
  const candidates = selectGenerationCandidates(data, query);
  assert.deepEqual(
    candidates.map((item) => item.id),
    ["blocked", "canceled-partial", "failed", "pending-due", "running-due"]
  );
  assert.deepEqual(data, snapshot);
  candidates[0].userId = "changed-copy";
  assert.equal(data.generationTasks.find((item) => item.id === "blocked").userId, "user-1");

  const complete = globalThis.structuredClone(data);
  const scoped = globalThis.structuredClone(data);
  const ids = new Set(selectGenerationCandidates(data, query).map((item) => item.id));
  scoped.generationTasks = scoped.generationTasks.filter((item) => ids.has(item.id));
  const options = { now, pendingTimeoutMs: 60 * 60_000, runningTimeoutMs: 60 * 60_000 };
  assert.deepEqual(runGenerationMaintenance(scoped, options), runGenerationMaintenance(complete, options));
  assert.deepEqual(scoped.creditAccounts, complete.creditAccounts);
  assert.deepEqual(normalizedLedger(scoped), normalizedLedger(complete));
});

test("generation candidates keep missing-account tasks pageable and honor global refund keys", () => {
  const data = storeData();
  data.creditAccounts = [];
  data.generationTasks = [task("a", "FAILED"), task("b", "BLOCKED"), task("c", "CANCELED")];
  data.creditLedgerEntries = data.generationTasks.map((item) => ledger(`spend-${item.id}`, item.id, "SPEND", -40));
  data.creditLedgerEntries.push({
    ...ledger("foreign-key", "unrelated", "ADJUST", 0, "task-refund:b"),
    userId: "another-user",
    sourceType: "SYSTEM"
  });
  assert.deepEqual(selectGenerationCandidates(data, { limit: 1 }), [{ id: "a", userId: "user-1" }]);
  assert.deepEqual(selectGenerationCandidates(data, { afterId: "a", limit: 1 }), [{ id: "c", userId: "user-1" }]);
  assert.deepEqual(selectGenerationCandidates(data, { afterId: "c", limit: 1 }), []);
  assert.deepEqual(selectGenerationCandidates(data, { limit: 1 }), [{ id: "a", userId: "user-1" }]);
});

test("expiry candidates deduplicate users and let a spent batch advance past the first page", () => {
  const data = expiryData();
  const before = globalThis.structuredClone(data);
  assert.deepEqual(selectCreditExpiryUsers(data, { now, limit: 1 }), ["user-a"]);
  assert.deepEqual(selectCreditExpiryUsers(data, { now, afterUserId: "user-a", limit: 1 }), ["user-b"]);
  assert.deepEqual(selectCreditExpiryUsers(data, { now, afterUserId: "user-b", limit: 1 }), []);
  assert.deepEqual(selectCreditExpiryUsers(data, { now, limit: 100 }), ["user-a", "user-b"]);
  assert.deepEqual(data, before);

  const selected = new Set(selectCreditExpiryUsers(data, { now, limit: 100 }));
  const scoped = globalThis.structuredClone(data);
  scoped.creditAccounts = scoped.creditAccounts.filter((account) => selected.has(account.userId));
  scoped.creditLedgerEntries = scoped.creditLedgerEntries.filter((entry) => selected.has(entry.userId));
  const complete = globalThis.structuredClone(data);
  assert.equal(expireCredits(scoped, now), expireCredits(complete, now));
  assert.deepEqual(
    scoped.creditAccounts,
    complete.creditAccounts.filter((account) => selected.has(account.userId))
  );
  assert.deepEqual(
    normalizedLedger(scoped),
    normalizedLedger(complete).filter((entry) => selected.has(entry.userId))
  );
  assert.deepEqual(
    scoped.creditLedgerEntries.filter((entry) => entry.type === "EXPIRE").map((entry) => entry.amount),
    [-10]
  );
});

test("candidate cursors use stable byte order for mixed-case and Unicode identifiers", () => {
  const data = storeData();
  const ids = ["a", "\u{10000}", "A", "\ue000"];
  data.generationTasks = ids.map((id) => task(id, "PENDING", earlier));
  data.creditLedgerEntries = ids.map((id) => grant(`grant-${id}`, id, 1, cutoff));
  const expected = ["A", "a", "\ue000", "\u{10000}"];
  assert.deepEqual(
    selectGenerationCandidates(data, { pendingBefore: cutoff, limit: 10 }).map((item) => item.id),
    expected
  );
  assert.deepEqual(selectCreditExpiryUsers(data, { now, limit: 10 }), expected);
  assert.deepEqual(selectCreditExpiryUsers(data, { now, afterUserId: "a", limit: 10 }), expected.slice(2));
});

test("Prisma generation queries bind cursors, timestamps and limits and filter before pagination", async () => {
  const calls = [];
  const expected = [{ id: "task-a", userId: "user-1" }];
  const client = queryClient(calls, expected);
  const afterId = "cursor' OR TRUE; --";
  assert.deepEqual(
    await readPrismaGenerationCandidates(client, { pendingBefore: cutoff, runningBefore: earlier, afterId, limit: 7 }),
    expected
  );
  assert.equal(calls.length, 1);
  const query = calls[0];
  assert.ok(!query.text.includes(afterId));
  assert.ok(!query.text.includes(cutoff));
  assert.deepEqual(query.values, [new Date(cutoff), new Date(earlier), afterId, 7]);
  assert.match(query.text, /task\.status IN \('FAILED', 'BLOCKED', 'CANCELED'\)/);
  assert.match(query.text, /NOT EXISTS[\s\S]*idempotency_key = 'task-refund:' \|\| task\.id/);
  assert.match(query.text, /WHEN ledger\.type = 'SPEND' THEN GREATEST\(-ledger\.amount::bigint, 0\)/);
  assert.match(query.text, /WHEN ledger\.type = 'REFUND' THEN -GREATEST\(ledger\.amount::bigint, 0\)/);
  assert.match(query.text, /ledger\.source_type = 'TASK' AND ledger\.source_id = task\.id/);
  assert.match(
    query.text,
    /AND task\.id COLLATE "C" > \$\d+[\s\S]*ORDER BY task\.id COLLATE "C" ASC[\s\S]*LIMIT \$\d+/
  );

  await readPrismaGenerationCandidates(client, { limit: 1 });
  assert.deepEqual(calls[1].values, [1]);
  assert.doesNotMatch(calls[1].text, /task\.status = 'PENDING'|task\.status = 'RUNNING'/);
});

test("Prisma expiry queries deduplicate and paginate users in SQL with global expiry-key exclusion", async () => {
  const calls = [];
  const afterUserId = "user' UNION SELECT password_hash FROM users; --";
  const result = await readPrismaCreditExpiryUsers(queryClient(calls, [{ userId: "user-b" }]), {
    now,
    afterUserId,
    limit: 2
  });
  assert.deepEqual(result, ["user-b"]);
  const query = calls[0];
  assert.deepEqual(query.values, [new Date(now), afterUserId, 2]);
  assert.ok(!query.text.includes(afterUserId));
  assert.match(query.text, /SELECT DISTINCT grant_entry\.user_id COLLATE "C" AS "userId"/);
  assert.match(query.text, /grant_entry\.type = 'GRANT' AND grant_entry\.amount > 0/);
  assert.match(query.text, /grant_entry\.expires_at <= \$\d+/);
  assert.match(query.text, /NOT EXISTS[\s\S]*expired\.idempotency_key = 'credit-expire:' \|\| grant_entry\.id/);
  assert.match(
    query.text,
    /AND grant_entry\.user_id COLLATE "C" > \$\d+[\s\S]*ORDER BY "userId" ASC[\s\S]*LIMIT \$\d+/
  );
});

test("invalid maintenance bounds fail before querying rather than scan without a limit", async () => {
  const data = storeData();
  const client = {
    async $queryRaw() {
      throw new Error("database should not be queried");
    }
  };
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
    assert.throws(() => selectGenerationCandidates(data, { limit }), RangeError);
    assert.throws(() => selectCreditExpiryUsers(data, { now, limit }), RangeError);
    await assert.rejects(readPrismaGenerationCandidates(client, { limit }), RangeError);
    await assert.rejects(readPrismaCreditExpiryUsers(client, { now, limit }), RangeError);
  }
  assert.throws(() => selectGenerationCandidates(data, { pendingBefore: "invalid", limit: 1 }), RangeError);
  assert.throws(() => selectCreditExpiryUsers(data, { now: "invalid", limit: 1 }), RangeError);
  await assert.rejects(readPrismaGenerationCandidates(client, { runningBefore: "invalid", limit: 1 }), RangeError);
  await assert.rejects(readPrismaCreditExpiryUsers(client, { now: "invalid", limit: 1 }), RangeError);
});

test("incident pruning binds retention and removes only rows after deterministic newest-first ordering", async () => {
  const calls = [];
  const client = {
    async $executeRaw(query) {
      calls.push(query);
      return 12;
    }
  };
  assert.equal(await trimPrismaIncidents(client, 100), 12);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [100]);
  assert.match(calls[0].text, /DELETE FROM operational_incidents[\s\S]*WHERE id IN/);
  assert.match(calls[0].text, /ORDER BY updated_at DESC, id COLLATE "C" DESC[\s\S]*OFFSET \$1/);
  assert.equal(await trimPrismaIncidents(client, 0), 12);
  assert.deepEqual(calls[1].values, [0]);
  for (const keep of [-1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(trimPrismaIncidents(client, keep), RangeError);
  }
  assert.equal(calls.length, 2);
});

function storeData() {
  return {
    generationTasks: [],
    creditAccounts: [{ userId: "user-1", balance: 0, totalEarned: 1000, totalSpent: 1000, updatedAt: earlier }],
    creditLedgerEntries: []
  };
}

function task(id, status, createdAt = earlier, startedAt = null, creditCost = 40) {
  return { id, userId: "user-1", status, createdAt, startedAt, creditCost, updatedAt: createdAt };
}

function ledger(id, sourceId, type, amount, idempotencyKey = id) {
  return {
    id,
    userId: "user-1",
    sourceId,
    sourceType: "TASK",
    type,
    amount,
    idempotencyKey,
    expiresAt: null,
    createdAt: earlier
  };
}

function grant(id, userId, amount, expiresAt) {
  return { ...ledger(id, `order-${id}`, "GRANT", amount), sourceType: "ORDER", userId, expiresAt };
}

function expiryData() {
  const data = storeData();
  data.creditAccounts = ["user-a", "user-b", "user-c"].map((userId) => ({
    userId,
    balance: userId === "user-b" ? 110 : 0,
    totalEarned: 200,
    totalSpent: userId === "user-b" ? 90 : 200,
    updatedAt: earlier
  }));
  data.creditLedgerEntries = [
    grant("spent", "user-a", 40, cutoff),
    { ...ledger("spent-all", "task-a", "SPEND", -40), userId: "user-a" },
    grant("partial", "user-b", 100, now),
    grant("second", "user-b", 100, future),
    { ...ledger("spent-partial", "task-b", "SPEND", -90), userId: "user-b" },
    grant("zero", "zero-user", 0, cutoff),
    grant("negative", "negative-user", -40, cutoff),
    grant("permanent", "permanent-user", 40, null),
    grant("invalid-date", "invalid-user", 40, "invalid"),
    grant("future", "future-user", 40, future),
    { ...grant("not-grant", "refund-user", 40, cutoff), type: "REFUND" },
    grant("already-expired", "user-c", 40, cutoff),
    {
      ...ledger("expiry-key", "unrelated-source", "EXPIRE", -40, "credit-expire:already-expired"),
      userId: "user-c",
      sourceType: "SYSTEM"
    }
  ];
  return data;
}

function normalizedLedger(data) {
  return data.creditLedgerEntries.map(({ id: _id, ...entry }) => entry);
}

function queryClient(calls, rows) {
  return {
    async $queryRaw(query) {
      calls.push(query);
      return rows;
    },
    async $queryRawUnsafe() {
      throw new Error("unsafe query must not be used");
    }
  };
}
