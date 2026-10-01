import assert from "node:assert/strict";
import test from "node:test";
import { aspectRatios, aspectRatioDimensions } from "../packages/shared/dist/image-models.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImageModelDiscovery,
  OpenAiImageGenerationProvider,
  createChannelHealthStore,
  createImageGenerationSnapshot,
  getImageModelCatalog,
  parseImageModelDirectory,
  publishImageModelConfigs,
  quoteImageGeneration,
  readImageModelConfigs
} from "../packages/ai-providers/dist/index.js";

const ids = [
  "Nano Banana 2",
  "Nano Banana 2 Lite",
  "Nano Banana Pro",
  "gpt-image-2",
  "gpt-image-2-4k",
  "grok-imagine-image-2.0",
  "grok-imagine-image-pro"
];
const directory = (names) => ({
  data: names.map((id) => ({
    id,
    supported_endpoint_types: ["image-generation", "openai"],
    ...(id === "gpt-image-2-4k" ? { supported_aspect_ratios: [...aspectRatios] } : {}),
    ...(id === "Backup Image Model" ? { supported_aspect_ratios: ["1:1"] } : {})
  }))
});
const channels = [
  { name: "old-grok", baseUrl: "https://old-grok.example/v1", apiKey: "secret-grok", priority: 0 },
  { name: "primary", baseUrl: "https://primary.example/v1", apiKey: "secret-primary", priority: 1 },
  { name: "backup", baseUrl: "https://backup.example/v1", apiKey: "secret-backup", priority: 2 }
];
const overrides = [
  {
    id: "xai:grok-imagine-image",
    label: "Grok",
    upstreamModel: "grok-imagine-image",
    apiFormat: "grok-image",
    channels: ["old-grok"],
    creditsPerImage: 3,
    costCentsPerImage: 2
  },
  {
    id: "openai:gpt-image-2",
    label: "GPT Image 2",
    upstreamModel: "gpt-image-2",
    apiFormat: "gpt-image",
    channels: ["primary", { name: "backup", upstreamModel: "same-gpt-alias", costCentsPerImage: 6 }],
    creditsPerImage: 7,
    costCentsPerImage: 4
  }
];
const input = {
  taskId: "discovery-task",
  prompt: "a quiet coast at dawn",
  style: "realistic",
  quality: "standard",
  quantity: 1,
  aspectRatio: "1:1",
  width: 1024,
  height: 1024
};
const imageBytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function configure(t, extra = {}) {
  const env = {
    AI_PROVIDER: "openai",
    IMAGE_PROVIDER_DEFAULT: "openai",
    IMAGE_MODEL_DEFAULT: "xai:grok-imagine-image",
    OPENAI_IMAGE_MODEL: undefined,
    IMAGE_CHANNELS: JSON.stringify(channels),
    IMAGE_MODELS: JSON.stringify(overrides),
    IMAGE_MODEL_DISCOVERY: "true",
    IMAGE_MODEL_DISCOVERY_CHANNEL: undefined,
    OPENAI_MAX_RETRIES: "0",
    IMAGE_CHANNEL_FAILOVER_ON_TIMEOUT: "false",
    ...extra
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    publishImageModelConfigs(undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function discovery(t, options = {}) {
  const service = new ImageModelDiscovery({
    fetch: async (url) =>
      new URL(url).hostname === "primary.example" ? response(directory(ids)) : response({ error: "maintenance" }, 503),
    ...options
  });
  t.after(() => service.close());
  return service;
}

test("自动目录保留全部七个精确型号，主线路优先且旧默认安全回落", async (t) => {
  configure(t);
  const service = discovery(t);
  await service.refresh();
  const models = readImageModelConfigs().filter((model) => model.provider === "openai");
  assert.deepEqual(
    models.map((model) => model.upstreamModel),
    ids
  );
  assert.equal(getImageModelCatalog().defaultModel, "openai:gpt-image-2");
  assert.equal(service.status().primaryChannel, "primary");
  assert.ok(models.every((model) => model.channels[0].name === "primary"));
  assert.deepEqual(
    models.find((model) => model.upstreamModel === "gpt-image-2").channels.map((channel) => channel.name),
    ["primary", "backup"]
  );
  assert.ok(
    models.filter((model) => model.upstreamModel !== "gpt-image-2").every((model) => model.channels.length === 1)
  );
  assert.doesNotMatch(JSON.stringify(getImageModelCatalog()), /secret|example|apiKey|channels|costCents|upstreamModel/);
  assert.equal(quoteImageGeneration({ ...input, model: "xai:grok-imagine-image-pro" }).creditCost, 3);
  assert.equal(quoteImageGeneration({ ...input, model: models[0].modelId }).creditCost, 7);
});

test("GPT 4K 在三种画质全部比例四种张数下均为原积分精确两倍，成本不翻倍", async (t) => {
  configure(t);
  await discovery(t).refresh();
  for (const quality of ["draft", "standard", "high"]) {
    for (const aspectRatio of aspectRatios) {
      for (let quantity = 1; quantity <= 4; quantity++) {
        const plain = quoteImageGeneration({ ...input, quality, aspectRatio, quantity, model: "openai:gpt-image-2" });
        const fourK = quoteImageGeneration({
          ...input,
          quality,
          aspectRatio,
          quantity,
          model: "openai:gpt-image-2-4k"
        });
        assert.equal(fourK.creditCost, plain.creditCost * 2);
        assert.equal(fourK.providerCostCents, plain.providerCostCents);
        assert.equal(Math.max(fourK.width, fourK.height), 4096);
      }
    }
  }
});

test("目录更新自动增加型号并保持稳定 ID；维护页、超时或坏 JSON 保留成功目录", async (t) => {
  configure(t);
  let mode = "ok";
  const service = discovery(t, {
    fetch: async (url) => {
      if (new URL(url).hostname !== "primary.example") return response({}, 503);
      if (mode === "html") return new Response("<html>Maintenance</html>");
      if (mode === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (mode === "bad") return response({ data: [{ id: null }] });
      return response(directory(mode === "new" ? [...ids].reverse().concat(["New Image Model"]) : ids));
    }
  });
  await service.refresh();
  const original = getImageModelCatalog();
  for (mode of ["html", "timeout", "bad"]) {
    await service.refresh();
    assert.deepEqual(getImageModelCatalog(), original);
    assert.ok(service.status().channels.find((channel) => channel.name === "primary").error);
  }
  mode = "new";
  await service.refresh();
  assert.equal(getImageModelCatalog().models.length, 8);
  for (const item of original.models) {
    assert.equal(getImageModelCatalog().models.find((x) => x.label === item.label)?.id, item.id);
  }
});

test("只接受生成能力，识图模型和非 Images 协议目录不会被误判为生图", () => {
  assert.deepEqual(
    parseImageModelDirectory({
      data: [
        { id: "gpt-image-2", supported_endpoint_types: ["openai"] },
        { id: "grok-imagine-image-pro", supported_endpoint_types: ["image-edits"] },
        { id: "chat", supported_endpoint_types: ["openai"] },
        { id: "Custom Model", supported_endpoint_types: ["image-generation"] }
      ]
    }).map((model) => model.id),
    ["Custom Model"]
  );
  assert.throws(() => parseImageModelDirectory("<html>maintenance</html>"));
});

test("成功目录可跨重启恢复，缓存中不含密钥，换 API 后不复用旧目录", async (t) => {
  configure(t);
  const dir = await mkdtemp(join(tmpdir(), "imagora-model-cache-"));
  const path = join(dir, "catalog.json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = discovery(t, { cachePath: path });
  await first.start();
  const original = getImageModelCatalog();
  await first.close();
  assert.doesNotMatch(await readFile(path, "utf8"), /secret-|apiKey|https/);
  publishImageModelConfigs(undefined);
  const restored = discovery(t, { cachePath: path, fetch: async () => response({}, 503) });
  await restored.start();
  assert.deepEqual(getImageModelCatalog(), original);
  await restored.close();
  process.env.IMAGE_CHANNELS = JSON.stringify(
    channels.map((channel) =>
      channel.name === "primary" ? { ...channel, apiKey: "rotated-key", baseUrl: "https://new.example/v1" } : channel
    )
  );
  publishImageModelConfigs(undefined);
  const moved = discovery(t, { cachePath: path, fetch: async () => response({}, 503) });
  await moved.start();
  assert.equal(moved.status().updatedAt, null);
  assert.equal(
    getImageModelCatalog().models.some((model) => model.id === "openai:gpt-image-2-4k"),
    false
  );
});

test("任务快照固定型号、4K 参数和价格，刷新后 Worker 仍发送原型号且不串备用", async (t) => {
  configure(t);
  await discovery(t).refresh();
  const model = "openai:gpt-image-2-4k";
  const snapshot = createImageGenerationSnapshot(model);
  const originalQuote = quoteImageGeneration({ ...input, model, modelSnapshot: snapshot });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-|apiKey/);
  publishImageModelConfigs(undefined);
  process.env.IMAGE_MODELS = JSON.stringify(overrides.map((entry) => ({ ...entry, creditsPerImage: 99 })));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return response({ data: [{ b64_json: imageBytes }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  t.after(() => provider.close());
  await provider.generateImage({ ...input, model, modelSnapshot: snapshot });
  assert.equal(calls[0].body.model, "gpt-image-2-4k");
  assert.equal(calls[0].body.size, "4096x4096");
  assert.equal(calls[0].body.quality, "medium");
  assert.equal(calls.length, 1);
  assert.deepEqual(quoteImageGeneration({ ...input, model, modelSnapshot: snapshot }), originalQuote);
  await assert.rejects(
    provider.generateImage({ ...input, model: "openai:gpt-image-2", modelSnapshot: snapshot }),
    /不一致/
  );
});

test("Banana 保留空格及大小写，Grok 使用比例参数；只有同型号能够故障切换", async (t) => {
  configure(t);
  await discovery(t).refresh();
  const originalFetch = globalThis.fetch;
  const calls = [];
  let failing = false;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return failing && new URL(url).hostname === "primary.example"
      ? response({}, 503)
      : response({ data: [{ b64_json: imageBytes }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  t.after(() => provider.close());
  const banana = readImageModelConfigs().find((model) => model.upstreamModel === "Nano Banana 2");
  await provider.generateImage({ ...input, model: banana.modelId });
  assert.equal(calls[0].body.model, "Nano Banana 2");
  assert.equal(calls[0].body.quality, undefined);
  assert.equal(calls[0].body.output_format, undefined);
  await provider.generateImage({ ...input, model: "xai:grok-imagine-image-pro", aspectRatio: "16:9" });
  assert.equal(calls[1].body.aspect_ratio, "16:9");
  assert.equal(calls[1].body.size, undefined);
  failing = true;
  calls.length = 0;
  await provider.generateImage({ ...input, model: "openai:gpt-image-2" });
  assert.deepEqual(
    calls.map((call) => call.body.model),
    ["gpt-image-2", "same-gpt-alias"]
  );
  calls.length = 0;
  await assert.rejects(provider.generateImage({ ...input, model: "openai:gpt-image-2-4k" }));
  assert.deepEqual(
    calls.map((call) => call.body.model),
    ["gpt-image-2-4k"]
  );
});

test("同一轮同步并发请求去重，关闭发现后不继续展示旧动态目录", async (t) => {
  configure(t);
  let calls = 0;
  const service = discovery(t, {
    fetch: async () => {
      calls++;
      return response(directory(ids));
    }
  });
  const first = service.refresh();
  assert.equal(first, service.refresh());
  await first;
  assert.equal(calls, 3);
  process.env.IMAGE_MODEL_DISCOVERY = "false";
  await service.refresh();
  assert.equal(service.status().enabled, false);
  assert.equal(
    getImageModelCatalog().models.some((model) => model.id === "openai:gpt-image-2-4k"),
    false
  );
});

test("按 API 独立列出目录，备用别名沿用价格和协议且不能改变默认目录", async (t) => {
  configure(t);
  const service = discovery(t, {
    fetch: async (url) =>
      response(
        directory(
          new URL(url).hostname === "primary.example"
            ? ids
            : new URL(url).hostname === "backup.example"
              ? ["same-gpt-alias", "Backup Image Model"]
              : []
        )
      )
  });
  await service.refresh();
  const defaultCatalog = getImageModelCatalog();
  const main = service.catalog();
  const backup = service.catalog("backup");
  assert.equal(main.channel, "primary");
  assert.equal(main.models.length, 7);
  assert.deepEqual(
    backup.models.map((model) => model.label),
    ["GPT Image 2", "Backup Image Model"]
  );
  assert.equal(backup.defaultModel, "openai:gpt-image-2");
  assert.deepEqual(
    backup.channels.map((channel) => channel.id),
    ["primary", "old-grok", "backup"]
  );
  assert.doesNotMatch(JSON.stringify(backup), /secret-|https|apiKey|costCents|upstreamModel/);
  const snapshot = service.snapshot("backup", "openai:gpt-image-2");
  assert.equal(snapshot.model.apiFormat, "gpt-image");
  assert.equal(snapshot.model.primaryChannel, "backup");
  assert.deepEqual(
    snapshot.channels.map((channel) => channel.name),
    ["backup"]
  );
  assert.equal(snapshot.channels[0].upstreamModel, "same-gpt-alias");
  assert.equal(quoteImageGeneration({ ...input, model: "openai:gpt-image-2", modelSnapshot: snapshot }).creditCost, 7);
  assert.throws(() => service.snapshot("backup", "openai:gpt-image-2-4k"), /不支持/);
  assert.throws(() => service.catalog("missing"), /不存在/);
  assert.deepEqual(service.catalog(), main);
  assert.deepEqual(getImageModelCatalog(), defaultCatalog);
  process.env.IMAGE_CHANNELS = JSON.stringify(
    channels.map((channel) => ({ ...channel, enabled: channel.name !== "backup" }))
  );
  assert.throws(() => service.snapshot("backup", "openai:gpt-image-2"), /已停用/);
});

test("备用维护时不混入主目录，有缓存只保留该线路缓存，凭据变化立即失效", async (t) => {
  configure(t);
  let available = false;
  const service = discovery(t, {
    fetch: async (url) =>
      new URL(url).hostname === "primary.example"
        ? response(directory(ids))
        : available
          ? response(directory(["Backup Image Model"]))
          : new Response("<html>Maintenance</html>")
  });
  await service.refresh();
  assert.deepEqual(service.catalog("backup").models, []);
  assert.match(service.catalog("backup").error, /非 JSON/);
  assert.throws(() => service.snapshot("backup"), /暂不可用/);
  available = true;
  await service.refresh();
  const cached = service.catalog("backup").models;
  assert.equal(cached.length, 1);
  available = false;
  await service.refresh();
  assert.deepEqual(service.catalog("backup").models, cached);
  process.env.IMAGE_CHANNELS = JSON.stringify(
    channels.map((channel) => (channel.name === "backup" ? { ...channel, apiKey: "changed" } : channel))
  );
  assert.deepEqual(service.catalog("backup").models, []);
  assert.equal(service.catalog().models.length, 7);
});

test("显式备用任务仅请求所选 API，失败也不会改走主线路", async (t) => {
  configure(t);
  const service = discovery(t, {
    fetch: async (url) =>
      response(directory(new URL(url).hostname === "primary.example" ? ids : ["same-gpt-alias", "Backup Image Model"]))
  });
  await service.refresh();
  const model = service.catalog("backup").models.find((entry) => entry.label === "Backup Image Model").id;
  const snapshot = service.snapshot("backup", model);
  const calls = [];
  let failing = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return failing ? response({}, 503) : response({ data: [{ b64_json: imageBytes }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  t.after(() => provider.close());
  await provider.generateImage({ ...input, model, modelSnapshot: snapshot });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "Backup Image Model");
  assert.equal(new URL(calls[0].url).hostname, "backup.example");
  failing = true;
  calls.length = 0;
  await assert.rejects(provider.generateImage({ ...input, model, modelSnapshot: snapshot }));
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, "backup.example");
});

test("新增比例传入真实请求尺寸，4K 正确缩放且无预设不附加风格或负向提示词", async (t) => {
  configure(t);
  await discovery(t).refresh();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return response({ data: [{ b64_json: imageBytes }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  t.after(() => provider.close());
  const ratios = [...aspectRatios];
  const models = [
    "openai:gpt-image-2",
    "openai:gpt-image-2-4k",
    "xai:grok-imagine-image-pro",
    readImageModelConfigs().find((model) => model.upstreamModel === "Nano Banana 2").modelId
  ];
  for (const model of models) {
    for (const aspectRatio of ratios) {
      const request = { ...input, model, style: "none", aspectRatio };
      const supported = readImageModelConfigs().find((entry) => entry.modelId === model).aspectRatios;
      if (!supported.includes(aspectRatio)) {
        const requestCount = calls.length;
        assert.throws(() => quoteImageGeneration(request), /比例/);
        await assert.rejects(provider.generateImage(request), /比例/);
        assert.equal(calls.length, requestCount);
        continue;
      }
      const quote = quoteImageGeneration(request);
      const result = await provider.generateImage({ ...request, width: quote.width, height: quote.height });
      const body = calls.at(-1);
      assert.doesNotMatch(body.prompt, /Style:|Avoid:/);
      assert.ok(body.prompt.startsWith(input.prompt));
      assert.ok(body.prompt.includes("Aspect ratio: " + aspectRatio));
      assert.equal(result.providerCostCents, quote.providerCostCents);
      if (model.startsWith("xai:")) {
        assert.equal(body.aspect_ratio, aspectRatio);
        assert.equal(body.size, undefined);
      } else {
        assert.equal(body.size, quote.width + "x" + quote.height);
      }
      if (model.includes("4k")) {
        assert.equal(Math.max(quote.width, quote.height), 4096);
        assert.equal(quote.width % 16, 0);
        assert.equal(quote.height % 16, 0);
        assert.equal(quote.creditCost, aspectRatio === "1:1" ? 14 : 18);
      } else {
        assert.deepEqual({ width: quote.width, height: quote.height }, aspectRatioDimensions[aspectRatio]);
      }
    }
  }
});

test("已列出及新发现的模型统一开放全部预设比例，不继承旧配置限制", async (t) => {
  configure(t, {
    IMAGE_MODELS: JSON.stringify(
      overrides.map((model) => ({
        ...model,
        aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"]
      }))
    )
  });
  const service = discovery(t, {
    fetch: async () => response(directory([...ids, "gpt-image-99", "Nano Banana Future"]))
  });
  await service.refresh();
  const models = readImageModelConfigs();
  const find = (name) => models.find((model) => model.upstreamModel === name);
  assert.deepEqual(find("gpt-image-2").aspectRatios, [...aspectRatios]);
  for (const name of ["Nano Banana 2", "Nano Banana 2 Lite", "Nano Banana Pro"]) {
    assert.deepEqual(find(name).aspectRatios, [...aspectRatios]);
    assert.equal(find(name).aspectRatioSource, "configured");
  }
  for (const name of ["grok-imagine-image-2.0", "grok-imagine-image-pro"]) {
    assert.deepEqual(find(name).aspectRatios, [...aspectRatios]);
  }
  for (const name of ["gpt-image-99", "Nano Banana Future"]) {
    assert.deepEqual(find(name).aspectRatios, [...aspectRatios]);
    assert.equal(find(name).aspectRatioSource, "configured");
    for (const aspectRatio of aspectRatios) {
      assert.ok(quoteImageGeneration({ ...input, model: find(name).modelId, aspectRatio }).creditCost > 0);
    }
  }
});

test("上游比例元数据继续校验，但各线路统一使用全部预设比例", async (t) => {
  configure(t);
  let invalid = false;
  const service = discovery(t, {
    fetch: async (url) =>
      response({
        data: [
          {
            id: "gpt-image-2",
            supported_endpoint_types: ["image-generation"],
            supported_aspect_ratios: invalid
              ? "all"
              : new URL(url).hostname === "primary.example"
                ? ["1:1", "4:5"]
                : ["1:1"]
          }
        ]
      })
  });
  await service.refresh();
  assert.deepEqual(service.catalog("primary").models[0].aspectRatios, [...aspectRatios]);
  assert.deepEqual(service.catalog("backup").models[0].aspectRatios, [...aspectRatios]);
  assert.equal(service.catalog("primary").models[0].aspectRatioSource, "configured");
  invalid = true;
  await service.refresh();
  assert.deepEqual(service.catalog("primary").models[0].aspectRatios, [...aspectRatios]);
  assert.match(service.status().channels[0].error, /比例/);
  assert.deepEqual(
    parseImageModelDirectory({
      data: [
        {
          id: "custom-image",
          supported_aspect_ratios: ["7:5"]
        }
      ]
    })[0].supported_aspect_ratios,
    []
  );
  assert.deepEqual(
    parseImageModelDirectory({
      data: [
        {
          id: "custom-image",
          aspect_ratios: ["4:5", "4:5", "1:1"]
        }
      ]
    })[0].supported_aspect_ratios,
    ["1:1", "4:5"]
  );
});

test("同型号故障切换保留各线路及全部预设比例", async (t) => {
  configure(t);
  const service = discovery(t, {
    fetch: async (url) =>
      response({
        data: [
          {
            id: new URL(url).hostname === "backup.example" ? "same-gpt-alias" : "gpt-image-2",
            supported_endpoint_types: ["image-generation"],
            supported_aspect_ratios: new URL(url).hostname === "primary.example" ? ["1:1", "16:9"] : ["1:1"]
          }
        ]
      })
  });
  await service.refresh();
  const snapshot = service.snapshot("primary", "openai:gpt-image-2");
  assert.deepEqual(snapshot.channels.find((channel) => channel.name === "backup").aspectRatios, [...aspectRatios]);
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).hostname);
    return response({}, 503);
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  t.after(() => provider.close());
  await assert.rejects(
    provider.generateImage({ ...input, model: "openai:gpt-image-2", modelSnapshot: snapshot, aspectRatio: "16:9" })
  );
  assert.deepEqual(calls, ["primary.example", "old-grok.example", "backup.example"]);
  calls.length = 0;
  await assert.rejects(provider.generateImage({ ...input, model: "openai:gpt-image-2", modelSnapshot: snapshot }));
  assert.deepEqual(calls, ["primary.example", "old-grok.example", "backup.example"]);
});

test("已知 gpt-image-2-4k 即使上游未声明比例也开放全部支持比例", async (t) => {
  configure(t);
  const service = discovery(t, {
    fetch: async () => response({ data: [{ id: "gpt-image-2-4k", supported_endpoint_types: ["image-generation"] }] })
  });
  await service.refresh();
  assert.deepEqual(service.catalog().models[0].aspectRatios, [...aspectRatios]);
  assert.equal(service.catalog().models[0].aspectRatioSource, "configured");
});

test("所有生图模型的全部比例均可报价，并传入正确的上游参数", async (t) => {
  configure(t);
  const allIds = [...ids, "gpt-image-2.5", "gpt-image-2.5-4k", "future-image-model"];
  const service = discovery(t, { fetch: async () => response(directory(allIds)) });
  await service.refresh();
  const models = service.catalog().models;
  assert.equal(models.length, allIds.length);
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return response({ data: [{ b64_json: imageBytes }] });
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  const provider = new OpenAiImageGenerationProvider({ healthStore: createChannelHealthStore({ provider: "memory" }) });
  t.after(() => provider.close());
  for (const model of models) {
    assert.deepEqual(model.aspectRatios, [...aspectRatios]);
    const snapshot = service.snapshot("primary", model.id);
    assert.ok(
      snapshot.channels.every((channel) => JSON.stringify(channel.aspectRatios) === JSON.stringify(aspectRatios))
    );
    for (const aspectRatio of aspectRatios) {
      const request = { ...input, model: model.id, modelSnapshot: snapshot, aspectRatio };
      const quote = quoteImageGeneration(request);
      await provider.generateImage({ ...request, width: quote.width, height: quote.height });
      const body = calls.at(-1);
      assert.equal(body.model, snapshot.model.upstreamModel);
      assert.equal(body.n, 1);
      if (snapshot.model.apiFormat === "grok-image") {
        assert.equal(body.aspect_ratio, aspectRatio);
        assert.equal(body.size, undefined);
      } else {
        assert.equal(body.size, quote.width + "x" + quote.height);
      }
      if (model.resolution === "4k") {
        assert.equal(Math.max(quote.width, quote.height), 4096);
        assert.equal(quote.width % 16, 0);
        assert.equal(quote.height % 16, 0);
      } else {
        assert.deepEqual({ width: quote.width, height: quote.height }, aspectRatioDimensions[aspectRatio]);
      }
    }
  }
  assert.equal(calls.length, models.length * aspectRatios.length);
});
