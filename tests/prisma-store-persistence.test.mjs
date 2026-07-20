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
