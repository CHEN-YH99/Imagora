import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../packages/database/dist/index.js";
import { createEmptyStoreData } from "../packages/database/dist/prisma-store-persistence.js";
import { createGenerationMaintenanceRunner } from "../packages/database/dist/maintenance-runtime.js";

const now = "2026-09-28T12:00:00.000Z";
const earlier = "2026-09-28T10:00:00.000Z";
const later = "2026-09-29T12:00:00.000Z";
const options = { pendingTimeoutMs: 60_000, runningTimeoutMs: 120_000 };
const noChanges = {
  failedPendingTasks: 0,
  failedRunningTasks: 0,
  reconciledRefunds: 0,
  refundedCredits: 0,
  expiredCredits: 0
};

test("maintenance runner scopes timeout refunds and expires credits using each selected user's complete FIFO ledger", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const data = createEmptyStoreData();
  data.generationTasks = [
    task("pending", "task-user", "PENDING"),
    task("running", "task-user", "RUNNING", earlier),
    task("partial", "task-user", "FAILED"),
    task("unrelated", "other-user", "SUCCEEDED")
  ];
  data.creditAccounts = [
    account("task-user", 90, 200, 110),
    account("expiry-user", 140, 330, 190),
    account("other-user", 70, 100, 30)
  ];
  data.creditLedgerEntries = [
    grant("task-funds", "task-user", 200, null),
    ledger("spend-pending", "task-user", "SPEND", -40, "pending"),
    ledger("spend-running", "task-user", "SPEND", -40, "running"),
    ledger("spend-partial", "task-user", "SPEND", -40, "partial"),
    ledger("partial-refund", "task-user", "REFUND", 10, "partial"),
    grant("previous-expiry", "expiry-user", 100, earlier),
    {
      ...ledger("already-expired", "expiry-user", "EXPIRE", -100, "previous-expiry"),
      sourceType: "SYSTEM",
      idempotencyKey: "credit-expire:previous-expiry"
    },
    grant("due", "expiry-user", 100, now),
    grant("future", "expiry-user", 100, later),
    ledger("prior-refund", "expiry-user", "REFUND", 20, "previous-task"),
    { ...ledger("positive-adjust", "expiry-user", "ADJUST", 10, "admin-adjust"), sourceType: "ADMIN" },
    { ...ledger("negative-adjust", "expiry-user", "ADJUST", -20, "admin-adjust"), sourceType: "ADMIN" },
    ledger("spent", "expiry-user", "SPEND", -70, "finished-task"),
    grant("other-funds", "other-user", 100, later),
    ledger("other-spend", "other-user", "SPEND", -30, "unrelated")
  ];
  const realStore = await temporaryStore(data);
  const spy = spyStore(realStore);
  const runner = createGenerationMaintenanceRunner(spy);

  assert.deepEqual(await runner.run(options), {
    failedPendingTasks: 1,
    failedRunningTasks: 1,
    reconciledRefunds: 3,
    refundedCredits: 110,
    expiredCredits: 1
  });
  const persisted = await realStore.read();
  assert.equal(persisted.creditAccounts.find((item) => item.userId === "task-user").balance, 200);
  assert.equal(persisted.creditAccounts.find((item) => item.userId === "task-user").totalSpent, 0);
  assert.equal(persisted.creditAccounts.find((item) => item.userId === "expiry-user").balance, 130);
  assert.deepEqual(
    persisted.creditAccounts.find((item) => item.userId === "other-user"),
    data.creditAccounts[2]
  );
  assert.equal(persisted.generationTasks.find((item) => item.id === "unrelated").status, "SUCCEEDED");
  assert.equal(persisted.creditLedgerEntries.find((item) => item.idempotencyKey === "credit-expire:due").amount, -10);
  assert.equal(persisted.creditLedgerEntries.find((item) => item.idempotencyKey === "task-refund:partial").amount, 30);
  assert.deepEqual(spy.scopes[0], {
    generationTasks: { ids: ["partial", "pending", "running"] },
    creditAccounts: { userIds: ["task-user"] },
    creditLedgerEntries: "loadedTasks"
  });
  assert.deepEqual(spy.scopes[1], {
    creditAccounts: { userIds: ["expiry-user"] },
    creditLedgerEntries: { userIds: ["expiry-user"] }
  });
  assert.equal(spy.loadedLedgers[1].length, 8);
  assert.deepEqual(
    new Set(spy.loadedLedgers[1].map((item) => item.type)),
    new Set(["GRANT", "EXPIRE", "REFUND", "ADJUST", "SPEND"])
  );
  assert.equal(spy.retentionCalls.length, 0);

  assert.deepEqual(await runner.run(options), noChanges);
  assert.equal(spy.scopes.length, 2);
  assert.deepEqual(await realStore.read(), persisted);
});

test("missing-account tasks and fully consumed grant batches do not starve later users and tasks", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const data = createEmptyStoreData();
  data.generationTasks = [task("a-broken", "missing-account", "FAILED"), task("b-ready", "task-user", "BLOCKED")];
  data.creditAccounts = [
    account("task-user", 60, 100, 40),
    account("user-a", 0, 40, 40),
    account("user-b", 40, 100, 60)
  ];
  data.creditLedgerEntries = [
    ledger("broken-spend", "missing-account", "SPEND", -40, "a-broken"),
    grant("task-grant", "task-user", 100, null),
    ledger("ready-spend", "task-user", "SPEND", -40, "b-ready"),
    grant("fully-spent", "user-a", 40, earlier),
    ledger("all-spent", "user-a", "SPEND", -40, "other-a"),
    grant("partly-spent", "user-b", 100, earlier),
    ledger("part-spent", "user-b", "SPEND", -60, "other-b")
  ];
  const realStore = await temporaryStore(data);
  const spy = spyStore(realStore);
  const runner = createGenerationMaintenanceRunner(spy);
  const small = { ...options, taskBatchSize: 1, creditUserBatchSize: 1 };
  assert.deepEqual(await runner.run(small), noChanges);
  assert.deepEqual(await runner.run(small), {
    ...noChanges,
    reconciledRefunds: 1,
    refundedCredits: 40,
    expiredCredits: 1
  });
  assert.deepEqual(await runner.run(small), noChanges);
  assert.deepEqual(
    spy.scopes.filter((scope) => scope.generationTasks).map((scope) => scope.generationTasks.ids),
    [["a-broken"], ["b-ready"], ["a-broken"]]
  );
  assert.deepEqual(
    spy.scopes.filter((scope) => !scope.generationTasks).map((scope) => scope.creditAccounts.userIds),
    [["user-a"], ["user-b"], ["user-a"]]
  );

  await realStore.update((current) => {
    current.creditAccounts.push(account("missing-account", 0, 40, 40));
  });
  assert.equal((await runner.run(small)).refundedCredits, 40);
  assert.equal((await realStore.read()).creditAccounts.find((item) => item.userId === "missing-account").balance, 40);
});

test("tail batches wrap without duplicates and each runner owns its cursor", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const data = createEmptyStoreData();
  data.generationTasks = ["a", "b", "c"].map((id) => task(id, "missing-account", "FAILED"));
  data.creditLedgerEntries = data.generationTasks.map((item) =>
    ledger(`spend-${item.id}`, item.userId, "SPEND", -40, item.id)
  );
  const spy = spyStore(await temporaryStore(data));
  const runner = createGenerationMaintenanceRunner(spy);
  const settings = { ...options, taskBatchSize: 2 };
  await runner.run(settings);
  await runner.run(settings);
  await runner.run(settings);
  await createGenerationMaintenanceRunner(spy).run(settings);
  assert.deepEqual(
    spy.scopes.map((scope) => scope.generationTasks.ids),
    [
      ["a", "b"],
      ["c", "a"],
      ["b", "c"],
      ["a", "b"]
    ]
  );
  assert.ok(spy.taskQueries.every((query) => query.limit === 2));
});

test("overlapping calls share a promise, snapshot options and use one maintenance timestamp", async (t) => {
  let clock = Date.parse(now);
  t.mock.method(Date, "now", () => clock);
  const gate = deferred();
  const calls = [];
  const store = {
    async readGenerationMaintenanceCandidates(query) {
      calls.push(["tasks", query]);
      await gate.promise;
      clock += 86_400_000;
      return [];
    },
    async readCreditExpiryUsers(query) {
      calls.push(["users", query]);
      return [];
    },
    async trimOperationalIncidents(keep) {
      calls.push(["trim", keep]);
      return 0;
    },
    async updateScoped() {
      assert.fail("empty candidate batches must not open write transactions");
    }
  };
  const runner = createGenerationMaintenanceRunner(store);
  const mutableOptions = { ...options };
  const first = runner.run(mutableOptions);
  mutableOptions.incidentRetentionMax = 100;
  const overlapping = runner.run({ ...options, incidentRetentionMax: 1 });
  assert.equal(first, overlapping);
  gate.resolve();
  assert.deepEqual(await first, noChanges);
  assert.equal(calls.filter(([kind]) => kind === "tasks").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "users").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "trim").length, 0);
  const taskQuery = calls.find(([kind]) => kind === "tasks")[1];
  assert.equal(taskQuery.limit, 100);
  assert.equal(taskQuery.pendingBefore, new Date(Date.parse(now) - options.pendingTimeoutMs).toISOString());
  assert.equal(taskQuery.runningBefore, new Date(Date.parse(now) - options.runningTimeoutMs).toISOString());
  assert.equal(calls.find(([kind]) => kind === "users")[1].now, now);
  assert.equal(calls.find(([kind]) => kind === "users")[1].limit, 10);

  await runner.run({ pendingTimeoutMs: 0, runningTimeoutMs: 0, incidentRetentionMax: 7 });
  assert.deepEqual(
    calls.filter(([kind]) => kind === "trim"),
    [["trim", 7]]
  );
  assert.equal(calls.filter(([kind]) => kind === "tasks")[1][1].pendingBefore, undefined);
  assert.equal(calls.filter(([kind]) => kind === "tasks")[1][1].runningBefore, undefined);
});

test("a failed task transaction clears in-flight state and retries after advancing to the next task", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const data = createEmptyStoreData();
  data.generationTasks = [task("a", "user", "FAILED"), task("b", "user", "CANCELED")];
  data.creditAccounts = [account("user", 20, 100, 80)];
  data.creditLedgerEntries = [
    grant("funds", "user", 100, null),
    ledger("spend-a", "user", "SPEND", -40, "a"),
    ledger("spend-b", "user", "SPEND", -40, "b")
  ];
  const realStore = await temporaryStore(data);
  const spy = spyStore(realStore);
  const originalUpdate = spy.updateScoped.bind(spy);
  let shouldFail = true;
  spy.updateScoped = async (scope, mutate) => {
    if (scope.generationTasks?.ids[0] === "a" && shouldFail) {
      shouldFail = false;
      throw new Error("task-transaction-failed");
    }
    return originalUpdate(scope, mutate);
  };
  const runner = createGenerationMaintenanceRunner(spy);
  const settings = { ...options, taskBatchSize: 1 };
  await assert.rejects(runner.run(settings), /task-transaction-failed/);
  assert.equal((await runner.run(settings)).refundedCredits, 40);
  assert.equal((await runner.run(settings)).refundedCredits, 40);
  assert.deepEqual(
    spy.scopes.map((scope) => scope.generationTasks.ids),
    [["b"], ["a"]]
  );
  const persisted = await realStore.read();
  assert.equal(persisted.creditAccounts[0].balance, 100);
  assert.equal(persisted.creditLedgerEntries.filter((entry) => entry.type === "REFUND").length, 2);
});

test("a failed credit-expiry transaction advances the user cursor and retries on wrap", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const data = createEmptyStoreData();
  data.creditAccounts = [account("a", 40, 40, 0), account("b", 40, 40, 0)];
  data.creditLedgerEntries = [grant("grant-a", "a", 40, earlier), grant("grant-b", "b", 40, earlier)];
  const realStore = await temporaryStore(data);
  const spy = spyStore(realStore);
  const originalUpdate = spy.updateScoped.bind(spy);
  let shouldFail = true;
  spy.updateScoped = async (scope, mutate) => {
    if (scope.creditAccounts.userIds[0] === "a" && shouldFail) {
      shouldFail = false;
      throw new Error("expiry-transaction-failed");
    }
    return originalUpdate(scope, mutate);
  };
  const runner = createGenerationMaintenanceRunner(spy);
  const settings = { ...options, creditUserBatchSize: 1 };
  await assert.rejects(runner.run(settings), /expiry-transaction-failed/);
  assert.equal((await runner.run(settings)).expiredCredits, 1);
  assert.equal((await runner.run(settings)).expiredCredits, 1);
  assert.deepEqual(
    spy.scopes.map((scope) => scope.creditAccounts.userIds),
    [["b"], ["a"]]
  );
  assert.ok((await realStore.read()).creditAccounts.every((item) => item.balance === 0));
});

test("invalid runner options reject before any store access", async () => {
  const runner = createGenerationMaintenanceRunner(
    new Proxy(
      {},
      {
        get() {
          assert.fail("invalid options must not access the store");
        }
      }
    )
  );
  for (const override of [
    { taskBatchSize: 0 },
    { creditUserBatchSize: 1001 },
    { pendingTimeoutMs: -1 },
    { runningTimeoutMs: NaN },
    { incidentRetentionMax: -1 }
  ]) {
    await assert.rejects(runner.run({ ...options, ...override }), RangeError);
  }
});

async function temporaryStore(data) {
  const directory = await mkdtemp(join(tmpdir(), "imagora-maintenance-runner-"));
  const store = new JsonStore(join(directory, "store.json"));
  await store.write(data);
  return store;
}

function spyStore(store) {
  return {
    scopes: [],
    loadedLedgers: [],
    taskQueries: [],
    userQueries: [],
    retentionCalls: [],
    async readGenerationMaintenanceCandidates(query) {
      this.taskQueries.push(globalThis.structuredClone(query));
      return store.readGenerationMaintenanceCandidates(query);
    },
    async readCreditExpiryUsers(query) {
      this.userQueries.push(globalThis.structuredClone(query));
      return store.readCreditExpiryUsers(query);
    },
    async updateScoped(scope, mutate) {
      this.scopes.push(globalThis.structuredClone(scope));
      return store.updateScoped(scope, (data) => {
        this.loadedLedgers.push(globalThis.structuredClone(data.creditLedgerEntries));
        return mutate(data);
      });
    },
    async trimOperationalIncidents(keep) {
      this.retentionCalls.push(keep);
      return store.trimOperationalIncidents(keep);
    }
  };
}

function task(id, userId, status, startedAt = null) {
  return { id, userId, status, creditCost: 40, createdAt: earlier, updatedAt: earlier, startedAt };
}

function account(userId, balance, totalEarned, totalSpent) {
  return { userId, balance, totalEarned, totalSpent, updatedAt: earlier };
}

function ledger(id, userId, type, amount, sourceId) {
  return {
    id,
    userId,
    type,
    amount,
    balanceAfter: 0,
    sourceType: "TASK",
    sourceId,
    idempotencyKey: id,
    remark: "fixture",
    createdAt: earlier,
    expiresAt: null
  };
}

function grant(id, userId, amount, expiresAt) {
  return { ...ledger(id, userId, "GRANT", amount, `order-${id}`), sourceType: "ORDER", expiresAt };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
