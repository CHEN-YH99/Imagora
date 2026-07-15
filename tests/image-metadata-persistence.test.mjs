import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

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
