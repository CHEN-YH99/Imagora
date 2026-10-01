import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { JsonStore } from "../packages/database/dist/index.js";
import { createEmptyStoreData } from "../packages/database/dist/prisma-store-persistence.js";
import { AppError } from "../packages/shared/dist/index.js";
import { addDays, envNumber } from "../apps/api/dist/runtime.js";
import { referenceUploadSchema } from "../apps/api/dist/schemas.js";
import { extensionForMime, inspectReferenceUpload } from "../apps/api/dist/image-upload.js";
import { registerGenerationRoutes } from "../apps/api/dist/routes/generation.js";
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
  const imageProjectRoutes = await readProjectFile("apps/api/src/routes/image-projects.ts");
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
    "registerImageProjectRoutes",
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
  assert.match(imageRoutes, /\/api\/images\/:imageId\/project/);
  assert.match(imageProjectRoutes, /\/api\/image-projects/);
  assert.match(imageProjectRoutes, /\/api\/image-projects\/:projectId/);
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

test("api generation, upload, order, and observability runtimes are split out of main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const generationRuntime = await readProjectFile("apps/api/src/generation-runtime.ts");
  const imageUpload = await readProjectFile("apps/api/src/image-upload.ts");
  const orderMaintenance = await readProjectFile("apps/api/src/order-maintenance.ts");
  const observability = await readProjectFile("apps/api/src/observability.ts");

  assert.match(main, /from "\.\/generation-runtime\.js"/);
  assert.match(main, /from "\.\/image-upload\.js"/);
  assert.match(main, /from "\.\/order-maintenance\.js"/);
  assert.match(main, /from "\.\/observability\.js"/);
  assert.match(generationRuntime, /export function createGenerationRuntime\b/);
  assert.match(imageUpload, /export function inspectReferenceUpload\b/);
  assert.match(orderMaintenance, /export function createOrderMaintenanceRuntime\b/);
  assert.match(observability, /export function createObservabilityRuntime\b/);
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
    "requireProductionRuntimeStateProvider",
    "requireProductionSessionCookieSameSite",
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

test("api auth and session helpers are isolated from main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const authRuntime = await readProjectFile("apps/api/src/auth-runtime.ts");

  assert.match(main, /from "\.\/auth-runtime\.js"/);
  assert.match(authRuntime, /export function createAuthRuntime\b/);
  for (const helper of [
    "allowBearerSessionAuth",
    "appendSetCookie",
    "assertEmailVerified",
    "clearSessionCookie",
    "cookieValue",
    "defaultNicknameForEmail",
    "requireEmailVerification",
    "serializeCookie",
    "sessionCookieName",
    "sessionCookieSameSite",
    "sessionToken",
    "setSessionCookie"
  ]) {
    assert.match(authRuntime, new RegExp(`export function ${helper}\\b`));
    assert.doesNotMatch(main, new RegExp(`function ${helper}\\b`));
  }
  for (const helper of ["requireAuth", "requireAdmin"]) {
    assert.match(authRuntime, new RegExp(`async function ${helper}\\b`));
    assert.doesNotMatch(main, new RegExp(`async function ${helper}\\b`));
  }
});

test("api captcha and login attempt helpers are isolated from main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const captchaRuntime = await readProjectFile("apps/api/src/captcha-runtime.ts");
  const runtimeState = await readProjectFile("apps/api/src/runtime-state.ts");

  assert.match(main, /from "\.\/captcha-runtime\.js"/);
  for (const exported of [
    "captchaOptions",
    "createCaptchaChallenge",
    "hashCaptchaAnswer",
    "issueLoginAttempt",
    "saveCaptchaChallenge",
    "saveCaptchaVerification",
    "verifyCaptchaChallenge",
    "verifyCaptchaVerifications"
  ]) {
    assert.match(captchaRuntime, new RegExp(`export (?:async )?(?:const|function) ${exported}\\b`));
  }
  assert.match(runtimeState, /export class RuntimeState\b/);
  assert.match(runtimeState, /export function createRuntimeState\b/);
  assert.match(runtimeState, /export const runtimeState\b/);
  assert.doesNotMatch(captchaRuntime, /new Map/);
  for (const helper of [
    "createCaptchaChallenge",
    "createCaptchaSvg",
    "createCaptchaAnimalSvg",
    "verifyCaptchaChallenge",
    "verifyCaptchaVerifications",
    "hashCaptchaAnswer",
    "normalizeCaptchaSelections",
    "captchaSelectionKey",
    "pickUniqueIndexes",
    "randomNonTargetCaptchaOption",
    "exposeCaptchaAnswerForTests",
    "loginAttemptCookieName",
    "loginAttemptMaxTries",
    "loginAttemptTtlMs",
    "issueLoginAttempt",
    "consumeLoginAttempt",
    "clearLoginAttempt"
  ]) {
    assert.doesNotMatch(main, new RegExp(`function ${helper}\\b`));
  }
});

test("api rate limit helpers are isolated from main entrypoint", async () => {
  const main = await readProjectFile("apps/api/src/main.ts");
  const rateLimitRuntime = await readProjectFile("apps/api/src/rate-limit-runtime.ts");

  assert.match(main, /from "\.\/rate-limit-runtime\.js"/);
  assert.match(rateLimitRuntime, /export function createRateLimitRuntime\b/);
  for (const exported of ["rateLimitBuckets", "rateLimitRules", "redisFixedWindowIncrement"]) {
    assert.match(rateLimitRuntime, new RegExp(`export (?:async )?(?:const|function) ${exported}\\b`));
    assert.doesNotMatch(main, new RegExp(`const ${exported}\\b`));
  }
  for (const helper of [
    "enforceRateLimit",
    "rateLimitScope",
    "redisFixedWindowIncrement",
    "redisCommand",
    "encodeRedisCommand",
    "parseRedisResponse",
    "pruneRateLimitBuckets"
  ]) {
    assert.doesNotMatch(main, new RegExp(`function ${helper}\\b`));
  }
});

test("p2 rate limits cover email verification and payment webhooks", async () => {
  const rateLimitRuntime = await readProjectFile("apps/api/src/rate-limit-runtime.ts");

  assert.match(rateLimitRuntime, /id: "auth-verify-email"/);
  assert.ok(rateLimitRuntime.includes("pattern: /^\\/api\\/auth\\/verify-email$/"));
  assert.match(rateLimitRuntime, /id: "payment-webhook"/);
  assert.ok(rateLimitRuntime.includes("pattern: /^\\/api\\/payments\\/webhooks\\/[^/]+$/"));
  assert.match(rateLimitRuntime, /RATE_LIMIT_WEBHOOK_MAX/);
});

test("p2 admin list endpoints authenticate before parsing query strings", async () => {
  const adminRoutes = await readProjectFile("apps/api/src/routes/admin.ts");
  const protectedListRoutes = [
    { route: "/api/admin/users", schema: "adminUserQuerySchema" },
    { route: "/api/admin/generation/tasks", schema: "adminTaskQuerySchema" },
    { route: "/api/admin/images", schema: "adminImageQuerySchema" },
    { route: "/api/admin/orders", schema: "adminOrderQuerySchema" },
    { route: "/api/admin/audit-logs", schema: "adminAuditQuerySchema" },
    { route: "/api/admin/safety-events", schema: "safetyEventQuerySchema" },
    { route: "/api/admin/safety-appeals", schema: "safetyAppealAdminQuerySchema" }
  ];

  for (const { route, schema } of protectedListRoutes) {
    const block = routeBlock(adminRoutes, `app.get("${route}"`);
    const authIndex = block.indexOf("requireAdmin(request)");
    const queryIndex = block.indexOf(`${schema}.parse(request.query)`);
    assert.ok(authIndex >= 0, `${route} should call requireAdmin`);
    assert.ok(queryIndex >= 0, `${route} should parse ${schema}`);
    assert.ok(authIndex < queryIndex, `${route} should authenticate before parsing query`);
  }
});

function routeBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} should exist`);
  const next = source.indexOf("\n  app.", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("reference upload releases the store lock while storage is pending", async (t) => {
  const fixture = await createUploadTransactionFixture(t);
  const entered = uploadGate();
  const release = uploadGate();
  const put = fixture.storage.putObject;
  fixture.storage.putObject = async (input) => {
    entered.resolve();
    await release.promise;
    return put(input);
  };
  const pending = fixture.upload();
  try {
    await uploadDeadline(entered.promise);
    const otherStore = new JsonStore(fixture.store.filePath);
    await uploadDeadline(otherStore.update((data) => data.users.push({ id: "unrelated-writer" })));
  } finally {
    release.resolve();
  }
  assert.equal((await pending).statusCode, 201);
});

test("concurrent reference uploads keep one record and delete only the losing request object", async (t) => {
  const fixture = await createUploadTransactionFixture(t);
  const entered = uploadGate();
  const release = uploadGate();
  const put = fixture.storage.putObject;
  let uploads = 0;
  fixture.storage.putObject = async (input) => {
    if (++uploads === 2) entered.resolve();
    await release.promise;
    return put(input);
  };
  const requests = [fixture.upload(), fixture.upload()];
  try {
    await uploadDeadline(entered.promise);
  } finally {
    release.resolve();
  }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
  const records = (await fixture.store.read()).referenceImages;
  assert.equal(records.length, 1);
  assert.equal(responses[0].json().data.referenceImage.id, responses[1].json().data.referenceImage.id);
  assert.equal(fixture.deleted.length, 1);
  assert.notEqual(fixture.deleted[0], records[0].storageKey);
  assert.deepEqual([...fixture.objects.keys()], [records[0].storageKey]);
  assert.equal((await fixture.upload()).statusCode, 200);
  assert.equal(uploads, 2, "a committed duplicate must not upload again");
});

test("reference upload rollback compensates the new object and preserves the database error", async (t) => {
  for (const deleteFails of [false, true]) {
    await t.test(deleteFails ? "cleanup failure" : "cleanup succeeds", async (t) => {
      const fixture = await createUploadTransactionFixture(t);
      const update = fixture.store.updateScoped.bind(fixture.store);
      fixture.store.updateScoped = (scope, mutate) =>
        update(scope, (data) => {
          const result = mutate(data);
          if (result?.created) throw new Error("reference commit failed");
          return result;
        });
      if (deleteFails) {
        fixture.storage.deleteObject = async (key) => {
          fixture.deleted.push(key);
          throw new Error("storage cleanup failed");
        };
      }
      const response = await fixture.upload();
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().message, "reference commit failed");
      assert.equal((await fixture.store.read()).referenceImages.length, 0);
      assert.equal(fixture.deleted.length, 1);
      if (!deleteFails) assert.equal(fixture.objects.size, 0);
    });
  }
});

test("reference upload retains committed or unverifiable objects after a lost commit response", async (t) => {
  for (const verificationFails of [false, true]) {
    await t.test(verificationFails ? "verification unavailable" : "commit confirmed", async (t) => {
      const fixture = await createUploadTransactionFixture(t);
      const update = fixture.store.updateScoped.bind(fixture.store);
      fixture.store.updateScoped = async (scope, mutate) => {
        if (verificationFails && scope.referenceImages?.ids) throw new Error("database unavailable");
        const result = await update(scope, mutate);
        if (result?.created) throw new Error("commit response lost");
        return result;
      };
      const response = await fixture.upload();
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().message, "commit response lost");
      const records = (await fixture.store.read()).referenceImages;
      assert.equal(records.length, 1);
      assert.equal(fixture.deleted.length, 0);
      assert.ok(fixture.objects.has(records[0].storageKey));
      assert.equal((await fixture.upload()).statusCode, 200);
    });
  }
});

test("reference upload cleans up a partial PUT and rechecks the feature switch after upload", async (t) => {
  for (const putFails of [false, true]) {
    await t.test(putFails ? "PUT response lost" : "uploads disabled during PUT", async (t) => {
      const fixture = await createUploadTransactionFixture(t);
      const put = fixture.storage.putObject;
      fixture.storage.putObject = async (input) => {
        const result = await put(input);
        if (putFails) throw new Error("PUT response lost");
        fixture.flags.uploads = false;
        return result;
      };
      const response = await fixture.upload();
      assert.equal(response.statusCode, putFails ? 500 : 503);
      assert.equal((await fixture.store.read()).referenceImages.length, 0);
      assert.equal(fixture.objects.size, 0);
      assert.equal(fixture.deleted.length, 1);
    });
  }
});

test("reference image moderation persists refusals without uploading and ignores stale or foreign duplicates", async (t) => {
  const fixture = await createUploadTransactionFixture(t);
  for (const status of ["BLOCKED", "REVIEW_REQUIRED"]) {
    fixture.safety.checkImage = async () => ({ status, reasonCode: "TEST", reasonMessage: "review", provider: "test" });
    assert.equal((await fixture.upload()).statusCode, 400);
  }
  assert.equal((await fixture.store.read()).safetyEvents.length, 2);
  assert.equal(fixture.objects.size, 0);
  fixture.safety.checkImage = async () => ({ status: "PASSED" });
  const first = (await fixture.upload()).json().data.referenceImage;
  await fixture.store.update((data) => {
    data.referenceImages[0].userId = "another-user";
  });
  const owned = (await fixture.upload()).json().data.referenceImage;
  assert.notEqual(owned.id, first.id);
  for (const mutation of [
    (image) => {
      image.expiresAt = new Date(0).toISOString();
    },
    (image) => {
      image.deletedAt = new Date().toISOString();
    },
    (image) => {
      image.safetyStatus = "BLOCKED";
    }
  ]) {
    await fixture.store.update((data) => mutation(data.referenceImages.at(-1)));
    assert.equal((await fixture.upload()).statusCode, 201);
  }
});

async function createUploadTransactionFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "imagora-upload-transaction-"));
  const store = new JsonStore(join(directory, "store.json"));
  await store.write(createEmptyStoreData());
  const objects = new Map();
  const deleted = [];
  const flags = { uploads: true };
  const storage = {
    async putObject(input) {
      objects.set(input.key, input.body);
      return { key: input.key, publicUrl: "test://" + input.key };
    },
    async deleteObject(key) {
      deleted.push(key);
      objects.delete(key);
    }
  };
  const safety = {
    async checkImage() {
      return { status: "PASSED" };
    }
  };
  const app = Fastify();
  registerGenerationRoutes(app, {
    store,
    storage,
    safetyProvider: safety,
    AppError,
    addDays,
    envNumber,
    randomUUID,
    referenceUploadSchema,
    inspectReferenceUpload,
    extensionForMime,
    uploadBodyLimitBytes: () => 1024 * 1024,
    requireSession: async () => ({ user: { id: "upload-user" } }),
    assertFeatureEnabled: (feature) => {
      if (!flags[feature]) throw new AppError("FEATURE_DISABLED", "Feature disabled", 503);
    },
    envelope: (_request, data) => ({ data })
  });
  t.after(async () => {
    await app.close();
    assert.ok(!relative(tmpdir(), directory).startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });
  await app.ready();
  return {
    store,
    storage,
    safety,
    objects,
    deleted,
    flags,
    upload: () =>
      app.inject({
        method: "POST",
        url: "/api/uploads/reference-images",
        payload: {
          fileName: "reference.png",
          mimeType: "image/png",
          contentBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC"
        }
      })
  };
}

function uploadGate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function uploadDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("external call retained the store lock")), 2500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
