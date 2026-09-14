import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAiImageGenerationProvider,
  createChannelHealthStore,
  getImageModelCatalog,
  listSupportedModels,
  quoteImageGeneration,
  readImageModelConfigs,
  resolveDefaultImageModel,
  resolveDefaultImageProvider,
  resolveImageChannels,
  resolveProviderModel
} from "../packages/ai-providers/dist/index.js";
import { createGenerationRuntime } from "../apps/api/dist/generation-runtime.js";

const imageBytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const channels = [
  { name: "gpt-primary", baseUrl: "https://gpt-primary.example/v1", apiKey: "test-gpt-secret", priority: 0 },
  {
    name: "grok",
    baseUrl: "https://grok.example/v1",
    apiKey: "test-grok-secret",
    priority: 1,
    upstreamModel: "wrong-legacy-model",
    costCentsPerImage: 999
  },
  { name: "gpt-backup", baseUrl: "https://gpt-backup.example/v1", apiKey: "test-backup-secret", priority: 2 },
  { name: "offline", baseUrl: "https://offline.example/v1", apiKey: "test-offline-secret", enabled: false }
];
const models = [
  {
    id: "openai:gpt-image-2",
    label: "GPT Image 2",
    upstreamModel: "gpt-image-2",
    apiFormat: "gpt-image",
    channels: ["gpt-primary", { name: "gpt-backup", upstreamModel: "gpt-image-2-backup", costCentsPerImage: 6 }],
    creditsPerImage: 7,
    costCentsPerImage: 4
  },
  {
    id: "xai:grok-imagine-image",
    label: "Grok Imagine",
    upstreamModel: "grok-imagine-image",
    apiFormat: "grok-image",
    channels: ["grok"],
    creditsPerImage: 3,
    costCentsPerImage: 2,
    maxQuantity: 2
  },
  {
    id: "custom:disabled",
    label: "Disabled",
    upstreamModel: "disabled",
    apiFormat: "openai-images",
    channels: ["grok"],
    creditsPerImage: 1,
    costCentsPerImage: 0,
    enabled: false
  },
  {
    id: "custom:offline",
    label: "Offline",
    upstreamModel: "offline",
    apiFormat: "openai-images",
    channels: ["offline"],
    creditsPerImage: 1,
    costCentsPerImage: 0
  }
];
const input = {
  taskId: "multi-model-test",
  prompt: "a calm harbour at dawn",
  style: "realistic",
  aspectRatio: "1:1",
  width: 1024,
  height: 1024,
  quantity: 1,
  quality: "standard"
};

async function withConfig(callback, overrides = {}) {
  const values = {
    AI_PROVIDER: "openai",
    IMAGE_PROVIDER_DEFAULT: undefined,
    OPENAI_API_KEY: undefined,
    IMAGE_MODEL_DEFAULT: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    OPENAI_MAX_RETRIES: "0",
    IMAGE_CHANNELS: JSON.stringify(channels),
    IMAGE_MODELS: JSON.stringify(models),
    ...overrides
  };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withGateway(
  callback,
  respond = () =>
    new Response(JSON.stringify({ data: [{ b64_json: imageBytes }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), body: JSON.parse(options.body), authorization: options.headers.Authorization };
    calls.push(call);
    return respond(call);
  };
  try {
    await callback(provider, calls);
  } finally {
    globalThis.fetch = originalFetch;
    await provider.close();
  }
}

test("model catalog lists only enabled routable models and never exposes channel configuration", async () => {
  await withConfig(() => {
    const catalog = getImageModelCatalog();
    assert.equal(catalog.defaultModel, "openai:gpt-image-2");
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ["openai:gpt-image-2", "xai:grok-imagine-image"]
    );
    assert.deepEqual(catalog.models[1].qualities, ["standard"]);
    assert.equal(catalog.models[1].maxQuantity, 2);
    assert.doesNotMatch(JSON.stringify(catalog), /secret|example|apiKey|channels|costCents|upstreamModel/);
    assert.ok(listSupportedModels("openai").includes("xai:grok-imagine-image"));
  });
});

test("configured channels select the compatible provider without a legacy API key", async () => {
  await withConfig(() => assert.equal(resolveDefaultImageProvider(), "openai"), { AI_PROVIDER: undefined });
});

test("channel credentials can be referenced by environment name without embedding secrets in JSON", () => {
  const configured = JSON.stringify([
    { name: "referenced", baseUrl: "https://example.com/v1", apiKeyEnv: "IMAGE_TEST_KEY" }
  ]);
  assert.equal(
    resolveImageChannels({ IMAGE_CHANNELS: configured, IMAGE_TEST_KEY: "private-test-key" })[0].apiKey,
    "private-test-key"
  );
  assert.throws(() => resolveImageChannels({ IMAGE_CHANNELS: configured }), /apiKey is required/);
  assert.throws(
    () =>
      resolveImageChannels({
        IMAGE_CHANNELS: JSON.stringify([{ ...channels[0], apiKeyEnv: "IMAGE_TEST_KEY" }]),
        IMAGE_TEST_KEY: "private-test-key"
      }),
    /not both/
  );
});

test("explicit defaults and namespaced models resolve without aliasing Grok to GPT", async () => {
  await withConfig(
    () => {
      assert.equal(resolveDefaultImageModel(), "xai:grok-imagine-image");
      assert.equal(resolveProviderModel("xai:grok-imagine-image"), "xai:grok-imagine-image");
      assert.equal(resolveProviderModel("gpt-image-2"), "openai:gpt-image-2");
      assert.throws(() => resolveProviderModel("xai:unknown"), /Unsupported image model/);
    },
    { IMAGE_MODEL_DEFAULT: "xai:grok-imagine-image" }
  );
});

test("model configuration rejects invalid JSON, duplicate ids and unsafe or unsupported fields", async () => {
  await withConfig(() => {
    const env = { IMAGE_CHANNELS: JSON.stringify(channels) };
    assert.throws(
      () => readImageModelConfigs({ ...env, IMAGE_MODELS: '{"secret-token"' }),
      (error) => {
        assert.doesNotMatch(error.message, /secret-token/);
        return /valid JSON/.test(error.message);
      }
    );
    assert.throws(() => readImageModelConfigs({ ...env, IMAGE_MODELS: "{}" }), /JSON array/);
    for (const replacement of [
      { id: "unnamespaced" },
      { id: "mock:custom" },
      { enabled: "false" },
      { apiFormat: "chat-completions" },
      { channels: [] },
      { channels: ["missing"] },
      { channels: ["grok", "grok"] },
      { creditsPerImage: 0 },
      { creditsPerImage: -1 },
      { costCentsPerImage: -1 },
      { maxQuantity: 5 },
      { maxQuantity: 1.5 },
      { qualities: ["high"] },
      { aspectRatios: ["2:1"] }
    ]) {
      assert.throws(() =>
        readImageModelConfigs({ ...env, IMAGE_MODELS: JSON.stringify([{ ...models[1], ...replacement }]) })
      );
    }
    assert.throws(
      () => readImageModelConfigs({ ...env, IMAGE_MODELS: JSON.stringify([models[0], models[0]]) }),
      /duplicate model/
    );
  });
});

test("an empty explicit model catalog never falls back to legacy GPT routing", async () => {
  await withConfig(
    () => {
      assert.deepEqual(getImageModelCatalog(), { models: [], defaultModel: null });
      assert.throws(() => resolveProviderModel("gpt-image-2"), /Unsupported image model/);
    },
    { IMAGE_MODELS: "[]" }
  );
});

test("model quotes enforce individual pricing and supported capabilities", async () => {
  await withConfig(() => {
    assert.equal(quoteImageGeneration({ ...input, model: models[0].id }).creditCost, 7);
    const grokQuote = quoteImageGeneration({ ...input, model: models[1].id, quantity: 2, aspectRatio: "16:9" });
    assert.equal(grokQuote.creditCost, 6);
    assert.equal(grokQuote.providerCostCents, 4);
    assert.throws(() => quoteImageGeneration({ ...input, model: models[1].id, quality: "high" }), /画质/);
    assert.throws(() => quoteImageGeneration({ ...input, model: models[1].id, quantity: 3 }), /最多生成 2/);
    assert.throws(() => quoteImageGeneration({ ...input, model: models[2].id }), /does not support/);
    assert.throws(() => quoteImageGeneration({ ...input, model: models[3].id }), /暂无可用/);
  });
});

test("overflowing model prices are rejected before credit accounting", async () => {
  await withConfig(
    () => {
      assert.throws(() => quoteImageGeneration({ ...input, model: models[1].id, quantity: 2 }), /计费配置无效/);
    },
    { IMAGE_MODELS: JSON.stringify([{ ...models[1], creditsPerImage: Number.MAX_VALUE }]) }
  );
});

test("API resolves the selected model and rejects unavailable choices before charging", async () => {
  await withConfig(() => {
    const runtime = createGenerationRuntime({ enqueueTask: async () => ({ enqueued: true }) });
    const selection = runtime.resolveGenerationProviderSelection(models[1].id);
    assert.equal(selection.model, models[1].id);
    assert.equal(selection.providerMetadata.modelName, models[1].id);
    assert.equal(runtime.quote({ ...input, model: models[1].id }), 3);
    for (const request of [
      { model: "xai:unknown" },
      { model: models[2].id },
      { model: models[3].id },
      { model: models[1].id, quality: "high" }
    ]) {
      assert.throws(
        () => runtime.quote({ ...input, ...request }),
        (error) => error.code === "VALIDATION_ERROR" && error.statusCode === 400
      );
    }
  });
});

test("multi-model requests cannot silently fall back to Mock", async () => {
  await withConfig(
    () => {
      const runtime = createGenerationRuntime({ enqueueTask: async () => ({ enqueued: true }) });
      assert.deepEqual(
        getImageModelCatalog().models.map((model) => model.id),
        ["mock:default"]
      );
      assert.throws(
        () => runtime.resolveGenerationProviderSelection(models[1].id),
        (error) => error.code === "VALIDATION_ERROR"
      );
      assert.throws(
        () => runtime.resolveGenerationProviderSelection(models[0].id),
        (error) => error.code === "VALIDATION_ERROR"
      );
    },
    { AI_PROVIDER: "mock" }
  );
});

test("Grok routes only to its bound API and omits GPT-only request parameters", async () => {
  await withConfig(() =>
    withGateway(async (provider, calls) => {
      const result = await provider.generateImage({ ...input, model: models[1].id, aspectRatio: "16:9", quantity: 2 });
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.url, "https://grok.example/v1/images/generations");
        assert.equal(call.authorization, "Bearer test-grok-secret");
        assert.equal(call.body.model, "grok-imagine-image");
        assert.equal(call.body.aspect_ratio, "16:9");
        assert.equal(call.body.n, 1);
        assert.equal(call.body.response_format, "b64_json");
        assert.equal(call.body.quality, undefined);
        assert.equal(call.body.size, undefined);
        assert.equal(call.body.output_format, undefined);
      }
      assert.deepEqual(result.channels, ["grok", "grok"]);
      assert.equal(result.providerCostCents, 4);
    })
  );
});

test("GPT failover is restricted to GPT bindings and uses the backup's exact model alias", async () => {
  await withConfig(() =>
    withGateway(
      async (provider, calls) => {
        const result = await provider.generateImage({ ...input, model: models[0].id });
        assert.deepEqual(
          calls.map((call) => call.body.model),
          ["gpt-image-2", "gpt-image-2-backup"]
        );
        assert.deepEqual(
          calls.map((call) => new URL(call.url).host),
          ["gpt-primary.example", "gpt-backup.example"]
        );
        assert.equal(calls[0].body.size, "1024x1024");
        assert.equal(calls[0].body.quality, "medium");
        assert.equal(calls[0].body.output_format, "png");
        assert.equal(calls[0].body.aspect_ratio, undefined);
        assert.equal(calls[1].authorization, "Bearer test-backup-secret");
        assert.deepEqual(result.channels, ["gpt-backup"]);
        assert.equal(result.providerCostCents, 6);
      },
      (call) =>
        new URL(call.url).host === "gpt-primary.example"
          ? new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 500 })
          : new Response(JSON.stringify({ data: [{ b64_json: imageBytes }] }), { status: 200 })
    )
  );
});

test("a failed Grok request never falls back to a different model", async () => {
  await withConfig(() =>
    withGateway(
      async (provider, calls) => {
        await assert.rejects(provider.generateImage({ ...input, model: models[1].id }));
        assert.deepEqual(
          calls.map((call) => new URL(call.url).host),
          ["grok.example"]
        );
      },
      () => new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 503 })
    )
  );
});

test("unknown, disabled or unsupported choices never issue an upstream request", async () => {
  await withConfig(() =>
    withGateway(async (provider, calls) => {
      for (const request of [
        { model: "xai:unknown" },
        { model: models[2].id },
        { model: models[3].id },
        { model: models[1].id, quality: "high" }
      ]) {
        await assert.rejects(provider.generateImage({ ...input, ...request }));
      }
      assert.equal(calls.length, 0);
    })
  );
});

test("generic OpenAI-compatible image models use the minimal image request contract", async () => {
  const generic = { ...models[1], id: "custom:image-model", apiFormat: "openai-images", upstreamModel: "image-model" };
  await withConfig(
    () =>
      withGateway(async (provider, calls) => {
        await provider.generateImage({ ...input, model: generic.id });
        assert.equal(calls[0].body.model, "image-model");
        assert.equal(calls[0].body.size, "1024x1024");
        assert.equal(calls[0].body.quality, undefined);
        assert.equal(calls[0].body.output_format, undefined);
        assert.equal(calls[0].body.aspect_ratio, undefined);
      }),
    { IMAGE_MODELS: JSON.stringify([generic]) }
  );
});

test("legacy single-model configurations preserve existing quote and channel behavior", async () => {
  await withConfig(
    () => {
      assert.equal(resolveImageChannels().length, 3);
      assert.equal(resolveDefaultImageModel(), "openai:gpt-image-2");
      assert.deepEqual(
        getImageModelCatalog().models.map((model) => model.id),
        ["openai:gpt-image-2"]
      );
      assert.equal(quoteImageGeneration({ ...input, quality: "high", aspectRatio: "16:9" }).creditCost, 15);
    },
    { IMAGE_MODELS: undefined }
  );
});
