import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.PRISMA_STORE_TEST_DATABASE_URL;

test("prisma store updates changed rows without rewriting unrelated tables", { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.IMAGORA_SEED_DEMO_DATA = "true";

  const [{ PrismaStore }, { PrismaClient }] = await Promise.all([
    import("../packages/database/dist/index.js"),
    import("../packages/database/generated/client/index.js")
  ]);
  const prisma = new PrismaClient();
  const store = new PrismaStore(prisma);

  try {
    await clearStoreTables(prisma);
    const seeded = await store.read();
    const user = seeded.users[0];
    const plan = seeded.plans[0];
    const userVersionBefore = await rowVersion(prisma, "users", user.id);
    const planVersionBefore = await rowVersion(prisma, "plans", plan.id);

    await store.update((data) => {
      const target = data.users.find((item) => item.id === user.id);
      target.nickname = "增量写验证";
      target.updatedAt = "2026-07-20T02:00:00.000Z";
    });

    const updated = await store.read();
    assert.equal(updated.users.find((item) => item.id === user.id)?.nickname, "增量写验证");
    assert.notEqual(await rowVersion(prisma, "users", user.id), userVersionBefore);
    assert.equal(await rowVersion(prisma, "plans", plan.id), planVersionBefore);

    const userVersionAfterChange = await rowVersion(prisma, "users", user.id);
    await store.update(() => undefined);
    assert.equal(await rowVersion(prisma, "users", user.id), userVersionAfterChange);

    await assert.rejects(
      store.update((data) => {
        const target = data.users.find((item) => item.id === user.id);
        target.nickname = "不应提交";
        throw new Error("rollback-check");
      }),
      /rollback-check/
    );
    assert.equal((await store.read()).users.find((item) => item.id === user.id)?.nickname, "增量写验证");
  } finally {
    await prisma.$disconnect();
  }
});

async function clearStoreTables(prisma) {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "alert_notifications",
      "operational_incidents",
      "admin_audit_logs",
      "safety_appeals",
      "safety_rules",
      "safety_events",
      "payment_events",
      "orders",
      "image_favorites",
      "generated_images",
      "image_projects",
      "generation_tasks",
      "reference_images",
      "credit_ledger_entries",
      "user_credit_accounts",
      "password_reset_tokens",
      "email_verification_tokens",
      "sessions",
      "plans",
      "users"
    CASCADE
  `);
}

async function rowVersion(prisma, tableName, id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT xmin::text AS version FROM "${tableName}" WHERE id = $1`, id);
  assert.equal(rows.length, 1);
  return rows[0].version;
}
