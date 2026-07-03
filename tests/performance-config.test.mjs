import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("queue worker settings expose bounded performance defaults", async () => {
  const { resolveGenerationWorkerSettings } = await import("../packages/queue/dist/index.js");

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
