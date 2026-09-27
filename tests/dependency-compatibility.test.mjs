import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Prisma loads nested configuration with the patched deepmerge dependency", async (t) => {
  const databaseRequire = createRequire(new URL("../packages/database/package.json", import.meta.url));
  const prismaRequire = createRequire(databaseRequire.resolve("prisma/package.json"));
  const { loadConfigFromFile } = prismaRequire("@prisma/config");
  const dir = await mkdtemp(join(tmpdir(), "imagora-prisma-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    schema: "prisma/schema.prisma",
    migrations: { path: "prisma/migrations", seed: "node prisma/seed.mjs" },
    experimental: { externalTables: true },
    tables: { external: ["public.external_audit"] }
  };
  await writeFile(join(dir, "prisma.config.cjs"), "module.exports = " + JSON.stringify(config));

  // Exercise Prisma's real c12 loader, which imports deepmerge-ts as its merger.
  const result = await loadConfigFromFile({ configRoot: dir });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.resolvedPath, join(dir, "prisma.config.cjs"));
  assert.equal(result.config.schema, join(dir, "prisma/schema.prisma"));
  assert.equal(result.config.migrations.path, join(dir, "prisma/migrations"));
  assert.equal(result.config.migrations.seed, config.migrations.seed);
  assert.deepEqual(result.config.experimental, config.experimental);
  assert.deepEqual(result.config.tables, config.tables);
});
