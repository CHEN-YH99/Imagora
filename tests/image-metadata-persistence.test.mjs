import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PrismaStore } from "../packages/database/dist/index.js";
import { createEmptyStoreData } from "../packages/database/dist/prisma-store-persistence.js";
import * as shared from "../packages/shared/dist/index.js";

const root = process.cwd();

test("Prisma image metadata preserves the selected channel through create, update and read", async () => {
  const { store, rows, data } = await createMetadataFixture();
  const expected = data.generatedImages[0].generationMetadata;
  assert.equal(expected.channel, "backup-only");
  assert.deepEqual(rows.generatedImage[0].generationMetadata, expected);
  assert.deepEqual((await store.read()).generatedImages[0].generationMetadata, expected);

  await store.update((current) => {
    current.generatedImages[0].generationMetadata.channel = "saved-alternative";
  });
  assert.equal(rows.generatedImage[0].generationMetadata.channel, "saved-alternative");
  assert.equal((await store.read()).generatedImages[0].generationMetadata.channel, "saved-alternative");

  const withoutChannel = globalThis.structuredClone(data);
  delete withoutChannel.generatedImages[0].generationMetadata.channel;
  await store.write(withoutChannel);
  assert.equal(Object.hasOwn(rows.generatedImage[0].generationMetadata, "channel"), false);
});

test("Prisma normal and SSE reads recover legacy channels without replacing saved parameters", async (t) => {
  for (const scenario of [
    { name: "missing", channel: undefined, expected: "backup-only" },
    { name: "null", channel: null, expected: "backup-only" },
    { name: "empty", channel: "", expected: "backup-only" },
    { name: "saved channel wins", channel: "saved-alternative", expected: "saved-alternative" },
    { name: "first snapshot candidate", primaryChannel: null, channel: undefined, expected: "first-candidate" },
    { name: "no snapshot", noSnapshot: true, channel: undefined, expected: undefined }
  ]) {
    await t.test(scenario.name, async () => {
      const { store, rows, data } = await createMetadataFixture();
      const saved = {
        ...data.generatedImages[0].generationMetadata,
        prompt: "Original image prompt",
        quality: "high",
        quantity: 2,
        creditCost: 17
      };
      delete saved.channel;
      if (scenario.channel !== undefined) saved.channel = scenario.channel;
      rows.generatedImage[0].generationMetadata = globalThis.structuredClone(saved);
      if (scenario.primaryChannel === null) delete rows.generationTask[0].modelSnapshot.model.primaryChannel;
      if (scenario.noSnapshot) rows.generationTask[0].modelSnapshot = null;
      const expected = { ...saved, ...(scenario.expected ? { channel: scenario.expected } : {}) };

      const full = await store.read();
      const stream = await store.readGenerationStream({
        taskIds: [data.generationTasks[0].id],
        sessionTokens: ["metadata-session"]
      });
      assert.deepEqual(full.generatedImages[0].generationMetadata, expected);
      assert.deepEqual(stream.generatedImages[0].generationMetadata, expected);
      assert.deepEqual(rows.generatedImage[0].generationMetadata, saved, "Reads must not rewrite stored metadata");
    });
  }
});

test("Prisma legacy metadata handles empty metadata and missing tasks", async () => {
  const { store, rows, data } = await createMetadataFixture();
  rows.generatedImage[0].generationMetadata = {};
  assert.deepEqual(
    (await store.read()).generatedImages[0].generationMetadata,
    shared.generationMetadataFromTask(data.generationTasks[0])
  );

  const saved = { ...data.generatedImages[0].generationMetadata };
  delete saved.channel;
  rows.generatedImage[0].generationMetadata = saved;
  rows.generationTask.length = 0;
  assert.deepEqual((await store.read()).generatedImages[0].generationMetadata, saved);
});

test("public generation tasks expose only allowed fields and preserve reusable parameters", async () => {
  const { data } = await createMetadataFixture();
  const task = data.generationTasks[0];
  task.internalFutureConfig = { baseUrl: "https://private.example.test/v1", secret: "internal-only" };
  const before = globalThis.structuredClone(task);
  const projected = shared.publicGenerationTask(task);
  assert.deepEqual(
    Object.keys(projected).sort(),
    [
      "aspectRatio",
      "channel",
      "clientRequestId",
      "completedAt",
      "createdAt",
      "creditCost",
      "failureCode",
      "failureMessage",
      "height",
      "id",
      "modelName",
      "modelProvider",
      "negativePrompt",
      "progress",
      "prompt",
      "quality",
      "quantity",
      "referenceImageId",
      "startedAt",
      "status",
      "style",
      "updatedAt",
      "userId",
      "width"
    ].sort()
  );
  assert.equal(projected.channel, "backup-only");
  assert.equal(projected.modelName, task.modelName);
  assert.equal(projected.creditCost, task.creditCost);
  assert.deepEqual(projected.progress, task.progress);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /modelSnapshot|providerCostCents|private\.example|internalFutureConfig/
  );
  assert.deepEqual(task, before, "Public serialization must not remove the worker's snapshot");

  task.modelSnapshot = null;
  task.channel = "legacy-channel";
  assert.equal(shared.publicGenerationTask(task).channel, "legacy-channel");
});

async function createMetadataFixture() {
  const now = "2026-09-27T00:00:00.000Z";
  const data = createEmptyStoreData();
  const task = {
    id: "metadata-task",
    userId: "metadata-user",
    clientRequestId: "metadata-request",
    referenceImageId: null,
    prompt: "A quiet coast",
    negativePrompt: null,
    style: "none",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "standard",
    modelProvider: "openai",
    modelName: "openai:backup-only-model",
    modelSnapshot: {
      version: 1,
      model: {
        provider: "openai",
        modelId: "openai:backup-only-model",
        upstreamModel: "Backup Image Model",
        label: "Backup model",
        enabled: true,
        apiFormat: "openai-images",
        primaryChannel: "backup-only",
        qualities: ["standard"],
        aspectRatios: ["1:1"],
        maxQuantity: 4,
        qualityMultiplier: { draft: 1, standard: 1, high: 1 },
        sizeMultiplier: { "1024x1024": 1, "1024x1536": 1, "1536x1024": 1 },
        quantityMultiplier: 9,
        costCentsPerImage: 4
      },
      channels: [{ name: "first-candidate", baseUrl: "https://private.example.test/v1", priority: 0 }]
    },
    status: "SUCCEEDED",
    progress: shared.createGenerationProgress("COMPLETED", now),
    creditCost: 9,
    providerCostCents: 4,
    failureCode: null,
    failureMessage: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now
  };
  data.generationTasks.push(task);
  data.generatedImages.push({
    id: "metadata-image",
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
    generationMetadata: shared.generationMetadataFromTask(task),
    deletedAt: null,
    createdAt: now
  });
  data.sessions.push({
    token: "metadata-session",
    userId: task.userId,
    createdAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  });
  const names = [
    "user",
    "session",
    "passwordResetToken",
    "emailVerificationToken",
    "userCreditAccount",
    "creditLedgerEntry",
    "generationTask",
    "referenceImage",
    "generatedImage",
    "imageFavorite",
    "imageProject",
    "plan",
    "order",
    "paymentEvent",
    "safetyEvent",
    "safetyRule",
    "safetyAppeal",
    "adminAuditLog",
    "operationalIncident",
    "alertNotification"
  ];
  const rows = Object.fromEntries(names.map((name) => [name, []]));
  const prisma = Object.fromEntries(
    names.map((name) => [
      name,
      {
        async findMany() {
          return globalThis.structuredClone(rows[name]);
        },
        // Keep seeding outside this persistence fixture.
        async count() {
          return name === "user" ? 1 : rows[name].length;
        },
        async upsert({ where, create, update }) {
          const current = rows[name].find((row) => Object.entries(where).every(([key, value]) => row[key] === value));
          if (current) Object.assign(current, globalThis.structuredClone(update));
          else rows[name].push(globalThis.structuredClone(create));
        }
      }
    ])
  );
  prisma.$executeRawUnsafe = async () => {};
  prisma.$transaction = async (run) => run(prisma);
  const store = new PrismaStore(prisma);
  await store.write(data);
  rows.session[0].user = { status: "ACTIVE" };
  return { store, rows, data };
}

test("image metadata persistence backfills old rows and normalizes prisma reads", async () => {
  const databaseStore = await readFile(join(root, "packages/database/src/index.ts"), "utf8");
  const migration = await readFile(
    join(root, "packages/database/prisma/migrations/8_image_projects_and_metadata/migration.sql"),
    "utf8"
  );

  assert.match(migration, /jsonb_build_object\(/);
  assert.match(migration, /FROM "generation_tasks" AS task/);
  assert.match(migration, /image\."task_id" = task\."id"/);
  assert.match(migration, /image\."generation_metadata" = '\{\}'::jsonb/);

  assert.match(databaseStore, /const generationTaskViews: StoreData\["generationTasks"\]/);
  assert.match(databaseStore, /generationMetadata: normalizeGenerationMetadata\(/);
  assert.doesNotMatch(
    databaseStore,
    /generationMetadata:\s*\n\s*image\.generationMetadata as unknown as StoreData\["generatedImages"\]\[number\]\["generationMetadata"\]/
  );
});
