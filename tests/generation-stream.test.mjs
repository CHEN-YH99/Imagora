import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JsonStore, PrismaStore } from "../packages/database/dist/index.js";
import { createEmptyStoreData } from "../packages/database/dist/prisma-store-persistence.js";
import { createGenerationProgress, generationMetadataFromTask } from "../packages/shared/dist/index.js";
import { createGenerationEventsRuntime } from "../apps/api/dist/generation-events-runtime.js";
import { createGenerationProgressReporter } from "../apps/worker/dist/generation-progress-runtime.js";

const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const task = {
  id: "task-1",
  userId: "user-1",
  clientRequestId: "request-1",
  referenceImageId: null,
  prompt: "isolated stream fixture",
  negativePrompt: null,
  style: "none",
  aspectRatio: "1:1",
  width: 1024,
  height: 1024,
  quantity: 4,
  quality: "standard",
  modelProvider: "mock",
  modelName: "mock:default",
  status: "RUNNING",
  creditCost: 20,
  providerCostCents: 0,
  failureCode: null,
  failureMessage: null,
  startedAt: now,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  progress: createGenerationProgress("GENERATING", now)
};
const image = {
  id: "image-1",
  taskId: task.id,
  userId: task.userId,
  projectId: null,
  storageKey: "fixture.png",
  thumbnailKey: "fixture-thumb.png",
  thumbnailUrl: "",
  publicUrl: "",
  width: 1024,
  height: 1024,
  fileSize: 100,
  mimeType: "image/png",
  safetyStatus: "PASSED",
  visibility: "PRIVATE",
  generationMetadata: generationMetadataFromTask(task),
  deletedAt: null,
  createdAt: now
};
const entry = {
  id: "refund-1",
  userId: task.userId,
  type: "REFUND",
  sourceType: "TASK",
  sourceId: task.id,
  amount: 5,
  balanceAfter: 100,
  idempotencyKey: "task-refund:task-1",
  remark: "fixture",
  expiresAt: null,
  createdAt: now
};
function streamData() {
  return {
    sessions: [{ token: "session-1", userId: task.userId, userStatus: "ACTIVE", expiresAt }],
    generationTasks: [globalThis.structuredClone(task)],
    generatedImages: [],
    creditLedgerEntries: []
  };
}
function storeData() {
  return {
    ...createEmptyStoreData(),
    users: [{ id: task.userId, status: "ACTIVE" }],
    sessions: [{ token: "session-1", userId: task.userId, expiresAt, createdAt: now }],
    generationTasks: [globalThis.structuredClone(task)],
    generatedImages: [globalThis.structuredClone(image)],
    creditLedgerEntries: [entry]
  };
}
function row(value, fields) {
  return Object.fromEntries(
    Object.entries(value).map(([key, value]) => [key, fields.includes(key) && value ? new Date(value) : value])
  );
}
async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(5);
  }
}

test("Prisma stream reads only subscribed sessions and tasks in a consistent snapshot without advisory locks", async () => {
  const calls = [];
  const tx = {
    session: {
      async findMany(args) {
        calls.push(["session", args]);
        return [
          { token: "session-1", userId: task.userId, expiresAt: new Date(expiresAt), user: { status: "ACTIVE" } }
        ];
      }
    },
    generationTask: {
      async findMany(args) {
        calls.push(["task", args]);
        return [row(task, ["startedAt", "completedAt", "createdAt", "updatedAt"])];
      }
    },
    generatedImage: {
      async findMany(args) {
        calls.push(["image", args]);
        return [row(image, ["createdAt", "deletedAt"])];
      }
    },
    creditLedgerEntry: {
      async findMany(args) {
        calls.push(["ledger", args]);
        return [row(entry, ["createdAt", "expiresAt"])];
      }
    },
    async $executeRawUnsafe() {
      assert.fail("stream must not acquire advisory locks");
    }
  };
  const prisma = {
    async $transaction(run, options) {
      assert.equal(options.isolationLevel, "RepeatableRead");
      return run(tx);
    }
  };
  const result = await new PrismaStore(prisma).readGenerationStream({
    taskIds: [task.id],
    sessionTokens: ["session-1"]
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0][1].where.token.in, ["session-1"]);
  assert.deepEqual(calls[1][1].where, { id: { in: [task.id] }, userId: { in: [task.userId] } });
  assert.deepEqual(calls[2][1].where, { taskId: { in: [task.id] }, userId: { in: [task.userId] }, deletedAt: null });
  assert.deepEqual(calls[3][1].where, {
    userId: { in: [task.userId] },
    sourceType: "TASK",
    sourceId: { in: [task.id] },
    type: "REFUND"
  });
  assert.equal(result.generatedImages[0].id, image.id);
  assert.equal(result.creditLedgerEntries[0].amount, 5);
  assert.equal(result.generationTasks[0].startedAt, task.startedAt);
  calls.length = 0;
  const unchanged = await new PrismaStore(prisma).readGenerationStream({
    taskIds: [task.id],
    sessionTokens: ["session-1"],
    knownTaskVersions: { [task.id]: [task.updatedAt, task.progress.sequence ?? 0, task.status].join(":") }
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["session", "task"]
  );
  assert.equal(unchanged.generationTasks.length, 1);
  assert.equal(unchanged.generatedImages.length, 0);
  assert.equal(unchanged.creditLedgerEntries.length, 0);
  tx.session.findMany = async () => [];
  calls.length = 0;
  assert.deepEqual(
    (await new PrismaStore(prisma).readGenerationStream({ taskIds: [task.id], sessionTokens: ["invalid"] }))
      .generationTasks,
    []
  );
  assert.equal(calls.length, 0, "invalid sessions must not query task data");
});

test("Prisma targeted reads scope sessions, task pages and orders without initializing or scanning other tables", async () => {
  const calls = [];
  const user = {
    id: task.userId,
    email: "test@example.test",
    passwordHash: "unused",
    nickname: "test",
    avatarUrl: null,
    role: "USER",
    status: "ACTIVE",
    emailVerifiedAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now
  };
  const plan = {
    id: "plan-1",
    name: "test",
    description: "",
    priceCents: 100,
    currency: "USD",
    credits: 10,
    validDays: null,
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  };
  const order = {
    id: "order-1",
    userId: task.userId,
    planId: plan.id,
    orderNo: "test-order",
    amountCents: 100,
    currency: "USD",
    paymentProvider: "mock",
    paymentIntentId: null,
    status: "PENDING",
    paidAt: null,
    createdAt: now,
    updatedAt: now
  };
  const tx = {
    session: {
      async findUnique(args) {
        calls.push(["session", args]);
        return { user: row(user, ["createdAt", "updatedAt"]), expiresAt: new Date(expiresAt) };
      }
    },
    generationTask: {
      async findMany(args) {
        calls.push(["task", args]);
        return [row(task, ["startedAt", "createdAt", "updatedAt"])];
      },
      async count(args) {
        calls.push(["count", args]);
        return 42;
      }
    },
    generatedImage: {
      async findMany(args) {
        calls.push(["image", args]);
        return [row(image, ["createdAt"])];
      }
    },
    creditLedgerEntry: {
      async findMany(args) {
        calls.push(["ledger", args]);
        return [row(entry, ["createdAt"])];
      }
    },
    order: {
      async findMany(args) {
        calls.push(["order", args]);
        return [{ ...row(order, ["createdAt", "updatedAt"]), plan: row(plan, ["createdAt", "updatedAt"]) }];
      }
    },
    plan: {
      async findMany(args) {
        calls.push(["plan", args]);
        return [row(plan, ["createdAt", "updatedAt"])];
      }
    },
    async $executeRawUnsafe() {
      assert.fail("Reads must not acquire the Store advisory lock");
    }
  };
  const store = new PrismaStore({
    ...tx,
    async $transaction(run, options) {
      assert.equal(options.isolationLevel, "RepeatableRead");
      return run(tx);
    }
  });
  assert.deepEqual((await store.readSession("session-1")).user, user);
  assert.deepEqual(calls.pop()[1], { where: { token: "session-1" }, include: { user: true } });
  const page = await store.readGenerationTasks({ userId: task.userId, offset: 10, limit: 5, status: "RUNNING" });
  assert.equal(page.total, 42);
  assert.equal(page.generatedImages.length, 0);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["task", "count", "ledger"]
  );
  assert.deepEqual(calls[0][1], {
    where: { userId: task.userId, status: "RUNNING" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: 10,
    take: 5
  });
  assert.deepEqual(calls[1][1].where, calls[0][1].where);
  assert.deepEqual(calls[2][1].where, {
    userId: task.userId,
    sourceType: "TASK",
    sourceId: { in: [task.id] },
    type: "REFUND"
  });
  calls.length = 0;
  const detail = await store.readGenerationTasks({
    userId: task.userId,
    taskId: task.id,
    offset: 0,
    limit: 1,
    includeImages: true
  });
  assert.equal(detail.generatedImages[0].id, image.id);
  assert.equal(calls[0][1].where.id, task.id);
  assert.deepEqual(calls.find(([name]) => name === "image")[1].where, {
    userId: task.userId,
    taskId: { in: [task.id] },
    deletedAt: null
  });
  calls.length = 0;
  const batch = await store.readGenerationTasks({
    userId: task.userId,
    taskIds: [task.id, "second-task"],
    offset: 0,
    limit: 2,
    includeImages: true
  });
  assert.deepEqual(calls[0][1].where, { userId: task.userId, id: { in: [task.id, "second-task"] } });
  assert.equal(calls[0][1].take, 2);
  assert.equal(batch.generatedImages[0].id, image.id);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["task", "count", "image", "ledger"]
  );
  calls.length = 0;
  assert.equal((await store.readOrders({ userId: task.userId, limit: 7 })).orders[0].id, order.id);
  assert.equal(calls[0][1].take, 7);
  assert.deepEqual(calls[0][1].where, { userId: task.userId });
  assert.deepEqual(calls[0][1].include, { plan: false });
  const orderDetail = await store.readOrders({ userId: task.userId, orderId: order.id, limit: 1 });
  assert.deepEqual(orderDetail.plans, [plan]);
  assert.equal("plan" in orderDetail.orders[0], false);
  assert.deepEqual(await store.readActivePlans(), [plan]);

  tx.generationTask.findMany = async () => [];
  tx.generationTask.count = async () => 0;
  tx.generatedImage.findMany = tx.creditLedgerEntry.findMany = () =>
    assert.fail("Empty pages must not query related tables");
  assert.deepEqual(
    await store.readGenerationTasks({
      userId: "foreign-user",
      taskId: task.id,
      offset: 0,
      limit: 1,
      includeImages: true
    }),
    { generationTasks: [], generatedImages: [], creditLedgerEntries: [], total: 0 }
  );
});

test("Prisma initialization is shared and successful reads never reacquire the initialization lock", async () => {
  let transactions = 0,
    locks = 0,
    seedChecks = 0;
  const client = new Proxy(
    {
      async $transaction(run) {
        transactions++;
        return run(client);
      },
      async $executeRawUnsafe() {
        locks++;
      },
      user: {
        async count() {
          seedChecks++;
          return 1;
        },
        async findMany() {
          return [];
        }
      }
    },
    {
      get(target, key) {
        return (
          target[key] ?? {
            async findMany() {
              return [];
            }
          }
        );
      }
    }
  );
  const store = new PrismaStore(client);
  await Promise.all([store.initialize(), store.initialize(), store.initialize()]);
  await store.read();
  await store.read();
  assert.equal(transactions, 1);
  assert.equal(locks, 1);
  assert.equal(seedChecks, 1);
  let attempts = 0;
  const retry = new PrismaStore({
    async $transaction(run) {
      if (++attempts === 1) throw new Error("temporary connection failure");
      return run(client);
    }
  });
  await assert.rejects(retry.initialize(), /temporary connection failure/);
  await retry.initialize();
  assert.equal(attempts, 2);
});

test("Prisma order expiry only locks when the current user has expired pending orders", async () => {
  let candidate = false,
    transactions = 0;
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const where = { userId: task.userId, status: "PENDING", createdAt: { lte: new Date(cutoff) } };
  const store = new PrismaStore({
    order: {
      async findFirst(args) {
        assert.deepEqual(args, { where, select: { id: true } });
        return candidate ? { id: "order-1" } : null;
      }
    },
    async $transaction(run) {
      transactions++;
      return run({
        async $executeRawUnsafe(sql) {
          assert.match(sql, /pg_advisory_xact_lock/);
        },
        order: {
          async updateMany(args) {
            assert.deepEqual(args, { where, data: { status: "CLOSED", updatedAt: new Date(now) } });
            return { count: 1 };
          }
        }
      });
    }
  });
  assert.equal(await store.closeExpiredUserOrders(task.userId, cutoff, now), 0);
  assert.equal(transactions, 0);
  candidate = true;
  assert.equal(await store.closeExpiredUserOrders(task.userId, cutoff, now), 1);
  assert.equal(transactions, 1);
});

test("request authentication shares one scoped query and observes revoked sessions on the next request", async () => {
  const { createAuthRuntime } = await import("../apps/api/dist/auth-runtime.js");
  let calls = 0;
  let session = { user: { id: task.userId, status: "ACTIVE" }, expiresAt };
  const auth = createAuthRuntime({
    async read() {
      assert.fail("Identity-only authentication must not read the Store");
    },
    async readSession(token) {
      assert.equal(token, "session-1");
      calls++;
      return session;
    }
  });
  const request = { headers: { cookie: "imagora_session=session-1" } };
  await auth.readRequestSession(request);
  await auth.requireSession(request);
  await auth.requireSession(request);
  assert.equal(calls, 1);
  session = null;
  await assert.rejects(auth.requireSession({ ...request }), (error) => error.statusCode === 401);
  session = { user: { id: task.userId, status: "SUSPENDED" }, expiresAt };
  await assert.rejects(auth.requireSession({ ...request }), (error) => error.statusCode === 403);
  session = { user: { id: task.userId, status: "ACTIVE" }, expiresAt: "2000-01-01T00:00:00.000Z" };
  await assert.rejects(auth.requireSession({ ...request }), (error) => error.statusCode === 401);
  assert.equal(calls, 4);
});

test("JSON scoped reads isolate users, page tasks and keep cached snapshots immutable", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "imagora-scoped-read-"));
  const store = new JsonStore(join(dir, "store.json"));
  const data = storeData();
  data.generationTasks = [
    { ...task, id: "a" },
    { ...task, id: "b" },
    { ...task, id: "c", status: "FAILED" },
    { ...task, id: "foreign", userId: "another-user" }
  ];
  data.orders = [
    { id: "own", userId: task.userId, status: "PENDING", createdAt: "2000-01-01T00:00:00.000Z" },
    { id: "foreign", userId: "another-user", status: "PENDING", createdAt: "2000-01-01T00:00:00.000Z" }
  ];
  await store.write(data);
  const identity = await store.readSession("session-1");
  identity.user.status = "DELETED";
  assert.equal((await store.readSession("session-1")).user.status, "ACTIVE");
  const page = await store.readGenerationTasks({ userId: task.userId, status: "RUNNING", offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.generationTasks[0].id, "a");
  assert.deepEqual(
    (
      await store.readGenerationTasks({
        userId: task.userId,
        taskIds: ["a", "c", "foreign", "missing", "a"],
        offset: 0,
        limit: 100
      })
    ).generationTasks.map((task) => task.id),
    ["c", "a"]
  );
  assert.equal(
    (await store.readGenerationTasks({ userId: task.userId, taskId: "foreign", offset: 0, limit: 1 })).total,
    0
  );
  assert.equal((await store.readOrders({ userId: task.userId, limit: 1 })).orders[0].id, "own");
  assert.equal(await store.closeExpiredUserOrders(task.userId, now, now), 1);
  const snapshot = await store.read();
  assert.equal(snapshot.orders.find((order) => order.id === "foreign").status, "PENDING");
  snapshot.users[0].status = "SUSPENDED";
  assert.equal((await store.read()).users[0].status, "ACTIVE");
});

test("Prisma progress writes one guarded row without reading the store", async () => {
  const calls = [];
  const prisma = {
    async $transaction(run) {
      return run({
        async $executeRawUnsafe(sql) {
          calls.push(["lock", sql]);
        },
        generationTask: {
          async updateMany(args) {
            calls.push(["update", args]);
            return { count: 1 };
          }
        }
      });
    }
  };
  await new PrismaStore(prisma).updateGenerationProgress({
    taskId: task.id,
    startedAt: task.startedAt,
    progress: { ...task.progress, sequence: 3 }
  });
  assert.equal(calls.length, 2);
  const update = calls[1][1];
  assert.equal(update.where.id, task.id);
  assert.equal(update.where.status, "RUNNING");
  assert.equal(update.where.startedAt.toISOString(), task.startedAt);
  assert.equal(update.where.OR[1].progress.lt, 3);
  assert.deepEqual(Object.keys(update.data).sort(), ["progress", "updatedAt"]);
});

test("JSON stream reuses unchanged file content and sees other writers, logout and guarded progress", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "imagora-stream-cache-"));
  const filePath = join(dir, "store.json");
  const reader = new JsonStore(filePath);
  const writer = new JsonStore(filePath);
  const data = storeData();
  await writer.write(data);
  const originalOpen = fs.open;
  let reads = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === filePath && args[1] === "r") {
      const originalRead = handle.readFile.bind(handle);
      handle.readFile = (...args) => {
        reads++;
        return originalRead(...args);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const query = { taskIds: [task.id], sessionTokens: ["session-1"] };
    for (let index = 0; index < 10; index++) {
      const result = await reader.readGenerationStream(query);
      assert.equal(result.generationTasks[0].prompt, task.prompt);
      result.generationTasks[0].prompt = "must not mutate cached data";
    }
    assert.equal(reads, 1);
    data.generationTasks[0].prompt = "changed by another process";
    await writer.write(data);
    assert.equal((await reader.readGenerationStream(query)).generationTasks[0].prompt, data.generationTasks[0].prompt);
    assert.equal(reads, 2);
    data.generationTasks[0].prompt = "one parse for concurrent readers";
    await writer.write(data);
    const parallelReads = await Promise.all(Array.from({ length: 30 }, () => reader.readSession("session-1")));
    assert.ok(parallelReads.every((identity) => identity.user.id === task.userId));
    assert.equal(reads, 3, "Concurrent readers of one file version must share a single parse");
    const write = { taskId: task.id, startedAt: task.startedAt, progress: { ...task.progress, sequence: 3 } };
    await writer.updateGenerationProgress(write);
    await writer.updateGenerationProgress({ ...write, progress: { ...task.progress, sequence: 2 } });
    await writer.updateGenerationProgress({
      ...write,
      startedAt: "2000-01-01T00:00:00.000Z",
      progress: { ...task.progress, sequence: 4 }
    });
    assert.equal((await reader.readGenerationStream(query)).generationTasks[0].progress.sequence, 3);
    await writer.update((data) => {
      data.generationTasks[0].status = "SUCCEEDED";
    });
    await writer.updateGenerationProgress({ ...write, progress: { ...task.progress, sequence: 5 } });
    assert.equal((await reader.readGenerationStream(query)).generationTasks[0].progress.sequence, 3);
    await writer.update((data) => {
      data.sessions = [];
    });
    assert.equal((await reader.readGenerationStream(query)).generationTasks.length, 0);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("100 SSE subscribers share one batch and release the polling loop after disconnect", async () => {
  const calls = [];
  const runtime = createGenerationEventsRuntime(
    {
      async readGenerationStream(query) {
        calls.push(query);
        return streamData();
      }
    },
    { pollIntervalMs: 30 }
  );
  try {
    const subscriptions = Array.from({ length: 100 }, () => runtime.subscribe("session-1", task.id));
    await Promise.all(subscriptions.map((subscription) => subscription.ready));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { taskIds: [task.id], sessionTokens: ["session-1"] });
    for (const subscription of subscriptions) {
      assert.equal((await subscription.events.next()).value.task.id, task.id);
      subscription.close();
    }
    const count = calls.length;
    await delay(70);
    assert.equal(calls.length, count);
  } finally {
    await runtime.close();
  }
});

test("SSE reconnect during an unchanged poll retains cached images and refunds", async () => {
  const data = streamData();
  data.generatedImages = [image];
  data.creditLedgerEntries = [entry];
  let calls = 0,
    release;
  const runtime = createGenerationEventsRuntime(
    {
      async readGenerationStream(query) {
        calls++;
        if (calls === 2)
          await new Promise((resolve) => {
            release = resolve;
          });
        return globalThis.structuredClone({
          ...data,
          generatedImages: query.knownTaskVersions ? [] : data.generatedImages,
          creditLedgerEntries: query.knownTaskVersions ? [] : data.creditLedgerEntries
        });
      }
    },
    { pollIntervalMs: 10 }
  );
  try {
    const first = runtime.subscribe("session-1", task.id);
    await first.ready;
    assert.equal((await first.events.next()).value.images.length, 1);
    await until(() => !!release);
    first.close();
    const reconnected = runtime.subscribe("session-1", task.id);
    release();
    await reconnected.ready;
    const snapshot = (await reconnected.events.next()).value;
    assert.equal(snapshot.images[0].id, image.id);
    assert.equal(snapshot.creditLedgerEntries[0].amount, entry.amount);
    reconnected.close();
  } finally {
    release?.();
    await runtime.close();
  }
});

test("SSE isolates task owners, rechecks revoked sessions and rejects suspended users", async () => {
  let data = streamData();
  data.sessions.push({ token: "session-2", userId: "user-2", userStatus: "ACTIVE", expiresAt });
  const runtime = createGenerationEventsRuntime(
    {
      async readGenerationStream() {
        return globalThis.structuredClone(data);
      }
    },
    { pollIntervalMs: 10 }
  );
  try {
    const owner = runtime.subscribe("session-1", task.id);
    const foreign = runtime.subscribe("session-2", task.id);
    await Promise.all([owner.ready, assert.rejects(foreign.ready, (error) => error.statusCode === 404)]);
    assert.equal((await owner.events.next()).value.task.id, task.id);
    data.sessions = [];
    await assert.rejects(owner.events.next(), (error) => error.statusCode === 401);
    data = streamData();
    data.sessions[0].userStatus = "SUSPENDED";
    const suspended = runtime.subscribe("session-1", task.id);
    await assert.rejects(suspended.ready, (error) => error.statusCode === 403);
    data.sessions[0].userStatus = "ACTIVE";
    data.sessions[0].expiresAt = "2000-01-01T00:00:00.000Z";
    await assert.rejects(runtime.subscribe("session-1", task.id).ready, (error) => error.statusCode === 401);
  } finally {
    await runtime.close();
  }
});

test("SSE keeps the latest snapshot for slow consumers and delivers terminal images and refunds on reconnect", async () => {
  const data = streamData();
  let calls = 0;
  const runtime = createGenerationEventsRuntime(
    {
      async readGenerationStream() {
        calls++;
        return globalThis.structuredClone(data);
      }
    },
    { pollIntervalMs: 10 }
  );
  try {
    const subscription = runtime.subscribe("session-1", task.id);
    await subscription.ready;
    for (let sequence = 1; sequence <= 3; sequence++) {
      data.generationTasks[0].progress.sequence = sequence;
      const previous = calls;
      await until(() => calls > previous);
    }
    assert.equal((await subscription.events.next()).value.task.progress.sequence, 3);
    data.generationTasks[0].status = "SUCCEEDED";
    data.generatedImages.push(image);
    data.creditLedgerEntries.push(entry);
    const terminal = (await subscription.events.next()).value;
    assert.equal(terminal.task.status, "SUCCEEDED");
    assert.equal(terminal.images.length, 1);
    assert.equal(terminal.creditLedgerEntries[0].amount, 5);
    assert.equal((await subscription.events.next()).done, true);
    const restored = runtime.subscribe("session-1", task.id);
    await restored.ready;
    assert.equal((await restored.events.next()).value.images[0].id, image.id);
    assert.equal((await restored.events.next()).done, true);
  } finally {
    await runtime.close();
  }
});

test("SSE heartbeats and read failures do not overlap database polls or retain subscriptions", async () => {
  let active = 0,
    maximum = 0,
    fail = false;
  const runtime = createGenerationEventsRuntime(
    {
      async readGenerationStream() {
        active++;
        maximum = Math.max(maximum, active);
        try {
          await delay(15);
          if (fail) throw new Error("database unavailable");
          return streamData();
        } finally {
          active--;
        }
      }
    },
    { pollIntervalMs: 5, heartbeatMs: 10 }
  );
  try {
    const subscription = runtime.subscribe("session-1", task.id);
    await subscription.ready;
    await subscription.events.next();
    assert.equal((await subscription.events.next()).value, null);
    fail = true;
    await assert.rejects(subscription.events.next(), /database unavailable/);
    assert.equal(maximum, 1);
  } finally {
    await runtime.close();
  }
});

test("progress bursts coalesce to one write while retaining every step", async () => {
  const writes = [];
  const reporter = createGenerationProgressReporter(
    {
      async updateGenerationProgress(write) {
        writes.push(write);
      }
    },
    task,
    assert.fail
  );
  for (let index = 0; index < 30; index++) {
    assert.equal(
      reporter.report(
        { stage: index < 10 ? "GENERATING" : index < 20 ? "REVIEWING" : "SAVING" },
        { index: index % 4, step: Math.min(4, Math.floor(index / 8) + 1) }
      ),
      undefined
    );
  }
  await reporter.close();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].progress.sequence, 30);
  assert.equal(writes[0].progress.events.length, 30);
  reporter.report({ savedImages: 4 });
  await reporter.close();
  assert.equal(writes.length, 1);
});

test("slow or failed progress writes never block reporting and final flush persists the newest counters", async () => {
  let release;
  let calls = 0;
  const errors = [],
    writes = [];
  const reporter = createGenerationProgressReporter(
    {
      async updateGenerationProgress(write) {
        writes.push(write);
        calls++;
        if (calls === 1) {
          await new Promise((resolve) => {
            release = resolve;
          });
          throw new Error("temporary failure");
        }
      }
    },
    task,
    (error) => errors.push(error),
    20
  );
  reporter.report({ generatedImages: 1 });
  await until(() => !!release);
  reporter.report({ generatedImages: 2 });
  reporter.report({ reviewedImages: 2, savedImages: 2 });
  assert.equal(calls, 1);
  const closing = reporter.close();
  release();
  await closing;
  assert.equal(errors.length, 1);
  assert.equal(calls, 2);
  assert.equal(writes[1].progress.generatedImages, 2);
  assert.equal(writes[1].progress.savedImages, 2);
  assert.equal(writes[1].progress.events.length, 3);
});
