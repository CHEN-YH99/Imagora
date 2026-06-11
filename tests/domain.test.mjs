import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInitialData, JsonStore, verifyPassword } from "../packages/database/dist/index.js";
import { calculateCreditCost, checkPromptSafety } from "../packages/shared/dist/index.js";

test("credit cost increases with quantity and quality", () => {
  const standardOne = calculateCreditCost({
    style: "product_photography",
    quality: "standard",
    quantity: 1,
    aspectRatio: "1:1"
  });
  const highTwo = calculateCreditCost({
    style: "product_photography",
    quality: "high",
    quantity: 2,
    aspectRatio: "1:1"
  });

  assert.equal(standardOne, 7);
  assert.ok(highTwo > standardOne * 2);
});

test("local prompt safety blocks configured terms", () => {
  const result = checkPromptSafety("child abuse scene");
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reasonCode, "LOCAL_RULE_HIT");
});

test("seed users have verifiable password hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-store-"));
  const store = new JsonStore(join(dir, "store.json"));
  const data = await store.read();
  const demo = data.users.find((user) => user.email === "demo@imagora.local");

  assert.ok(demo);
  assert.equal(verifyPassword("Demo123!", demo.passwordHash), true);
  assert.equal(data.plans.length, 3);

  await rm(dir, { recursive: true, force: true });
});

test("production initial data requires explicit bootstrap admin credentials", () => {
  const previous = snapshotEnv([
    "NODE_ENV",
    "IMAGORA_SEED_DEMO_DATA",
    "IMAGORA_BOOTSTRAP_ADMIN_EMAIL",
    "IMAGORA_BOOTSTRAP_ADMIN_PASSWORD"
  ]);
  try {
    process.env.NODE_ENV = "production";
    delete process.env.IMAGORA_SEED_DEMO_DATA;
    delete process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD;

    assert.throws(() => createInitialData(), /IMAGORA_BOOTSTRAP_ADMIN_EMAIL/);
  } finally {
    restoreEnv(previous);
  }
});

test("production bootstrap admin uses configured credentials", () => {
  const previous = snapshotEnv([
    "NODE_ENV",
    "IMAGORA_SEED_DEMO_DATA",
    "IMAGORA_BOOTSTRAP_ADMIN_EMAIL",
    "IMAGORA_BOOTSTRAP_ADMIN_PASSWORD"
  ]);
  try {
    process.env.NODE_ENV = "production";
    delete process.env.IMAGORA_SEED_DEMO_DATA;
    process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL = "owner@example.com";
    process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD = "Owner123!";

    const data = createInitialData();
    assert.equal(data.users.length, 1);
    assert.equal(data.users[0].email, "owner@example.com");
    assert.equal(data.users[0].role, "ADMIN");
    assert.equal(verifyPassword("Owner123!", data.users[0].passwordHash), true);
    assert.equal(
      data.users.some((user) => user.email === "admin@imagora.local"),
      false
    );
  } finally {
    restoreEnv(previous);
  }
});

function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
