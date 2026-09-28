import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.PRISMA_STORE_TEST_DATABASE_URL;
const enabled = { skip: !databaseUrl };

// 每例只创建 UUID 命名的合成记录并更新自己的记录；保留 fixture 供复核，不清空任何表。
test("prisma store updates changed rows without rewriting unrelated tables", enabled, async () => {
  await fixture(async ({ prisma, store }) => {
    const user = await createUser(prisma);
    const unrelated = await createUser(prisma);
    const plan = await prisma.plan.create({
      data: {
        id: randomUUID(),
        name: "PG fixture",
        description: "synthetic",
        priceCents: 100,
        currency: "CNY",
        credits: 100,
        status: "INACTIVE"
      }
    });
    const userVersion = await rowVersion(prisma, "users", user.id);
    const unrelatedVersion = await rowVersion(prisma, "users", unrelated.id);
    const planVersion = await rowVersion(prisma, "plans", plan.id);
    await store.update((data) => {
      const target = data.users.find((item) => item.id === user.id);
      target.nickname = "增量写验证";
      target.updatedAt = new Date().toISOString();
    });
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).nickname, "增量写验证");
    assert.notEqual(await rowVersion(prisma, "users", user.id), userVersion);
    assert.equal(await rowVersion(prisma, "users", unrelated.id), unrelatedVersion);
    assert.equal(await rowVersion(prisma, "plans", plan.id), planVersion);
    const changedVersion = await rowVersion(prisma, "users", user.id);
    await store.update(() => undefined);
    assert.equal(await rowVersion(prisma, "users", user.id), changedVersion);
    await assert.rejects(
      store.update((data) => {
        data.users.find((item) => item.id === user.id).nickname = "不应提交";
        throw new Error("rollback-check");
      }),
      /rollback-check/
    );
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).nickname, "增量写验证");
  });
});

test("postgres image pages enforce owner, project, favorite and visibility filters", enabled, async () => {
  await fixture(async ({ prisma, store, queries }) => {
    const owner = await createUser(prisma);
    const other = await createUser(prisma);
    const project = await prisma.imageProject.create({ data: { id: randomUUID(), userId: owner.id, name: "active" } });
    const foreignProject = await prisma.imageProject.create({
      data: { id: randomUUID(), userId: other.id, name: "other" }
    });
    const archived = await prisma.imageProject.create({
      data: { id: randomUUID(), userId: owner.id, name: "archived", archivedAt: new Date() }
    });
    const task = await prisma.generationTask.create({ data: taskData(owner.id) });
    const otherTask = await prisma.generationTask.create({ data: taskData(other.id) });
    const sameTime = new Date("2026-09-01T00:00:00Z");
    const visible = Array.from({ length: 3 }, () => imageData(task, { projectId: project.id, createdAt: sameTime }));
    const hidden = imageData(task, { projectId: project.id, visibility: "HIDDEN" });
    const deleted = imageData(task, { projectId: project.id, deletedAt: new Date() });
    const foreign = imageData(otherTask, { projectId: foreignProject.id, visibility: "PUBLIC" });
    await prisma.generatedImage.createMany({ data: [...visible, hidden, deleted, foreign] });
    await prisma.imageFavorite.createMany({
      data: [
        { userId: owner.id, imageId: visible[0].id },
        { userId: other.id, imageId: visible[1].id },
        { userId: owner.id, imageId: foreign.id }
      ]
    });
    // 一个错误的跨用户封面引用应回退为项目内的可见图片。
    await prisma.imageProject.update({ where: { id: project.id }, data: { coverImageId: foreign.id } });
    queries.length = 0;
    const first = await store.readImages({ userId: owner.id, offset: 0, limit: 2 });
    const second = await store.readImages({ userId: owner.id, offset: 2, limit: 2 });
    const expectedIds = visible
      .map((item) => item.id)
      .sort()
      .reverse();
    assert.deepEqual(
      [...first.generatedImages, ...second.generatedImages].map((item) => item.id),
      expectedIds
    );
    assert.equal(first.total, 3);
    assert.equal(second.total, 3);
    assert.equal(first.generationTasks.length, 0);
    assert.ok(first.generatedImages.every((item) => item.generationMetadata.prompt === task.prompt));
    assert.ok(
      queries
        .filter((query) => /FROM "public"\."generated_images"/.test(query.query))
        .every((query) => /user_id/.test(query.query))
    );
    const favorites = await store.readImages({ userId: owner.id, favorite: true, offset: 0, limit: 10 });
    assert.deepEqual(
      favorites.generatedImages.map((item) => item.id),
      [visible[0].id]
    );
    const nonFavorites = await store.readImages({ userId: owner.id, favorite: false, offset: 0, limit: 10 });
    assert.equal(nonFavorites.total, 2);
    assert.ok(!nonFavorites.generatedImages.some((item) => item.id === visible[0].id));
    for (const query of [
      { imageId: foreign.id },
      { imageId: deleted.id },
      { projectId: foreignProject.id },
      { projectId: archived.id }
    ]) {
      assert.equal((await store.readImages({ userId: owner.id, offset: 0, limit: 10, ...query })).total, 0);
    }
    assert.equal((await store.readImages({ userId: owner.id, imageId: hidden.id, offset: 0, limit: 1 })).total, 1);
    const byProject = await store.readImages({ userId: owner.id, projectId: project.id, offset: 0, limit: 10 });
    assert.equal(byProject.total, 3);
    const projects = await store.readImageProjects(owner.id);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].imageCount, 3);
    assert.equal(projects[0].coverThumbnailUrl, visible.find((item) => item.id === expectedIds[0]).thumbnailUrl);
  });
});

test("postgres session and account reads select only requested user records", enabled, async () => {
  await fixture(async ({ prisma, store, queries }) => {
    const owner = await createUser(prisma);
    const other = await createUser(prisma);
    const live = sessionData(owner.id);
    const expired = sessionData(owner.id, { expiresAt: new Date(Date.now() - 60_000) });
    const foreign = sessionData(other.id);
    await prisma.session.createMany({ data: [live, expired, foreign] });
    await prisma.userCreditAccount.createMany({
      data: [
        { userId: owner.id, balance: 99, totalEarned: 99, totalSpent: 0 },
        { userId: other.id, balance: 900, totalEarned: 900, totalSpent: 0 }
      ]
    });
    const entries = Array.from({ length: 3 }, (_, index) =>
      ledgerData(owner.id, "GRANT", 33, randomUUID(), { createdAt: new Date(Date.now() + index * 1000) })
    );
    await prisma.creditLedgerEntry.createMany({ data: [...entries, ledgerData(other.id, "GRANT", 900)] });
    await prisma.safetyEvent.createMany({
      data: [owner, other].map((user) => ({
        id: randomUUID(),
        userId: user.id,
        targetType: "PROMPT",
        targetId: randomUUID(),
        status: "PASSED",
        reasonCode: "fixture",
        reasonMessage: "synthetic",
        provider: "fixture"
      }))
    });
    queries.length = 0;
    assert.equal((await store.readSession(live.token)).user.id, owner.id);
    assert.equal(await store.readSession(expired.token), null);
    assert.equal(await store.readSession(randomUUID()), null);
    const data = await store.readUserRecords({
      userId: owner.id,
      creditAccount: true,
      ledgerLimit: 2,
      safetyEventLimit: 1,
      sessions: true
    });
    assert.deepEqual(
      data.creditAccounts.map((item) => item.balance),
      [99]
    );
    assert.deepEqual(
      data.creditLedgerEntries.map((item) => item.id),
      [entries[2].id, entries[1].id]
    );
    assert.equal(data.safetyEvents.length, 1);
    assert.deepEqual(
      data.sessions.map((item) => item.token),
      [live.token]
    );
    assert.ok(
      Object.values(data)
        .flat()
        .every((item) => item.userId === owner.id)
    );
    assert.ok(!queries.some((query) => /FROM "public"\."(generation_tasks|generated_images|plans)"/.test(query.query)));
    assert.deepEqual(await store.readUserRecords({ userId: owner.id }), {
      creditAccounts: [],
      creditLedgerEntries: [],
      safetyEvents: [],
      sessions: []
    });
  });
});

test("postgres stream batches 100 subscriptions and omits unchanged image and refund payloads", enabled, async () => {
  await fixture(async ({ prisma, store, queries, database }) => {
    const users = Array.from({ length: 102 }, () => userData());
    users[100].status = "SUSPENDED";
    await prisma.user.createMany({ data: users });
    const sessions = users.map((user, index) =>
      sessionData(user.id, index === 101 ? { expiresAt: new Date(Date.now() - 1000) } : {})
    );
    const tasks = users.map((user) => taskData(user.id));
    await prisma.session.createMany({ data: sessions });
    await prisma.generationTask.createMany({ data: tasks });
    await prisma.generatedImage.createMany({ data: tasks.map((task) => imageData(task)) });
    await prisma.creditLedgerEntry.createMany({
      data: tasks.map((task) => ledgerData(task.userId, "REFUND", 1, task.id))
    });
    const query = { taskIds: tasks.map((task) => task.id), sessionTokens: sessions.map((session) => session.token) };
    queries.length = 0;
    const data = await store.readGenerationStream(query);
    assert.equal(data.sessions.length, 101);
    assert.equal(data.generationTasks.length, 100);
    assert.equal(data.generatedImages.length, 100);
    assert.equal(data.creditLedgerEntries.length, 100);
    assert.ok(!data.generationTasks.some((task) => task.userId === users[100].id || task.userId === users[101].id));
    const selects = queries.filter((entry) => /^SELECT\b/.test(entry.query));
    assert.ok(selects.length >= 4 && selects.length <= 5, `100 subscriptions issued ${selects.length} SELECTs`);
    assert.ok(!selects.some((entry) => /FROM "public"\."(plans|orders|user_credit_accounts)"/.test(entry.query)));
    queries.length = 0;
    const unchanged = await store.readGenerationStream({
      ...query,
      knownTaskVersions: Object.fromEntries(
        data.generationTasks.map((task) => [task.id, database.generationTaskVersion(task)])
      )
    });
    assert.equal(unchanged.generationTasks.length, 100);
    assert.equal(unchanged.generatedImages.length, 0);
    assert.equal(unchanged.creditLedgerEntries.length, 0);
    assert.ok(!queries.some((entry) => /FROM "public"\."(generated_images|credit_ledger_entries)"/.test(entry.query)));
    assert.equal(
      (
        await store.readGenerationStream({
          taskIds: [tasks[1].id],
          sessionTokens: [sessions[0].token]
        })
      ).generationTasks.length,
      0
    );
  });
});

test(
  "postgres scoped transactions across four clients charge a duplicate request once and rollback unique conflicts",
  enabled,
  async () => {
    await fixture(async ({ prisma, store, PrismaClient, database }) => {
      const owner = await createUser(prisma);
      const other = await createUser(prisma);
      await prisma.userCreditAccount.createMany({
        data: [
          { userId: owner.id, balance: 100, totalEarned: 100, totalSpent: 0 },
          { userId: other.id, balance: 77, totalEarned: 77, totalSpent: 0 }
        ]
      });
      const clients = Array.from({ length: 3 }, () => new PrismaClient({ datasourceUrl: databaseUrl }));
      const stores = [store, ...clients.map((client) => new database.PrismaStore(client))];
      const requestId = randomUUID();
      const scope = {
        generationTasks: { userId: owner.id, clientRequestIds: [requestId] },
        creditAccounts: { userIds: [owner.id] },
        creditLedgerEntries: "loadedTasks"
      };
      try {
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            stores[index % stores.length].updateScoped(scope, async (data) => {
              const existing = data.generationTasks.find((task) => task.clientRequestId === requestId);
              if (existing) return existing.id;
              // 让独立连接发生真实锁竞争，进程内 Promise 链不能独自保证本测试通过。
              await new Promise((resolve) => setTimeout(resolve, 10));
              const account = data.creditAccounts[0];
              account.balance -= 40;
              account.totalSpent += 40;
              account.updatedAt = new Date().toISOString();
              const task = taskData(owner.id, { clientRequestId: requestId, status: "PENDING" });
              data.generationTasks.push(storeTask(task));
              data.creditLedgerEntries.push(
                storeLedger(
                  ledgerData(owner.id, "SPEND", -40, task.id, {
                    balanceAfter: 60,
                    idempotencyKey: `task-spend:${task.id}`
                  })
                )
              );
              return task.id;
            })
          )
        );
        assert.equal(new Set(results).size, 1);
        assert.equal(await prisma.generationTask.count({ where: { userId: owner.id, clientRequestId: requestId } }), 1);
        assert.equal(await prisma.creditLedgerEntry.count({ where: { userId: owner.id, type: "SPEND" } }), 1);
        assert.equal((await prisma.userCreditAccount.findUnique({ where: { userId: owner.id } })).balance, 60);
        assert.equal((await prisma.userCreditAccount.findUnique({ where: { userId: other.id } })).balance, 77);
        // 数据库复合唯一键冲突必须回滚同一 scoped 事务内已经修改的账户。
        await assert.rejects(
          store.updateScoped(scope, (data) => {
            data.creditAccounts[0].balance = 1;
            data.generationTasks.push({ ...data.generationTasks[0], id: randomUUID() });
          }),
          (error) => error.code === "P2002"
        );
        const canonical = await prisma.creditLedgerEntry.findFirst({ where: { userId: owner.id, type: "SPEND" } });
        await assert.rejects(
          store.updateScoped(scope, (data) => {
            data.creditAccounts[0].balance = 2;
            data.creditLedgerEntries.push({ ...storeLedger(canonical), id: randomUUID() });
          }),
          (error) => error.code === "P2002"
        );
        assert.equal((await prisma.userCreditAccount.findUnique({ where: { userId: owner.id } })).balance, 60);
      } finally {
        await Promise.all(clients.map((client) => client.$disconnect()));
      }
    });
  }
);

test(
  "postgres maintenance SQL executes bound cursors and reconciles only missing refund amounts",
  enabled,
  async () => {
    await fixture(async ({ prisma, store, queries }) => {
      const { selectGenerationCandidates } = await import("../packages/database/dist/maintenance-queries.js");
      const { runGenerationMaintenance } = await import("../packages/shared/dist/index.js");
      const owner = await createUser(prisma);
      const earlier = new Date(Date.now() - 7_200_000);
      const cutoff = new Date(Date.now() - 3_600_000).toISOString();
      const tasks = [
        taskData(owner.id, { status: "PENDING", createdAt: earlier }),
        taskData(owner.id, { status: "RUNNING", createdAt: earlier, startedAt: earlier }),
        taskData(owner.id, { status: "CANCELED" }),
        taskData(owner.id, { status: "FAILED" }),
        taskData(owner.id, { status: "BLOCKED" }),
        taskData(owner.id, { status: "FAILED" }),
        taskData(owner.id, { status: "SUCCEEDED" })
      ];
      await prisma.generationTask.createMany({ data: tasks });
      await prisma.userCreditAccount.create({
        data: { userId: owner.id, balance: 130, totalEarned: 300, totalSpent: 170 }
      });
      const spends = tasks.filter((_, index) => index !== 5).map((task) => ledgerData(owner.id, "SPEND", -40, task.id));
      await prisma.creditLedgerEntry.createMany({
        data: [
          ledgerData(owner.id, "GRANT", 300, randomUUID(), { sourceType: "SYSTEM" }),
          ...spends,
          ledgerData(owner.id, "REFUND", 10, tasks[2].id),
          ledgerData(owner.id, "REFUND", 40, tasks[3].id),
          ledgerData(owner.id, "REFUND", 20, tasks[4].id, { idempotencyKey: `task-refund:${tasks[4].id}` })
        ]
      });
      const query = { pendingBefore: cutoff, runningBefore: cutoff, limit: 1000 };
      queries.length = 0;
      const actual = await store.readGenerationMaintenanceCandidates(query);
      const sql = queries.find((entry) => entry.query.includes("FROM generation_tasks task"));
      assert.ok(sql);
      assert.ok(!sql.query.includes(cutoff));
      assert.ok(sql.params.includes("1000"));
      const ownIds = new Set(tasks.map((task) => task.id));
      assert.deepEqual(
        actual
          .filter((task) => ownIds.has(task.id))
          .map((task) => task.id)
          .sort(),
        tasks
          .slice(0, 3)
          .map((task) => task.id)
          .sort()
      );
      assert.deepEqual(actual, selectGenerationCandidates(await store.read(), query));
      const paged = [];
      let afterId;
      for (;;) {
        const page = await store.readGenerationMaintenanceCandidates({ ...query, afterId, limit: 1 });
        if (page.length === 0) break;
        assert.equal(page.length, 1);
        assert.ok(!paged.some((item) => item.id === page[0].id));
        paged.push(page[0]);
        afterId = page[0].id;
        assert.ok(paged.length <= actual.length);
      }
      assert.deepEqual(paged, actual);
      const hostileCursor = "cursor' OR TRUE; --";
      queries.length = 0;
      const cursorQuery = { ...query, afterId: hostileCursor, limit: 2 };
      const cursorRows = await store.readGenerationMaintenanceCandidates(cursorQuery);
      assert.ok(!queries[0].query.includes(hostileCursor));
      assert.ok(queries[0].params.includes(hostileCursor));
      assert.deepEqual(cursorRows, selectGenerationCandidates(await store.read(), cursorQuery));
      const scope = {
        generationTasks: { userId: owner.id, ids: tasks.map((task) => task.id) },
        creditAccounts: { userIds: [owner.id] },
        creditLedgerEntries: "loadedTasks"
      };
      const options = { now: new Date().toISOString(), pendingTimeoutMs: 3_600_000, runningTimeoutMs: 3_600_000 };
      const result = await store.updateScoped(scope, (data) => runGenerationMaintenance(data, options));
      assert.deepEqual(result, {
        failedPendingTasks: 1,
        failedRunningTasks: 1,
        reconciledRefunds: 3,
        refundedCredits: 110
      });
      assert.equal(
        (
          await prisma.creditLedgerEntry.findUnique({
            where: { idempotencyKey: `task-refund:${tasks[2].id}` }
          })
        ).amount,
        30
      );
      assert.equal((await prisma.userCreditAccount.findUnique({ where: { userId: owner.id } })).balance, 240);
      assert.deepEqual(await store.updateScoped(scope, (data) => runGenerationMaintenance(data, options)), {
        failedPendingTasks: 0,
        failedRunningTasks: 0,
        reconciledRefunds: 0,
        refundedCredits: 0
      });
      assert.ok(!(await store.readGenerationMaintenanceCandidates(query)).some((task) => ownIds.has(task.id)));
    });
  }
);

test(
  "postgres expiry SQL and scoped writes preserve complete FIFO ledger semantics and idempotency",
  enabled,
  async () => {
    await fixture(async ({ prisma, store, queries }) => {
      const { selectCreditExpiryUsers } = await import("../packages/database/dist/maintenance-queries.js");
      const { expireCredits } = await import("../packages/shared/dist/index.js");
      const owner = await createUser(prisma);
      const other = await createUser(prisma);
      const due = new Date(Date.now() - 3_600_000);
      const future = new Date(Date.now() + 86_400_000);
      const grant = ledgerData(owner.id, "GRANT", 100, randomUUID(), { sourceType: "ORDER", expiresAt: due });
      const previous = ledgerData(owner.id, "GRANT", 100, randomUUID(), { sourceType: "ORDER", expiresAt: due });
      await prisma.userCreditAccount.createMany({
        data: [
          { userId: owner.id, balance: 140, totalEarned: 330, totalSpent: 190 },
          { userId: other.id, balance: 70, totalEarned: 100, totalSpent: 30 }
        ]
      });
      await prisma.creditLedgerEntry.createMany({
        data: [
          previous,
          grant,
          ledgerData(owner.id, "EXPIRE", -100, previous.id, {
            sourceType: "SYSTEM",
            idempotencyKey: `credit-expire:${previous.id}`
          }),
          ledgerData(owner.id, "GRANT", 100, randomUUID(), { sourceType: "ORDER", expiresAt: future }),
          ledgerData(owner.id, "REFUND", 20),
          ledgerData(owner.id, "ADJUST", 10, randomUUID(), { sourceType: "ADMIN" }),
          ledgerData(owner.id, "ADJUST", -20, randomUUID(), { sourceType: "ADMIN" }),
          ledgerData(owner.id, "SPEND", -70),
          ledgerData(other.id, "GRANT", 100, randomUUID(), { sourceType: "ORDER", expiresAt: future }),
          ledgerData(other.id, "SPEND", -30)
        ]
      });
      const query = { now: new Date().toISOString(), limit: 1000 };
      const candidates = await store.readCreditExpiryUsers(query);
      assert.ok(candidates.includes(owner.id));
      assert.equal(candidates.filter((id) => id === owner.id).length, 1);
      assert.ok(!candidates.includes(other.id));
      assert.deepEqual(candidates, selectCreditExpiryUsers(await store.read(), query));
      const cursor = "cursor' UNION SELECT password_hash FROM users; --";
      queries.length = 0;
      const cursorQuery = { ...query, afterUserId: cursor, limit: 1 };
      const result = await store.readCreditExpiryUsers(cursorQuery);
      assert.ok(!queries[0].query.includes(cursor));
      assert.ok(queries[0].params.includes(cursor));
      assert.deepEqual(result, selectCreditExpiryUsers(await store.read(), cursorQuery));
      const scope = { creditAccounts: { userIds: [owner.id] }, creditLedgerEntries: { userIds: [owner.id] } };
      assert.equal(
        await store.updateScoped(scope, (data) => {
          assert.equal(data.creditLedgerEntries.length, 8);
          return expireCredits(data, query.now);
        }),
        1
      );
      assert.equal(
        (
          await prisma.creditLedgerEntry.findUnique({
            where: { idempotencyKey: `credit-expire:${grant.id}` }
          })
        ).amount,
        -10
      );
      assert.equal((await prisma.userCreditAccount.findUnique({ where: { userId: owner.id } })).balance, 130);
      assert.equal((await prisma.userCreditAccount.findUnique({ where: { userId: other.id } })).balance, 70);
      assert.equal(await store.updateScoped(scope, (data) => expireCredits(data, query.now)), 0);
      assert.ok(!(await store.readCreditExpiryUsers(query)).includes(owner.id));
    });
  }
);

async function fixture(run) {
  const [database, { PrismaClient }] = await Promise.all([
    import("../packages/database/dist/index.js"),
    import("../packages/database/generated/client/index.js")
  ]);
  const queries = [];
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: [{ emit: "event", level: "query" }] });
  prisma.$on("query", (event) => queries.push(event));
  try {
    await run({ prisma, store: new database.PrismaStore(prisma), queries, PrismaClient, database });
  } finally {
    await prisma.$disconnect();
  }
}

function userData() {
  const id = randomUUID();
  return {
    id,
    email: `pg-fixture-${id}@example.invalid`,
    nickname: "PG fixture",
    passwordHash: "synthetic-not-a-password",
    role: "USER",
    status: "ACTIVE"
  };
}

async function createUser(prisma) {
  return prisma.user.create({ data: userData() });
}

function taskData(userId, overrides = {}) {
  return {
    id: randomUUID(),
    userId,
    clientRequestId: randomUUID(),
    prompt: "Synthetic PostgreSQL fixture",
    style: "photographic",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "standard",
    modelProvider: "fixture",
    modelName: "fixture",
    status: "SUCCEEDED",
    creditCost: 40,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function imageData(task, overrides = {}) {
  const id = randomUUID();
  return {
    id,
    taskId: task.id,
    userId: task.userId,
    storageKey: `fixture/${id}.png`,
    thumbnailKey: `fixture/${id}.thumb.png`,
    thumbnailUrl: `https://example.invalid/${id}.png`,
    width: 1024,
    height: 1024,
    fileSize: 100,
    mimeType: "image/png",
    safetyStatus: "PASSED",
    visibility: "PRIVATE",
    generationMetadata: {},
    createdAt: new Date(),
    ...overrides
  };
}

function sessionData(userId, overrides = {}) {
  return {
    token: randomUUID(),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides
  };
}

function ledgerData(userId, type, amount, sourceId = randomUUID(), overrides = {}) {
  return {
    id: randomUUID(),
    userId,
    type,
    amount,
    sourceType: "TASK",
    sourceId,
    balanceAfter: 0,
    idempotencyKey: randomUUID(),
    remark: "synthetic PostgreSQL fixture",
    createdAt: new Date(),
    ...overrides
  };
}

function storeTask(row) {
  return {
    referenceImageId: null,
    negativePrompt: null,
    modelSnapshot: null,
    progress: null,
    providerCostCents: 0,
    failureCode: null,
    failureMessage: null,
    startedAt: null,
    completedAt: null,
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function storeLedger(row) {
  return { ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null };
}

async function rowVersion(prisma, tableName, id) {
  assert.ok(["users", "plans"].includes(tableName));
  const rows = await prisma.$queryRawUnsafe(`SELECT xmin::text AS version FROM "${tableName}" WHERE id = $1`, id);
  assert.equal(rows.length, 1);
  return rows[0].version;
}
