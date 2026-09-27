import assert from "node:assert/strict";
import test from "node:test";

test("prisma store diff only deletes removed users and upserts changed users", async () => {
  const { createEmptyStoreData, persistStoreDiff } =
    await import("../packages/database/dist/prisma-store-persistence.js");
  const before = createEmptyStoreData();
  const after = createEmptyStoreData();
  const unchangedUser = user("user-1", "未变化");
  const removedUser = user("user-2", "待删除");
  const changedUser = user("user-3", "旧昵称");

  before.users.push(unchangedUser, removedUser, changedUser);
  after.users.push(unchangedUser, { ...changedUser, nickname: "新昵称" }, user("user-4", "新增用户"));

  const calls = [];
  const tx = {
    user: {
      async deleteMany(input) {
        calls.push({ operation: "deleteMany", input });
      },
      async upsert(input) {
        calls.push({ operation: "upsert", input });
      }
    }
  };

  await persistStoreDiff(tx, before, after);

  assert.deepEqual(calls[0], {
    operation: "deleteMany",
    input: { where: { id: { in: ["user-2"] } } }
  });
  assert.deepEqual(
    calls.filter((call) => call.operation === "upsert").map((call) => call.input.where.id),
    ["user-3", "user-4"]
  );
  assert.ok(!calls.some((call) => call.operation === "upsert" && call.input.where.id === "user-1"));
});

test("prisma persists generation progress independently of other task fields", async () => {
  const { createEmptyStoreData, persistStoreDiff } =
    await import("../packages/database/dist/prisma-store-persistence.js");
  const before = createEmptyStoreData();
  const task = {
    id: "progress-task",
    userId: "user-1",
    clientRequestId: "request-1",
    referenceImageId: null,
    prompt: "test",
    negativePrompt: null,
    style: "none",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 4,
    quality: "standard",
    modelProvider: "openai",
    modelName: "openai:gpt-image-2",
    status: "RUNNING",
    creditCost: 40,
    providerCostCents: 0,
    failureCode: null,
    failureMessage: null,
    startedAt: "2026-09-24T12:00:00.000Z",
    completedAt: null,
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z"
  };
  before.generationTasks.push(task);
  const after = globalThis.structuredClone(before);
  after.generationTasks[0].progress = {
    stage: "GENERATING",
    generatedImages: 1,
    reviewedImages: 0,
    savedImages: 0,
    updatedAt: "2026-09-24T12:00:01.000Z"
  };
  const calls = [];
  const tx = {
    generationTask: {
      async upsert(input) {
        calls.push(input);
      }
    }
  };
  await persistStoreDiff(tx, before, after);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].update.progress, after.generationTasks[0].progress);
  assert.equal(calls[0].update.status, "RUNNING");
  assert.equal(calls[0].update.creditCost, 40);
  calls.length = 0;
  await persistStoreDiff(tx, after, globalThis.structuredClone(after));
  assert.equal(calls.length, 0);
});

function user(id, nickname) {
  return {
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    nickname,
    avatarUrl: null,
    role: "USER",
    status: "ACTIVE",
    emailVerifiedAt: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    lastLoginAt: null
  };
}
