import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore, verifyPassword } from "../packages/database/dist/index.js";
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
