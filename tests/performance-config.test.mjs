import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("queue worker settings expose bounded performance defaults", async () => {
  const { generationQueueJobOptions, resolveGenerationQueueProducerSettings, resolveGenerationWorkerSettings } =
    await import("../packages/queue/dist/index.js");

  assert.deepEqual(resolveGenerationWorkerSettings({}), {
    concurrency: 4,
    lockDurationMs: 300_000,
    stalledIntervalMs: 30_000,
    maxStalledCount: 2
  });
  assert.deepEqual(
    resolveGenerationWorkerSettings({
      WORKER_CONCURRENCY: "8",
      WORKER_LOCK_DURATION_MS: "600000",
      WORKER_STALLED_INTERVAL_MS: "45000",
      WORKER_MAX_STALLED_COUNT: "3"
    }),
    {
      concurrency: 8,
      lockDurationMs: 600_000,
      stalledIntervalMs: 45_000,
      maxStalledCount: 3
    }
  );
  assert.deepEqual(
    resolveGenerationWorkerSettings({
      WORKER_CONCURRENCY: "0",
      WORKER_LOCK_DURATION_MS: "10",
      WORKER_STALLED_INTERVAL_MS: "1",
      WORKER_MAX_STALLED_COUNT: "99"
    }),
    {
      concurrency: 4,
      lockDurationMs: 300_000,
      stalledIntervalMs: 30_000,
      maxStalledCount: 2
    }
  );

  assert.deepEqual(resolveGenerationQueueProducerSettings({}), {
    commandTimeoutMs: 2_000,
    maxRetriesPerRequest: 1
  });
  assert.deepEqual(
    resolveGenerationQueueProducerSettings({
      GENERATION_QUEUE_COMMAND_TIMEOUT_MS: "750"
    }),
    {
      commandTimeoutMs: 750,
      maxRetriesPerRequest: 1
    }
  );
  assert.equal(
    generationQueueJobOptions({
      taskId: "task-idempotent",
      userId: "user-1",
      requestedAt: "2026-07-17T00:00:00.000Z"
    }).jobId,
    "task-idempotent"
  );
});

test("worker maintenance gate throttles claim-time full maintenance", async () => {
  const { createWorkerMaintenanceGate } = await import("../apps/worker/dist/maintenance-runtime.js");
  const gate = createWorkerMaintenanceGate(60_000);

  assert.equal(gate.shouldRun(1_000), true);
  assert.equal(gate.shouldRun(60_999), false);
  assert.equal(gate.shouldRun(61_000), true);
  assert.equal(gate.shouldRun(120_999), false);
  assert.equal(gate.shouldRun(121_000), true);

  const unthrottledGate = createWorkerMaintenanceGate(0);
  assert.equal(unthrottledGate.shouldRun(1_000), true);
  assert.equal(unthrottledGate.shouldRun(1_000), true);

  const workerMain = await readFile("apps/worker/src/main.ts", "utf8");
  assert.match(workerMain, /if \(workerMaintenanceGate\.shouldRun\(\)\) {\s+runWorkerMaintenance\(data\);\s+}/);
  assert.doesNotMatch(workerMain, /store\.update\(\(data\) => {\s+runWorkerMaintenance\(data\);/);
  assert.match(workerMain, /WORKER_MAINTENANCE_INTERVAL_MS", 60_000/);
});

test("bullmq producer discards a failed client and recreates it for recovery", async () => {
  const { BullMqGenerationQueue } = await import("../packages/queue/dist/index.js");
  const clients = [];
  const factoryCalls = [];
  const settings = {
    commandTimeoutMs: 250,
    maxRetriesPerRequest: 1
  };
  const queue = new BullMqGenerationQueue("redis://queue.test:6379", settings, (redisUrl, receivedSettings) => {
    const clientIndex = clients.length;
    const client = {
      addCalls: [],
      closed: false,
      errorListener: null,
      async add(name, job, options) {
        this.addCalls.push({ name, job, options });
        if (clientIndex === 0) {
          throw new Error("redis unavailable");
        }
      },
      async close() {
        this.closed = true;
        if (clientIndex === 0) {
          throw new Error("client close failed");
        }
      },
      on(event, listener) {
        assert.equal(event, "error");
        this.errorListener = listener;
        return this;
      }
    };
    clients.push(client);
    factoryCalls.push({ redisUrl, settings: receivedSettings });
    return client;
  });
  const job = {
    taskId: "task-recreate-client",
    userId: "user-1",
    requestedAt: "2026-07-17T00:00:00.000Z"
  };

  await assert.rejects(queue.enqueueGenerationTask(job), /redis unavailable/);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true);

  await queue.enqueueGenerationTask(job);
  assert.equal(clients.length, 2);
  assert.deepEqual(factoryCalls, [
    { redisUrl: "redis://queue.test:6379", settings },
    { redisUrl: "redis://queue.test:6379", settings }
  ]);
  assert.equal(clients[1].addCalls.length, 1);
  assert.equal(clients[1].addCalls[0].name, "generate-image");
  assert.equal(clients[1].addCalls[0].options.jobId, job.taskId);
  assert.equal(typeof clients[1].errorListener, "function");

  await queue.close();
  assert.equal(clients[1].closed, true);
  await assert.rejects(queue.enqueueGenerationTask(job), /Generation queue is closed/);
});

test("concurrent failures from an old bullmq client do not close its replacement", async () => {
  const { BullMqGenerationQueue } = await import("../packages/queue/dist/index.js");
  const firstFailure = deferred();
  const secondFailure = deferred();
  const oldCloseRelease = deferred();
  const oldCloseStarted = deferred();
  const clients = [];
  const queue = new BullMqGenerationQueue(
    "redis://queue.test:6379",
    {
      commandTimeoutMs: 250,
      maxRetriesPerRequest: 1
    },
    () => {
      const clientIndex = clients.length;
      const client = {
        addCalls: 0,
        closeCalls: 0,
        async add() {
          this.addCalls += 1;
          if (clientIndex === 0) {
            await (this.addCalls === 1 ? firstFailure.promise : secondFailure.promise);
          }
        },
        async close() {
          this.closeCalls += 1;
          if (clientIndex === 0) {
            oldCloseStarted.resolve();
            await oldCloseRelease.promise;
          }
        },
        on() {
          return this;
        }
      };
      clients.push(client);
      return client;
    }
  );
  const job = {
    taskId: "task-concurrent-client-failure",
    userId: "user-1",
    requestedAt: "2026-07-17T00:00:00.000Z"
  };

  const firstEnqueue = queue.enqueueGenerationTask(job);
  const secondEnqueue = queue.enqueueGenerationTask({ ...job, taskId: `${job.taskId}-2` });
  firstFailure.reject(new Error("first redis failure"));
  await oldCloseStarted.promise;

  await queue.enqueueGenerationTask({ ...job, taskId: `${job.taskId}-recovered` });
  assert.equal(clients.length, 2);
  assert.equal(clients[1].closeCalls, 0);

  secondFailure.reject(new Error("second redis failure"));
  await assert.rejects(secondEnqueue, /second redis failure/);
  assert.equal(clients[1].closeCalls, 0);

  oldCloseRelease.resolve();
  await assert.rejects(firstEnqueue, /first redis failure/);
  assert.equal(clients[0].closeCalls, 1);

  await queue.enqueueGenerationTask({ ...job, taskId: `${job.taskId}-still-healthy` });
  assert.equal(clients[1].addCalls, 2);
  await queue.close();
  assert.equal(clients[1].closeCalls, 1);
});

test("pending generation reconciliation rotates small batches and retries failures after wrapping", async () => {
  const { createGenerationEnqueueRuntime } = await import("../apps/api/dist/generation-enqueue-runtime.js");
  const tasks = [
    pendingTask("task-b", "2026-07-17T00:00:00.000Z"),
    pendingTask("task-a", "2026-07-17T00:00:00.000Z"),
    { ...pendingTask("task-running", "2026-07-17T00:00:01.000Z"), status: "RUNNING" },
    pendingTask("task-c", "2026-07-17T00:00:02.000Z")
  ];
  let queueAvailable = false;
  const enqueuedTaskIds = [];
  const runtime = createGenerationEnqueueRuntime({
    store: {
      async read() {
        return { generationTasks: tasks };
      }
    },
    queue: {
      async enqueueGenerationTask(job) {
        enqueuedTaskIds.push(job.taskId);
        if (!queueAvailable) {
          throw new Error("redis unavailable");
        }
      }
    },
    intervalMs: 5_000,
    batchSize: 1
  });

  const failed = await runtime.reconcilePendingTasks();
  assert.deepEqual(failed, { attempted: 1, enqueued: 0, failed: 1 });
  assert.deepEqual(enqueuedTaskIds, ["task-a"]);
  assert.equal(tasks[0].status, "PENDING");

  queueAvailable = true;
  assert.deepEqual(await runtime.reconcilePendingTasks(), { attempted: 1, enqueued: 1, failed: 0 });
  assert.deepEqual(await runtime.reconcilePendingTasks(), { attempted: 1, enqueued: 1, failed: 0 });
  assert.deepEqual(await runtime.reconcilePendingTasks(), { attempted: 1, enqueued: 1, failed: 0 });
  assert.deepEqual(enqueuedTaskIds, ["task-a", "task-b", "task-c", "task-a"]);
  assert.equal(tasks[0].status, "PENDING");
});

test("generation enqueue reconciliation suppresses repeated outage logs and reports recovery", async () => {
  const { createGenerationEnqueueRuntime } = await import("../apps/api/dist/generation-enqueue-runtime.js");
  const task = pendingTask("task-log-window", "2026-07-17T00:00:00.000Z");
  const logs = [];
  let queueAvailable = false;
  const runtime = createGenerationEnqueueRuntime({
    store: {
      async read() {
        return { generationTasks: [task] };
      }
    },
    queue: {
      async enqueueGenerationTask() {
        if (!queueAvailable) {
          throw new Error("redis unavailable");
        }
      }
    },
    intervalMs: 5_000,
    batchSize: 1,
    failureLogIntervalMs: 60_000,
    onLog(level, details, message) {
      logs.push({ level, details, message });
    }
  });

  await runtime.reconcilePendingTasks();
  await runtime.reconcilePendingTasks();
  assert.equal(logs.filter((entry) => entry.level === "error").length, 1);

  queueAvailable = true;
  await runtime.reconcilePendingTasks();
  assert.equal(logs.filter((entry) => entry.message.includes("recovered")).length, 1);
});

test("immediate generation enqueue suppresses repeated outage logs and reports recovery", async () => {
  const { createGenerationEnqueueRuntime } = await import("../apps/api/dist/generation-enqueue-runtime.js");
  const task = pendingTask("task-immediate-log-window", "2026-07-17T00:00:00.000Z");
  const logs = [];
  let queueAvailable = false;
  const runtime = createGenerationEnqueueRuntime({
    store: {
      async read() {
        return { generationTasks: [] };
      }
    },
    queue: {
      async enqueueGenerationTask() {
        if (!queueAvailable) {
          throw new Error("redis unavailable");
        }
      }
    },
    intervalMs: 5_000,
    batchSize: 1,
    failureLogIntervalMs: 60_000,
    onLog(level, details, message) {
      logs.push({ level, details, message });
    }
  });

  await runtime.enqueueTask(task);
  await runtime.enqueueTask(task);
  assert.equal(logs.filter((entry) => entry.level === "warn").length, 1);

  queueAvailable = true;
  await runtime.enqueueTask(task);
  assert.equal(logs.filter((entry) => entry.message === "generation task enqueue recovered").length, 1);
});

test("generation enqueue shutdown waits for an active reconciliation", async () => {
  const { createGenerationEnqueueRuntime } = await import("../apps/api/dist/generation-enqueue-runtime.js");
  let releaseRead;
  let readStarted;
  const readStartedPromise = new Promise((resolve) => {
    readStarted = resolve;
  });
  const readBlockedPromise = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const runtime = createGenerationEnqueueRuntime({
    store: {
      async read() {
        readStarted();
        await readBlockedPromise;
        return { generationTasks: [] };
      }
    },
    queue: {
      async enqueueGenerationTask() {}
    },
    intervalMs: 5_000,
    batchSize: 1
  });

  const reconciliation = runtime.reconcilePendingTasks();
  await readStartedPromise;
  let stopped = false;
  const shutdown = runtime.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  releaseRead();
  await Promise.all([reconciliation, shutdown]);
  assert.equal(stopped, true);
});

test("generation enqueue shutdown waits for active immediate enqueue attempts", async () => {
  const { createGenerationEnqueueRuntime } = await import("../apps/api/dist/generation-enqueue-runtime.js");
  const enqueueStarted = deferred();
  const enqueueRelease = deferred();
  const runtime = createGenerationEnqueueRuntime({
    store: {
      async read() {
        return { generationTasks: [] };
      }
    },
    queue: {
      async enqueueGenerationTask() {
        enqueueStarted.resolve();
        await enqueueRelease.promise;
      }
    },
    intervalMs: 5_000,
    batchSize: 1
  });

  const enqueue = runtime.enqueueTask(pendingTask("task-active-enqueue", "2026-07-17T00:00:00.000Z"));
  await enqueueStarted.promise;
  let stopped = false;
  const shutdown = runtime.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  enqueueRelease.resolve();
  await Promise.all([enqueue, shutdown]);
  assert.equal(stopped, true);
});

test("stopped generation enqueue runtime does not restart or access store and queue", async () => {
  const { createGenerationEnqueueRuntime } = await import("../apps/api/dist/generation-enqueue-runtime.js");
  let readCalls = 0;
  let enqueueCalls = 0;
  const runtime = createGenerationEnqueueRuntime({
    store: {
      async read() {
        readCalls += 1;
        return { generationTasks: [] };
      }
    },
    queue: {
      async enqueueGenerationTask() {
        enqueueCalls += 1;
      }
    },
    intervalMs: 1,
    batchSize: 1
  });

  await runtime.stop();
  runtime.start();
  assert.deepEqual(await runtime.reconcilePendingTasks(), { attempted: 0, enqueued: 0, failed: 0 });
  assert.deepEqual(await runtime.enqueueTask(pendingTask("task-after-stop", "2026-07-17T00:00:00.000Z")), {
    enqueued: false,
    errorMessage: "Generation enqueue runtime is stopping"
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test("database schema includes performance indexes for release queries", async () => {
  const schema = await readFile("packages/database/prisma/schema.prisma", "utf8");
  const migration = await readFile("packages/database/prisma/migrations/7_performance_indexes/migration.sql", "utf8");

  assert.match(schema, /@@index\(\[status, createdAt\]\)/);
  assert.match(schema, /@@index\(\[orderId, createdAt\]\)/);
  assert.match(schema, /@@index\(\[imageId\]\)/);
  assert.match(migration, /orders_status_created_at_idx/);
  assert.match(migration, /payment_events_order_id_created_at_idx/);
  assert.match(migration, /image_favorites_image_id_idx/);
});

function pendingTask(id, createdAt) {
  return {
    id,
    userId: "user-1",
    clientRequestId: `request:${id}`,
    referenceImageId: null,
    prompt: "test prompt",
    negativePrompt: null,
    style: "realistic",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "standard",
    modelProvider: "mock",
    modelName: "mock:default",
    status: "PENDING",
    creditCost: 1,
    providerCostCents: 0,
    failureCode: null,
    failureMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt,
    updatedAt: createdAt
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
