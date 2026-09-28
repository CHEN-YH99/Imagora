import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { PrismaStore, generationTaskVersion } from "../../packages/database/dist/index.js";
import { PrismaClient } from "../../packages/database/generated/client/index.js";

// 显式连接本机测试库；只新增本次 UUID fixture，不加载 .env，不迁移/清空/删除已有数据。
// 示例：设置 SCOPED_READ_BENCH_DATABASE_URL 后 node infra/scripts/scoped-read-benchmark.mjs
const databaseUrl = process.env.SCOPED_READ_BENCH_DATABASE_URL;
if (!databaseUrl) throw new Error("Set SCOPED_READ_BENCH_DATABASE_URL to a dedicated local test database");
const target = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/(?:test|verification)/i.test(target.pathname)) {
  throw new Error("Benchmark requires a loopback database whose name contains test or verification");
}
const recordCount = 2500;
const userCount = 100;
const rounds = 15;
const warmupRounds = 3;
const runId = randomUUID();
const startedAt = new Date().toISOString();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: [{ emit: "event", level: "query" }] });
let queryEvents = [];
prisma.$on("query", (event) => queryEvents.push(event));
const store = new PrismaStore(prisma);

try {
  const [{ version, database }] = await prisma.$queryRawUnsafe(
    "SELECT version() AS version, current_database() AS database"
  );
  const countsBefore = await databaseCounts();
  const seedStart = performance.now();
  const fixtures = await seed();
  const seedMs = performance.now() - seedStart;
  await store.initialize();
  const countsAfter = await databaseCounts();
  assert.equal(countsAfter.tasks - countsBefore.tasks, recordCount);
  assert.equal(countsAfter.images - countsBefore.images, recordCount);
  assert.equal(countsAfter.ledger - countsBefore.ledger, recordCount + userCount);
  const streamQuery = { taskIds: fixtures.streamTaskIds, sessionTokens: fixtures.sessionTokens };
  const initialStream = await store.readGenerationStream(streamQuery);
  assert.equal(initialStream.generationTasks.length, userCount);
  assert.equal(initialStream.generatedImages.length, userCount);
  const knownTaskVersions = Object.fromEntries(
    initialStream.generationTasks.map((task) => [task.id, generationTaskVersion(task)])
  );
  const scenarios = [
    ["full_store_read", () => store.read()],
    ["images_page_24", () => store.readImages({ userId: fixtures.ownerId, offset: 0, limit: 24 })],
    [
      "tasks_page_24",
      () => store.readGenerationTasks({ userId: fixtures.ownerId, offset: 0, limit: 24, includeImages: true })
    ],
    [
      "account_and_20_ledger",
      () => store.readUserRecords({ userId: fixtures.ownerId, creditAccount: true, ledgerLimit: 20 })
    ],
    ["sse_100_initial", () => store.readGenerationStream(streamQuery)],
    ["sse_100_unchanged", () => store.readGenerationStream({ ...streamQuery, knownTaskVersions })],
    ["maintenance_candidates_100", () => store.readGenerationMaintenanceCandidates({ limit: 100 })],
    ["expiry_candidates_100", () => store.readCreditExpiryUsers({ now: new Date().toISOString(), limit: 100 })]
  ];
  // 交错预热/测量，让各方案共享相同数据库和客户端状态。
  for (let round = 0; round < warmupRounds; round += 1) {
    for (const [, operation] of scenarios) await operation();
  }
  const samples = new Map(scenarios.map(([name]) => [name, []]));
  const outputs = new Map();
  for (let round = 0; round < rounds; round += 1) {
    for (const [name, operation] of scenarios) {
      queryEvents = [];
      const start = performance.now();
      const data = await operation();
      const durationMs = performance.now() - start;
      const selectedQueries = queryEvents.filter((event) => /^SELECT\b|^\s+SELECT\b/.test(event.query));
      samples.get(name).push({ durationMs, selects: selectedQueries.length, statements: queryEvents.length });
      outputs.set(name, {
        returnedRows: countRows(data),
        rowsByCollection: collectionCounts(data),
        payloadBytes: Buffer.byteLength(JSON.stringify(data)),
        total: data.total ?? null
      });
    }
  }
  const results = Object.fromEntries(
    scenarios.map(([name]) => {
      const values = samples.get(name);
      const durations = values.map((entry) => entry.durationMs).sort((a, b) => a - b);
      return [
        name,
        {
          ...outputs.get(name),
          samples: rounds,
          p50Ms: roundMs(percentile(durations, 0.5)),
          p95Ms: roundMs(percentile(durations, 0.95)),
          minMs: roundMs(durations[0]),
          maxMs: roundMs(durations.at(-1)),
          selectCount: [...new Set(values.map((entry) => entry.selects))],
          statementCount: [...new Set(values.map((entry) => entry.statements))]
        }
      ];
    })
  );
  assert.equal(results.images_page_24.rowsByCollection.generatedImages, 24);
  assert.equal(results.tasks_page_24.rowsByCollection.generationTasks, 24);
  assert.equal(results.sse_100_initial.rowsByCollection.generationTasks, 100);
  assert.equal(results.sse_100_unchanged.rowsByCollection.generatedImages, 0);
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    runId,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      postgres: version,
      database,
      host: target.hostname,
      port: target.port
    },
    fixture: {
      users: userCount,
      tasks: recordCount,
      images: recordCount,
      ledger: recordCount + userCount,
      ownerId: fixtures.ownerId,
      seedMs: roundMs(seedMs)
    },
    countsBefore,
    countsAfter,
    method: {
      rounds,
      warmupRounds,
      sequentialRoundRobin: true,
      timesInclude:
        "Prisma query, transaction, mapping and returned object creation; payload serialization is outside timing",
      scope:
        "Single local PostgreSQL container, synthetic fixtures, warm cache, no concurrent HTTP or image-provider work",
      retainedFixtures: true
    },
    results,
    limitations: [
      "合成数据微基线，不代表线上容量、吞吐量或真实用户延迟。",
      "100 个订阅指一次 readGenerationStream 批量读取的任务和会话，不是 100 条实际网络 SSE 连接。",
      "full_store_read 返回全部集合；scoped 返回页面或订阅所需集合，二者返回数据量有意不同。",
      "所有 fixture 使用新 UUID 并保留；重复运行会增加总库数据，报告包含运行前后真实计数。",
      "全局写锁仍存在；此基线测量读取范围，不评估写吞吐和跨进程锁竞争。"
    ]
  };
  const reportDirectory = resolve(".tmp", "scoped-read-verification");
  await mkdir(reportDirectory, { recursive: true });
  const basename = `baseline-${runId}`;
  const jsonPath = resolve(reportDirectory, `${basename}.json`);
  const markdownPath = resolve(reportDirectory, `${basename}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");
  const table = Object.entries(results).map(
    ([name, result]) =>
      `| ${name} | ${result.p50Ms} | ${result.p95Ms} | ${result.returnedRows} | ${result.payloadBytes} | ${result.selectCount.join("/")} |`
  );
  await writeFile(
    markdownPath,
    [
      "# PostgreSQL scoped read 合成数据基线",
      "",
      `时间：${startedAt}；运行 ID：${runId}`,
      "",
      `新增 ${recordCount} 任务、${recordCount} 图片、${recordCount + userCount} 流水、${userCount} 用户。`,
      `实际数据库总量：${countsAfter.tasks} 任务、${countsAfter.images} 图片、${countsAfter.ledger} 流水。`,
      `每场景预热 ${warmupRounds} 次，交错测量 ${rounds} 次，时间包含 Prisma 查询、事务与对象映射。`,
      "",
      "| 场景 | p50 ms | p95 ms | 返回记录数 | JSON 字节数 | SELECT 数 |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...table,
      "",
      ...report.limitations.map((item) => `- ${item}`),
      ""
    ].join("\n")
  );
  console.log(JSON.stringify({ jsonPath, markdownPath, fixture: report.fixture, countsAfter, results }, null, 2));
} finally {
  await prisma.$disconnect();
}

async function seed() {
  const now = new Date();
  const later = new Date(Date.now() + 86_400_000);
  const users = Array.from({ length: userCount }, () => {
    const id = randomUUID();
    return {
      id,
      email: `scoped-bench-${id}@example.invalid`,
      passwordHash: "synthetic-not-a-password",
      nickname: "Synthetic benchmark",
      role: "USER",
      status: "ACTIVE"
    };
  });
  const sessions = users.map((user) => ({ token: randomUUID(), userId: user.id, createdAt: now, expiresAt: later }));
  const tasks = Array.from({ length: recordCount }, (_, index) => ({
    id: randomUUID(),
    userId: users[index % userCount].id,
    clientRequestId: randomUUID(),
    prompt: "Synthetic image prompt for bounded PostgreSQL reads. ".repeat(8),
    style: "photographic",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "standard",
    modelProvider: "fixture",
    modelName: "fixture",
    status: "SUCCEEDED",
    creditCost: 1,
    createdAt: new Date(now.getTime() + index),
    updatedAt: now
  }));
  const images = tasks.map((task) => {
    const id = randomUUID();
    return {
      id,
      taskId: task.id,
      userId: task.userId,
      storageKey: `scoped-bench/${id}.png`,
      thumbnailKey: `scoped-bench/${id}.thumb.png`,
      publicUrl: `https://example.invalid/${id}.png`,
      width: 1024,
      height: 1024,
      fileSize: 100,
      mimeType: "image/png",
      safetyStatus: "PASSED",
      visibility: "PRIVATE",
      generationMetadata: {},
      createdAt: task.createdAt
    };
  });
  const grant = (user) => ({
    id: randomUUID(),
    userId: user.id,
    type: "GRANT",
    amount: 1000,
    balanceAfter: 1000,
    sourceType: "SYSTEM",
    sourceId: runId,
    idempotencyKey: randomUUID(),
    remark: "Synthetic benchmark grant",
    createdAt: now,
    expiresAt: later
  });
  const ledger = [
    ...users.map(grant),
    ...tasks.map((task, index) => ({
      id: randomUUID(),
      userId: task.userId,
      type: "SPEND",
      amount: -1,
      balanceAfter: 999 - Math.floor(index / userCount),
      sourceType: "TASK",
      sourceId: task.id,
      idempotencyKey: `task-spend:${task.id}`,
      remark: "Synthetic benchmark spend",
      createdAt: task.createdAt
    }))
  ];
  await prisma.user.createMany({ data: users });
  await prisma.session.createMany({ data: sessions });
  await prisma.userCreditAccount.createMany({
    data: users.map((user) => ({
      userId: user.id,
      balance: 975,
      totalEarned: 1000,
      totalSpent: 25
    }))
  });
  for (let offset = 0; offset < tasks.length; offset += 500) {
    await prisma.generationTask.createMany({ data: tasks.slice(offset, offset + 500) });
    await prisma.generatedImage.createMany({ data: images.slice(offset, offset + 500) });
  }
  for (let offset = 0; offset < ledger.length; offset += 500) {
    await prisma.creditLedgerEntry.createMany({ data: ledger.slice(offset, offset + 500) });
  }
  return {
    ownerId: users[0].id,
    streamTaskIds: tasks.slice(0, userCount).map((task) => task.id),
    sessionTokens: sessions.map((session) => session.token)
  };
}

async function databaseCounts() {
  const [users, tasks, images, ledger] = await Promise.all([
    prisma.user.count(),
    prisma.generationTask.count(),
    prisma.generatedImage.count(),
    prisma.creditLedgerEntry.count()
  ]);
  return { users, tasks, images, ledger };
}

function collectionCounts(data) {
  if (Array.isArray(data)) return { records: data.length };
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length])
  );
}

function countRows(data) {
  return Object.values(collectionCounts(data)).reduce((sum, value) => sum + value, 0);
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}
