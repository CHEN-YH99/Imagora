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
  tx.session.findMany = async () => [];
  calls.length = 0;
  assert.deepEqual(
    (await new PrismaStore(prisma).readGenerationStream({ taskIds: [task.id], sessionTokens: ["invalid"] }))
      .generationTasks,
    []
  );
  assert.equal(calls.length, 0, "invalid sessions must not query task data");
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
