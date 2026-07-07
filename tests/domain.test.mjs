import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProductionOpenAiGenerationConfig,
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_TIMEOUT_MS,
  MAX_PRODUCTION_OPENAI_MAX_RETRIES,
  getActiveProviderMetadata,
  MIN_PRODUCTION_OPENAI_TIMEOUT_MS,
  MockImageGenerationProvider,
  OpenAiImageGenerationProvider,
  ProviderError,
  isProviderError,
  quoteImageGeneration,
  readOpenAiGenerationRuntimeConfig,
  resolveDefaultImageModel,
  resolveDefaultImageProvider,
  resolveProviderModel
} from "../packages/ai-providers/dist/index.js";
import { createInitialData, JsonStore, verifyPassword } from "../packages/database/dist/index.js";
import { SmtpMailer, createMailer } from "../packages/mailer/dist/index.js";
import { StripePaymentProvider, createPaymentProvider } from "../packages/payments/dist/index.js";
import { HttpSafetyProvider, createSafetyProvider } from "../packages/safety/dist/index.js";
import { createObjectStorage } from "../packages/storage/dist/index.js";
import { checkPromptSafety } from "../packages/shared/dist/index.js";

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("provider quote resolves active mock provider model and charges by quality, size, quantity", () => {
  const previous = snapshotEnv(["IMAGE_PROVIDER_DEFAULT", "IMAGE_MODEL_DEFAULT", "AI_PROVIDER", "OPENAI_IMAGE_MODEL"]);
  try {
    process.env.IMAGE_PROVIDER_DEFAULT = "mock";
    delete process.env.IMAGE_MODEL_DEFAULT;
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_IMAGE_MODEL;
    const resolvedModel = resolveProviderModel("mock", "mock");
    const quote = quoteImageGeneration({
      style: "illustration",
      quality: "high",
      quantity: 3,
      aspectRatio: "16:9",
      model: resolvedModel
    });

    assert.equal(resolvedModel, "mock:default");
    assert.equal(quote.provider, "mock");
    assert.equal(quote.model, "mock:default");
    assert.equal(quote.size, "1536x1024");
    assert.equal(quote.creditCost, 14);
  } finally {
    restoreEnv(previous);
  }
});

test("image provider config prefers canonical IMAGE_PROVIDER_DEFAULT and IMAGE_MODEL_DEFAULT", () => {
  const previous = snapshotEnv(["IMAGE_PROVIDER_DEFAULT", "IMAGE_MODEL_DEFAULT", "AI_PROVIDER", "OPENAI_IMAGE_MODEL"]);
  try {
    process.env.IMAGE_PROVIDER_DEFAULT = "openai";
    process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
    process.env.AI_PROVIDER = "mock";
    process.env.OPENAI_IMAGE_MODEL = "mock";

    assert.equal(resolveDefaultImageProvider(), "openai");
    assert.equal(resolveDefaultImageModel(), "openai:gpt-image-2");
    assert.equal(getActiveProviderMetadata().modelName, "openai:gpt-image-2");
    assert.equal(resolveProviderModel("gpt-image-2", "openai"), "openai:gpt-image-2");
  } finally {
    restoreEnv(previous);
  }
});

test("image provider config auto-selects openai when only OPENAI_API_KEY is configured", () => {
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "AI_PROVIDER",
    "OPENAI_IMAGE_MODEL",
    "OPENAI_API_KEY"
  ]);
  try {
    delete process.env.IMAGE_PROVIDER_DEFAULT;
    delete process.env.IMAGE_MODEL_DEFAULT;
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_IMAGE_MODEL;
    process.env.OPENAI_API_KEY = "sk-test";

    assert.equal(resolveDefaultImageProvider(), "openai");
    assert.equal(resolveDefaultImageModel(), "openai:gpt-image-2");
    assert.equal(getActiveProviderMetadata().modelName, "openai:gpt-image-2");
  } finally {
    restoreEnv(previous);
  }
});

test("image provider config falls back to legacy AI_PROVIDER and OPENAI_IMAGE_MODEL aliases", () => {
  const previous = snapshotEnv(["IMAGE_PROVIDER_DEFAULT", "IMAGE_MODEL_DEFAULT", "AI_PROVIDER", "OPENAI_IMAGE_MODEL"]);
  try {
    delete process.env.IMAGE_PROVIDER_DEFAULT;
    delete process.env.IMAGE_MODEL_DEFAULT;
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-2";

    assert.equal(resolveDefaultImageProvider(), "openai");
    assert.equal(resolveDefaultImageModel(), "openai:gpt-image-2");
    assert.equal(resolveProviderModel("mock", "mock"), "mock:default");
  } finally {
    restoreEnv(previous);
  }
});

test("mock provider exposes content blocked and empty result contract errors", async () => {
  const provider = new MockImageGenerationProvider();
  await assert.rejects(
    () =>
      provider.generateImage({
        taskId: "task-blocked",
        prompt: "blocked concept frame",
        style: "poster",
        aspectRatio: "1:1",
        width: 1024,
        height: 1024,
        quantity: 1,
        quality: "draft"
      }),
    (error) => {
      assert.equal(isProviderError(error), true);
      assert.equal(error.code, "PROVIDER_CONTENT_BLOCKED");
      return true;
    }
  );

  await assert.rejects(
    () =>
      provider.generateImage({
        taskId: "task-empty",
        prompt: "empty result request",
        style: "poster",
        aspectRatio: "1:1",
        width: 1024,
        height: 1024,
        quantity: 1,
        quality: "draft"
      }),
    (error) => {
      assert.equal(isProviderError(error), true);
      assert.equal(error.code, "PROVIDER_EMPTY_RESULT");
      return true;
    }
  );
});

test("openai provider retries once on rate limit and returns images", async () => {
  const server = createFakeOpenAiServer([
    {
      status: 429,
      body: {
        error: {
          message: "Slow down",
          code: "rate_limit_exceeded"
        }
      }
    },
    {
      status: 200,
      body: {
        id: "req_retry_success",
        data: [{ b64_json: onePixelPngBase64 }]
      }
    }
  ]);
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "OPENAI_RETRY_BASE_MS",
    "OPENAI_IMAGE_MODEL"
  ]);

  await server.listen();
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENAI_TIMEOUT_MS = "500";
    process.env.OPENAI_MAX_RETRIES = "2";
    process.env.OPENAI_RETRY_BASE_MS = "10";
    process.env.IMAGE_PROVIDER_DEFAULT = "openai";
    process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
    delete process.env.OPENAI_IMAGE_MODEL;

    const provider = new OpenAiImageGenerationProvider();
    const result = await provider.generateImage({
      taskId: "task-openai-retry",
      prompt: "A clean product visualization",
      style: "product_photography",
      aspectRatio: "1:1",
      width: 1024,
      height: 1024,
      quantity: 1,
      quality: "standard"
    });

    assert.equal(server.requests.length, 2);
    assert.equal(result.images.length, 1);
    assert.equal(result.providerRequestId, "req_retry_success");
    assert.match(server.requests[0].authorization ?? "", /^Bearer sk-test$/);
  } finally {
    restoreEnv(previous);
    await server.close();
  }
});

test("openai generation runtime defaults favor long-running jobs without aggressive retries", () => {
  const previous = snapshotEnv(["OPENAI_TIMEOUT_MS", "OPENAI_MAX_RETRIES", "OPENAI_RETRY_BASE_MS"]);
  try {
    delete process.env.OPENAI_TIMEOUT_MS;
    delete process.env.OPENAI_MAX_RETRIES;
    delete process.env.OPENAI_RETRY_BASE_MS;

    const config = readOpenAiGenerationRuntimeConfig();

    assert.equal(config.timeoutMs, DEFAULT_OPENAI_TIMEOUT_MS);
    assert.equal(config.maxRetries, DEFAULT_OPENAI_MAX_RETRIES);
    assert.equal(config.initialBackoffMs, 600);
  } finally {
    restoreEnv(previous);
  }
});

test("openai provider does not auto-retry timed out image requests", async () => {
  const server = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "req_timeout_no_retry",
        data: [{ b64_json: onePixelPngBase64 }]
      },
      delayMs: 120
    }
  ]);
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "OPENAI_RETRY_BASE_MS",
    "OPENAI_IMAGE_MODEL"
  ]);

  await server.listen();
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENAI_TIMEOUT_MS = "50";
    process.env.OPENAI_MAX_RETRIES = "2";
    process.env.OPENAI_RETRY_BASE_MS = "10";
    process.env.IMAGE_PROVIDER_DEFAULT = "openai";
    process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
    delete process.env.OPENAI_IMAGE_MODEL;

    await assert.rejects(
      () => new OpenAiImageGenerationProvider().generateImage(fakeOpenAiInput("timeout-no-retry")),
      (error) => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.code, "PROVIDER_TIMEOUT");
        return true;
      }
    );

    assert.equal(server.requests.length, 1);
  } finally {
    restoreEnv(previous);
    await server.close();
  }
});

test("openai provider accepts non-array and nested image payload variants", async () => {
  const server = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "req_variant_data_url",
        output: { result: `data:image/png;base64,${onePixelPngBase64}` }
      }
    },
    {
      status: 200,
      body: {
        id: "req_variant_content",
        output: {
          content: [{ type: "output_image", image_base64: onePixelPngBase64, mime_type: "image/png" }]
        }
      }
    },
    {
      status: 200,
      body: {
        id: "req_variant_mixed_content",
        output: {
          content: [
            { type: "output_text", text: "ignore this block" },
            { type: "output_image", result: `data:image/png;base64,${onePixelPngBase64}` }
          ]
        }
      }
    },
    {
      status: 200,
      body: {
        id: "req_variant_nested_image",
        image: {
          b64_json: onePixelPngBase64,
          mimeType: "image/png"
        }
      }
    },
    {
      status: 200,
      body: {
        id: "req_variant_image_string",
        image: onePixelPngBase64
      }
    }
  ]);
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "OPENAI_RETRY_BASE_MS",
    "OPENAI_IMAGE_MODEL"
  ]);

  await server.listen();
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENAI_TIMEOUT_MS = "500";
    process.env.OPENAI_MAX_RETRIES = "0";
    process.env.OPENAI_RETRY_BASE_MS = "10";
    process.env.IMAGE_PROVIDER_DEFAULT = "openai";
    process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
    delete process.env.OPENAI_IMAGE_MODEL;

    const result = await new OpenAiImageGenerationProvider().generateImage({
      ...fakeOpenAiInput("variant-success"),
      quantity: 5
    });

    assert.equal(server.requests.length, 5);
    for (const request of server.requests) {
      const requestBody = JSON.parse(request.body);
      assert.equal(requestBody.n, 1);
    }
    assert.equal(result.images.length, 5);
    for (const image of result.images) {
      assert.equal(image.mimeType, "image/png");
      assert.equal(image.bytes, onePixelPngBase64);
    }
    assert.equal(result.providerRequestId, "openai_variant-success");
    assert.deepEqual(result.raw.requestIds, [
      "req_variant_data_url",
      "req_variant_content",
      "req_variant_mixed_content",
      "req_variant_nested_image",
      "req_variant_image_string"
    ]);
  } finally {
    restoreEnv(previous);
    await server.close();
  }
});

test("openai provider scales request timeout for batch generation", async () => {
  const server = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "req_timeout_split_1",
        data: [{ b64_json: onePixelPngBase64 }]
      },
      delayMs: 180
    },
    {
      status: 200,
      body: {
        id: "req_timeout_split_2",
        data: [{ b64_json: onePixelPngBase64 }]
      },
      delayMs: 180
    },
    {
      status: 200,
      body: {
        id: "req_timeout_split_3",
        data: [{ b64_json: onePixelPngBase64 }]
      },
      delayMs: 180
    }
  ]);
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "OPENAI_RETRY_BASE_MS",
    "OPENAI_IMAGE_MODEL"
  ]);

  await server.listen();
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENAI_TIMEOUT_MS = "220";
    process.env.OPENAI_MAX_RETRIES = "0";
    process.env.OPENAI_RETRY_BASE_MS = "10";
    process.env.IMAGE_PROVIDER_DEFAULT = "openai";
    process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
    delete process.env.OPENAI_IMAGE_MODEL;

    const result = await new OpenAiImageGenerationProvider().generateImage({
      ...fakeOpenAiInput("timeout-scaled-batch"),
      quantity: 3
    });

    assert.equal(server.requests.length, 3);
    for (const request of server.requests) {
      const requestBody = JSON.parse(request.body);
      assert.equal(requestBody.n, 1);
    }
    assert.equal(result.providerRequestId, "openai_timeout-scaled-batch");
    assert.equal(result.images.length, 3);
  } finally {
    restoreEnv(previous);
    await server.close();
  }
});

test("openai provider maps timeout, moderation, auth and empty result errors", async () => {
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "OPENAI_RETRY_BASE_MS",
    "OPENAI_IMAGE_MODEL"
  ]);

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_TIMEOUT_MS = "50";
  process.env.OPENAI_MAX_RETRIES = "0";
  process.env.OPENAI_RETRY_BASE_MS = "10";
  process.env.IMAGE_PROVIDER_DEFAULT = "openai";
  process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
  delete process.env.OPENAI_IMAGE_MODEL;

  const timeoutServer = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "late_response",
        data: [{ b64_json: onePixelPngBase64 }]
      },
      delayMs: 120
    }
  ]);
  const moderationServer = createFakeOpenAiServer([
    {
      status: 400,
      body: {
        error: {
          message: "Blocked by policy",
          code: "content_policy_violation",
          type: "content_policy_error"
        }
      }
    }
  ]);
  const authServer = createFakeOpenAiServer([
    {
      status: 401,
      body: {
        error: {
          message: "Bad key"
        }
      }
    }
  ]);
  const emptyServer = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "empty_result",
        data: [{}]
      }
    }
  ]);

  await timeoutServer.listen();
  await moderationServer.listen();
  await authServer.listen();
  await emptyServer.listen();

  try {
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${timeoutServer.port}`;
    await assert.rejects(
      () => new OpenAiImageGenerationProvider().generateImage(fakeOpenAiInput("timeout")),
      (error) => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.code, "PROVIDER_TIMEOUT");
        return true;
      }
    );

    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${moderationServer.port}`;
    await assert.rejects(
      () => new OpenAiImageGenerationProvider().generateImage(fakeOpenAiInput("moderation")),
      (error) => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.code, "PROVIDER_CONTENT_BLOCKED");
        return true;
      }
    );

    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${authServer.port}`;
    await assert.rejects(
      () => new OpenAiImageGenerationProvider().generateImage(fakeOpenAiInput("auth")),
      (error) => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.code, "PROVIDER_AUTH_FAILED");
        assert.match(error.message, /OPENAI_API_KEY/);
        assert.match(error.message, /OPENAI_BASE_URL/);
        assert.match(error.message, /Bad key/);
        return true;
      }
    );

    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${emptyServer.port}`;
    await assert.rejects(
      () => new OpenAiImageGenerationProvider().generateImage(fakeOpenAiInput("empty")),
      (error) => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.code, "PROVIDER_EMPTY_RESULT");
        return true;
      }
    );
  } finally {
    restoreEnv(previous);
    await timeoutServer.close();
    await moderationServer.close();
    await authServer.close();
    await emptyServer.close();
  }
});

test("production openai runtime guard rejects short timeouts and excessive retries", () => {
  const previous = snapshotEnv(["OPENAI_TIMEOUT_MS", "OPENAI_MAX_RETRIES"]);
  try {
    process.env.OPENAI_TIMEOUT_MS = String(MIN_PRODUCTION_OPENAI_TIMEOUT_MS - 1);
    process.env.OPENAI_MAX_RETRIES = String(MAX_PRODUCTION_OPENAI_MAX_RETRIES);
    assert.throws(() => assertProductionOpenAiGenerationConfig(), /OPENAI_TIMEOUT_MS must be at least/);

    process.env.OPENAI_TIMEOUT_MS = String(MIN_PRODUCTION_OPENAI_TIMEOUT_MS);
    process.env.OPENAI_MAX_RETRIES = String(MAX_PRODUCTION_OPENAI_MAX_RETRIES + 1);
    assert.throws(() => assertProductionOpenAiGenerationConfig(), /OPENAI_MAX_RETRIES must be 1 or less/);
  } finally {
    restoreEnv(previous);
  }
});

test("openai provider rejects url-only image responses", async () => {
  const server = createFakeOpenAiServer([
    {
      status: 200,
      body: {
        id: "url_only_response",
        output: [{ result: "https://cdn.example/generated.png" }]
      }
    }
  ]);
  const previous = snapshotEnv([
    "IMAGE_PROVIDER_DEFAULT",
    "IMAGE_MODEL_DEFAULT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "OPENAI_RETRY_BASE_MS",
    "OPENAI_IMAGE_MODEL"
  ]);

  await server.listen();
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENAI_TIMEOUT_MS = "200";
    process.env.OPENAI_MAX_RETRIES = "0";
    process.env.OPENAI_RETRY_BASE_MS = "10";
    process.env.IMAGE_PROVIDER_DEFAULT = "openai";
    process.env.IMAGE_MODEL_DEFAULT = "openai:gpt-image-2";
    delete process.env.OPENAI_IMAGE_MODEL;

    await assert.rejects(
      () => new OpenAiImageGenerationProvider().generateImage(fakeOpenAiInput("url-only")),
      (error) => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.code, "PROVIDER_BAD_RESPONSE");
        assert.match(error.message, /不能返回 url/);
        return true;
      }
    );
  } finally {
    restoreEnv(previous);
    await server.close();
  }
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

test("smtp mailer sends an authenticated MIME message", async () => {
  const smtp = createFakeSmtpServer();
  const previous = snapshotEnv([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_FROM_NAME",
    "SMTP_REQUIRE_TLS",
    "SMTP_SECURE",
    "SMTP_TIMEOUT_MS"
  ]);

  await smtp.listen();
  try {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = "smtp-user";
    process.env.SMTP_PASSWORD = "smtp-password";
    process.env.SMTP_FROM = "no-reply@example.com";
    process.env.SMTP_FROM_NAME = "Imagora Tests";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_TIMEOUT_MS = "2000";

    await new SmtpMailer().sendEmail({
      to: "Recipient <recipient@example.com>",
      subject: "SMTP smoke",
      text: "Plain body from SMTP test.",
      html: "<p>HTML body from SMTP test.</p>"
    });

    assert.ok(smtp.commands.some((command) => command.startsWith("EHLO ")));
    assert.ok(smtp.commands.some((command) => command.startsWith("AUTH PLAIN ")));
    assert.ok(smtp.commands.includes("MAIL FROM:<no-reply@example.com>"));
    assert.ok(smtp.commands.includes("RCPT TO:<recipient@example.com>"));
    assert.match(smtp.message, /From: "Imagora Tests" <no-reply@example\.com>/);
    assert.match(smtp.message, /To: Recipient <recipient@example\.com>/);
    assert.match(smtp.message, /Subject: SMTP smoke/);
    assert.match(smtp.message, /Plain body from SMTP test\./);
    assert.match(smtp.message, /<p>HTML body from SMTP test\.<\/p>/);
  } finally {
    restoreEnv(previous);
    await smtp.close();
  }
});

test("stripe webhook accepts a matching signature when multiple v1 signatures are present", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_TOLERANCE_SECONDS"]);
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = "300";

    const payload = JSON.stringify({
      id: "evt_multi_signature",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 9900,
          currency: "usd",
          metadata: {
            orderId: "order_multi_signature",
            orderNo: "IM20260629001"
          }
        }
      }
    });
    const timestamp = currentStripeTimestamp();
    const validSignature = stripeSignature(process.env.STRIPE_WEBHOOK_SECRET, timestamp, payload);
    const invalidSignature = "0".repeat(64);
    const header = `t=${timestamp},v1=${validSignature},v1=${invalidSignature}`;

    const event = await new StripePaymentProvider().verifyWebhook(payload, header);

    assert.equal(event.provider, "stripe");
    assert.equal(event.providerEventId, "evt_multi_signature");
    assert.equal(event.orderId, "order_multi_signature");
    assert.equal(event.orderNo, "IM20260629001");
    assert.equal(event.amountCents, 9900);
    assert.equal(event.currency, "USD");
  } finally {
    restoreEnv(previous);
  }
});

test("stripe checkout session carries immutable server order identity", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_API_BASE_URL"]);
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_API_BASE_URL = "http://127.0.0.1:18123";
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: "cs_test_server_order_identity",
          url: "https://checkout.stripe.test/pay/cs_test_server_order_identity"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const payment = await new StripePaymentProvider().createPayment({
      orderId: "order_server_identity",
      orderNo: "IM20260629002",
      amountCents: 1900,
      currency: "USD"
    });

    assert.equal(payment.paymentIntentId, "cs_test_server_order_identity");
    assert.equal(payment.checkoutUrl, "https://checkout.stripe.test/pay/cs_test_server_order_identity");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18123/v1/checkout/sessions");
    assert.equal(requests[0].init.headers.Authorization, "Bearer sk_test_local");
    const body = new URLSearchParams(String(requests[0].init.body));
    assert.equal(body.get("client_reference_id"), "order_server_identity");
    assert.equal(body.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(body.get("line_items[0][price_data][unit_amount]"), "1900");
    assert.equal(body.get("metadata[orderId]"), "order_server_identity");
    assert.equal(body.get("metadata[orderNo]"), "IM20260629002");
    assert.equal(body.get("payment_intent_data[metadata][orderId]"), "order_server_identity");
    assert.equal(body.get("payment_intent_data[metadata][orderNo]"), "IM20260629002");
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previous);
  }
});

test("stripe webhook rejects a payload that no longer matches the signature", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_TOLERANCE_SECONDS"]);
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = "300";

    const originalPayload = JSON.stringify({
      id: "evt_signed_payload",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 9900,
          metadata: {
            orderId: "order_signed_payload"
          }
        }
      }
    });
    const tamperedPayload = JSON.stringify({
      id: "evt_signed_payload",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 1,
          metadata: {
            orderId: "order_signed_payload"
          }
        }
      }
    });
    const timestamp = currentStripeTimestamp();
    const header = `t=${timestamp},v1=${stripeSignature(process.env.STRIPE_WEBHOOK_SECRET, timestamp, originalPayload)}`;

    await assert.rejects(
      () => new StripePaymentProvider().verifyWebhook(tamperedPayload, header),
      /Invalid Stripe webhook signature/
    );
  } finally {
    restoreEnv(previous);
  }
});

test("stripe webhook rejects signatures outside the timestamp tolerance", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_TOLERANCE_SECONDS"]);
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = "1";

    const payload = JSON.stringify({
      id: "evt_stale_signature",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 9900,
          metadata: {
            orderId: "order_stale_signature"
          }
        }
      }
    });
    const timestamp = String(Math.floor(Date.now() / 1000) - 10);
    const header = `t=${timestamp},v1=${stripeSignature(process.env.STRIPE_WEBHOOK_SECRET, timestamp, payload)}`;

    await assert.rejects(
      () => new StripePaymentProvider().verifyWebhook(payload, header),
      /timestamp is outside tolerance/
    );
  } finally {
    restoreEnv(previous);
  }
});

test("http safety provider checks third-party text and image endpoints", async () => {
  const server = createFakeSafetyServer([
    {
      status: 200,
      body: {
        status: "REVIEW_REQUIRED",
        reasonCode: "TEXT_REVIEW",
        reasonMessage: "第三方文本审核要求人工复核",
        provider: "fake-third-party"
      }
    },
    {
      status: 200,
      body: {
        status: "BLOCKED",
        reasonCode: "IMAGE_BLOCKED",
        reasonMessage: "第三方图片审核拦截",
        provider: "fake-third-party"
      }
    }
  ]);
  await server.listen();
  try {
    const provider = new HttpSafetyProvider({
      textEndpoint: `http://127.0.0.1:${server.port}/text`,
      imageEndpoint: `http://127.0.0.1:${server.port}/image`,
      token: "secret-token",
      timeoutMs: 1000
    });

    const textResult = await provider.checkText({
      text: "needs review",
      blockedTerms: ["blocked"],
      reviewTerms: ["review"]
    });
    const imageResult = await provider.checkImage({
      mimeType: "image/png",
      bytes: onePixelPngBase64
    });

    assert.equal(textResult.status, "REVIEW_REQUIRED");
    assert.equal(textResult.reasonCode, "TEXT_REVIEW");
    assert.equal(imageResult.status, "BLOCKED");
    assert.equal(imageResult.reasonCode, "IMAGE_BLOCKED");
    assert.equal(server.requests[0].authorization, "Bearer secret-token");
    assert.equal(server.requests[0].path, "/text");
    assert.equal(server.requests[1].path, "/image");
    assert.deepEqual(JSON.parse(server.requests[0].body), {
      type: "text",
      text: "needs review",
      blockedTerms: ["blocked"],
      reviewTerms: ["review"]
    });
    assert.deepEqual(JSON.parse(server.requests[1].body), {
      type: "image",
      mimeType: "image/png",
      bytes: onePixelPngBase64
    });
  } finally {
    await server.close();
  }
});

test("http safety provider sends uncertain provider failures to manual review", async () => {
  const server = createFakeSafetyServer([
    {
      status: 503,
      body: { error: "provider unavailable" }
    }
  ]);
  await server.listen();
  try {
    const provider = new HttpSafetyProvider({
      textEndpoint: `http://127.0.0.1:${server.port}/text`,
      imageEndpoint: `http://127.0.0.1:${server.port}/image`,
      timeoutMs: 1000
    });

    const result = await provider.checkText({ text: "ordinary prompt" });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reasonCode, "HTTP_PROVIDER_UNAVAILABLE");
    assert.equal(result.provider, "http-safety");
  } finally {
    await server.close();
  }
});

test("createSafetyProvider resolves configured http third-party provider", () => {
  const previous = snapshotEnv(["SAFETY_TEXT_ENDPOINT", "SAFETY_IMAGE_ENDPOINT", "SAFETY_PROVIDER_TOKEN"]);
  try {
    process.env.SAFETY_TEXT_ENDPOINT = "https://safety.example/text";
    process.env.SAFETY_IMAGE_ENDPOINT = "https://safety.example/image";
    process.env.SAFETY_PROVIDER_TOKEN = "runtime-secret";

    const provider = createSafetyProvider("http");

    assert.equal(provider.name, "http-safety");
  } finally {
    restoreEnv(previous);
  }
});

test("provider factories reject unfinished production adapters", () => {
  assert.throws(
    () => createObjectStorage("aliyun-oss"),
    /Unsupported storage provider: aliyun-oss\. Implemented providers: inline, s3, r2/
  );
  assert.throws(
    () => createPaymentProvider("wechat"),
    /Unsupported payment provider: wechat\. Implemented providers: mock, stripe/
  );
  assert.throws(
    () => createSafetyProvider("aliyun"),
    /Unsupported safety provider: aliyun\. Implemented providers: local, http/
  );
});

test("mailer factory keeps production route on smtp only", () => {
  const previous = snapshotEnv(["MAILER_PROVIDER"]);
  try {
    process.env.MAILER_PROVIDER = "aliyun";

    assert.throws(() => createMailer(), /Unknown MAILER_PROVIDER: aliyun\. Implemented providers: console, smtp/);
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

function currentStripeTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

function stripeSignature(secret, timestamp, payload) {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

function createFakeSmtpServer() {
  const commands = [];
  let message = "";
  let port = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    let receivingData = false;
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp.local ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.length) {
        if (receivingData) {
          const dataEnd = buffer.indexOf("\r\n.\r\n");
          if (dataEnd === -1) {
            return;
          }
          message += buffer.slice(0, dataEnd);
          buffer = buffer.slice(dataEnd + 5);
          receivingData = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) {
          return;
        }
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        commands.push(line);

        if (line.startsWith("EHLO ")) {
          socket.write("250-fake.smtp.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        } else if (line.startsWith("AUTH PLAIN ")) {
          socket.write("235 2.7.0 authenticated\r\n");
        } else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) {
          socket.write("250 2.1.0 ok\r\n");
        } else if (line === "DATA") {
          receivingData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (line === "QUIT") {
          socket.write("221 2.0.0 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });

  return {
    commands,
    get message() {
      return message;
    },
    get port() {
      return port;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          assert.ok(address && typeof address === "object");
          port = address.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function fakeOpenAiInput(taskId) {
  return {
    taskId,
    prompt: "A premium studio portrait",
    style: "realistic",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "standard"
  };
}

function createFakeOpenAiServer(responses) {
  const requests = [];
  let port = 0;
  const server = createServer((request, response) => {
    const next = responses.shift();
    assert.ok(next, "Unexpected OpenAI request");
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", async () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      if (next.delayMs) {
        await sleep(next.delayMs);
      }
      response.statusCode = next.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(next.body));
    });
  });

  return {
    requests,
    get port() {
      return port;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          assert.ok(address && typeof address === "object");
          port = address.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function createFakeSafetyServer(responses) {
  const requests = [];
  let port = 0;
  const server = createServer((request, response) => {
    const next = responses.shift();
    assert.ok(next, "Unexpected safety provider request");
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.statusCode = next.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(next.body));
    });
  });

  return {
    requests,
    get port() {
      return port;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          assert.ok(address && typeof address === "object");
          port = address.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
