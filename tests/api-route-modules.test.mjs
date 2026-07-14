import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

async function readProjectFile(path) {
  return readFile(join(root, path), "utf8");
}

test("api routes are registered through domain modules instead of main.ts", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const routeIndex = await readProjectFile("apps/api/src/routes/index.ts");
  const systemRoutes = await readProjectFile("apps/api/src/routes/system.ts");
  const authRoutes = await readProjectFile("apps/api/src/routes/auth.ts");
  const generationRoutes = await readProjectFile("apps/api/src/routes/generation.ts");
  const imageRoutes = await readProjectFile("apps/api/src/routes/images.ts");
  const orderRoutes = await readProjectFile("apps/api/src/routes/orders.ts");
  const adminRoutes = await readProjectFile("apps/api/src/routes/admin.ts");

  assert.match(main, /import \{ registerApiRoutes \} from "\.\/routes\/index\.js";/);
  assert.match(main, /registerApiRoutes\(app, createRouteContext\(\)\);/);
  assert.doesNotMatch(main, /app\.(get|post|patch|delete)\("\/api\/auth\//);
  assert.doesNotMatch(main, /app\.(get|post|patch|delete)\("\/api\/generation\//);
  assert.doesNotMatch(main, /app\.(get|post|patch|delete)\("\/api\/images/);
  assert.doesNotMatch(main, /app\.(get|post|patch|delete)\("\/api\/orders/);
  assert.doesNotMatch(main, /app\.(get|post|patch|delete)\("\/api\/admin\//);

  assert.match(routeIndex, /export function registerApiRoutes/);
  for (const registrar of [
    "registerSystemRoutes",
    "registerAuthRoutes",
    "registerGenerationRoutes",
    "registerImageRoutes",
    "registerOrderRoutes",
    "registerAdminRoutes"
  ]) {
    assert.match(routeIndex, new RegExp(`${registrar}\\(app, context\\)`));
  }

  assert.match(systemRoutes, /\/health/);
  assert.match(systemRoutes, /\/api\/features/);
  assert.match(systemRoutes, /\/api\/files\/\*/);
  assert.match(authRoutes, /\/api\/auth\/captcha/);
  assert.match(authRoutes, /\/api\/auth\/register/);
  assert.match(authRoutes, /\/api\/auth\/login/);
  assert.match(authRoutes, /\/api\/auth\/verify-email/);
  assert.match(authRoutes, /\/api\/users\/me\/credits/);
  assert.match(generationRoutes, /\/api\/generation\/quote/);
  assert.match(generationRoutes, /\/api\/generation\/tasks/);
  assert.match(generationRoutes, /\/api\/uploads\/reference-images/);
  assert.match(imageRoutes, /\/api\/images\/:imageId\/download-url/);
  assert.match(orderRoutes, /\/api\/orders\/:orderId\/pay/);
  assert.match(orderRoutes, /\/api\/payments\/webhooks\/:provider/);
  assert.match(adminRoutes, /\/api\/admin\/dashboard/);
  assert.match(adminRoutes, /\/api\/admin\/users/);
  assert.match(adminRoutes, /\/api\/admin\/safety-events/);
  assert.match(adminRoutes, /\/api\/safety-appeals/);
});

test("api runtime helpers are split out of main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const runtime = await readProjectFile("apps/api/src/runtime.ts");

  assert.match(main, /from "\.\/runtime\.js"/);
  for (const helper of [
    "addDays",
    "descCreated",
    "descUpdated",
    "envBool",
    "envNumber",
    "envString",
    "errorMessage",
    "headerValue",
    "pathOnly",
    "payloadRecord",
    "round",
    "webhookSignature"
  ]) {
    assert.match(runtime, new RegExp(`export function ${helper}\\b`));
    assert.doesNotMatch(main, new RegExp(`function ${helper}\\b`));
  }
});

test("api production readiness checks are isolated from main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const productionConfig = await readProjectFile("apps/api/src/production-config.ts");

  assert.match(main, /from "\.\/production-config\.js"/);
  assert.match(productionConfig, /export function validateProductionConfig\b/);
  for (const helper of [
    "requireProductionValue",
    "requireProductionSetting",
    "requireProductionNumber",
    "requireProductionImageProvider",
    "requireProductionImageModel",
    "requireProductionGenerationRunningTimeout",
    "rejectLocalhostProductionValue"
  ]) {
    assert.match(productionConfig, new RegExp(`function ${helper}\\b`));
    assert.doesNotMatch(main, new RegExp(`function ${helper}\\b`));
  }
});

test("api request schemas are isolated from main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const schemas = await readProjectFile("apps/api/src/schemas.ts");

  assert.match(main, /from "\.\/schemas\.js"/);
  for (const schema of [
    "registerSchema",
    "loginSchema",
    "generationInputSchema",
    "referenceUploadSchema",
    "adminUserQuerySchema",
    "adminTaskQuerySchema",
    "adminImageQuerySchema",
    "adminOrderQuerySchema",
    "safetyAppealReviewSchema"
  ]) {
    assert.match(schemas, new RegExp(`export const ${schema}\\b`));
    assert.doesNotMatch(main, new RegExp(`const ${schema}\\b`));
  }
});
