import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  DEFAULT_CHANNEL_COOLDOWN_MS,
  DEFAULT_CHANNEL_FAILURE_THRESHOLD,
  OpenAiImageGenerationProvider,
  createChannelHealthStore,
  createResilientChannelHealthStore,
  hasConfiguredImageChannel,
  parseImageChannels,
  readChannelHealthSettings,
  resolveChannelHealthProvider,
  resolveImageChannels
} from "../packages/ai-providers/dist/index.js";

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const baseInput = {
  taskId: "task-1",
  prompt: "a calm harbour at dawn",
  style: "realistic",
  aspectRatio: "1:1",
  width: 1024,
  height: 1024,
  quantity: 1,
  quality: "standard"
};

test("parseImageChannels normalizes priority, enabled flag and rejects bad config", () => {
  const channels = parseImageChannels(
    JSON.stringify([
      { name: "slow", baseUrl: "https://b.example.com/v1/", apiKey: "sk-b", priority: 5 },
      { name: "fast", baseUrl: "https://a.example.com/v1", apiKey: "sk-a", priority: 1, costCentsPerImage: 7 },
      { name: "off", baseUrl: "https://c.example.com/v1", apiKey: "sk-c", enabled: false }
    ])
  );

  // parseImageChannels 只做解析校验，保留声明顺序；排序是 resolveImageChannels 的职责
  assert.deepEqual(
    channels.map((channel) => channel.name),
    ["slow", "fast", "off"]
  );
  // 尾部斜杠必须规范化掉，否则拼出 //images/generations
  assert.equal(channels.find((channel) => channel.name === "slow").baseUrl, "https://b.example.com/v1");
  assert.equal(channels.find((channel) => channel.name === "fast").costCentsPerImage, 7);
  assert.equal(channels.find((channel) => channel.name === "off").enabled, false);

  assert.throws(() => parseImageChannels("not json"), /must be valid JSON/);
  assert.throws(() => parseImageChannels('{"name":"a"}'), /must be a JSON array/);
  assert.throws(() => parseImageChannels('[{"baseUrl":"https://a.example.com","apiKey":"k"}]'), /name is required/);
  assert.throws(() => parseImageChannels('[{"name":"a","baseUrl":"https://a.example.com"}]'), /apiKey is required/);
  assert.throws(
    () => parseImageChannels('[{"name":"a","baseUrl":"http://relay.example.com","apiKey":"k"}]'),
    /must use https/
  );
  assert.throws(
    () =>
      parseImageChannels(
        '[{"name":"dup","baseUrl":"https://a.example.com","apiKey":"k"},{"name":"dup","baseUrl":"https://b.example.com","apiKey":"k"}]'
      ),
    /duplicate channel name/
  );
});

test("resolveImageChannels falls back to legacy single OPENAI_API_KEY config", () => {
  const previous = snapshotEnv(["IMAGE_CHANNELS", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  try {
    delete process.env.IMAGE_CHANNELS;
    process.env.OPENAI_API_KEY = "sk-legacy";
    process.env.OPENAI_BASE_URL = "https://relay.example.com/v1/";

    const channels = resolveImageChannels();
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, "default");
    assert.equal(channels[0].baseUrl, "https://relay.example.com/v1");
    assert.equal(channels[0].apiKey, "sk-legacy");
    assert.equal(hasConfiguredImageChannel(), true);

    delete process.env.OPENAI_API_KEY;
    assert.deepEqual(resolveImageChannels(), []);
    assert.equal(hasConfiguredImageChannel(), false);
  } finally {
    restoreEnv(previous);
  }
});

test("resolveImageChannels drops disabled channels and prefers IMAGE_CHANNELS over legacy key", () => {
  const previous = snapshotEnv(["IMAGE_CHANNELS", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  try {
    process.env.OPENAI_API_KEY = "sk-legacy";
    process.env.IMAGE_CHANNELS = JSON.stringify([
      { name: "primary", baseUrl: "https://a.example.com/v1", apiKey: "sk-a" },
      { name: "disabled", baseUrl: "https://b.example.com/v1", apiKey: "sk-b", enabled: false }
    ]);

    const channels = resolveImageChannels();
    assert.deepEqual(
      channels.map((channel) => channel.name),
      ["primary"]
    );
  } finally {
    restoreEnv(previous);
  }
});

test("channel health store trips after threshold failures and clears on success", async () => {
  const store = createChannelHealthStore({
    provider: "memory",
    settings: { failureThreshold: 2, cooldownMs: 60_000, failureWindowMs: 60_000 }
  });

  assert.equal(await store.isTripped("a"), false);
  assert.equal(await store.recordFailure("a"), false);
  assert.equal(await store.isTripped("a"), false);
  assert.equal(await store.recordFailure("a"), true);
  assert.equal(await store.isTripped("a"), true);

  await store.recordSuccess("a");
  assert.equal(await store.isTripped("a"), false);

  const snapshot = await store.snapshot(["a", "b"]);
  assert.deepEqual(snapshot, [
    { channel: "a", tripped: false, failures: 0 },
    { channel: "b", tripped: false, failures: 0 }
  ]);

  await store.close();
});

test("channel health cooldown expires so a recovered channel is retried", async () => {
  const store = createChannelHealthStore({
    provider: "memory",
    settings: { failureThreshold: 1, cooldownMs: 20, failureWindowMs: 60_000 }
  });

  assert.equal(await store.recordFailure("a"), true);
  assert.equal(await store.isTripped("a"), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await store.isTripped("a"), false);

  await store.close();
});

test("resilient health store keeps generation alive when the backing store fails", async () => {
  const broken = {
    provider: "redis",
    isTripped: async () => {
      throw new Error("redis down");
    },
    recordSuccess: async () => {
      throw new Error("redis down");
    },
    recordFailure: async () => {
      throw new Error("redis down");
    },
    snapshot: async () => {
      throw new Error("redis down");
    },
    close: async () => undefined
  };
  const errors = [];
  const store = createResilientChannelHealthStore(broken, (error, operation) => errors.push(operation));

  // 熔断只是优化项：存储挂了必须按「渠道可用」放行，不能让生图整体瘫掉
  assert.equal(await store.isTripped("a"), false);
  assert.equal(await store.recordFailure("a"), false);
  await store.recordSuccess("a");
  assert.deepEqual(await store.snapshot(["a"]), [{ channel: "a", tripped: false, failures: 0 }]);
  assert.deepEqual(errors, ["isTripped", "recordFailure", "recordSuccess", "snapshot"]);
});

test("channel health settings and provider read env overrides", () => {
  const previous = snapshotEnv([
    "IMAGE_CHANNEL_FAILURE_THRESHOLD",
    "IMAGE_CHANNEL_COOLDOWN_MS",
    "IMAGE_CHANNEL_FAILURE_WINDOW_MS",
    "IMAGE_CHANNEL_HEALTH_PROVIDER",
    "RUNTIME_STATE_PROVIDER"
  ]);
  try {
    const defaults = readChannelHealthSettings({});
    assert.equal(defaults.failureThreshold, DEFAULT_CHANNEL_FAILURE_THRESHOLD);
    assert.equal(defaults.cooldownMs, DEFAULT_CHANNEL_COOLDOWN_MS);

    const overridden = readChannelHealthSettings({
      IMAGE_CHANNEL_FAILURE_THRESHOLD: "5",
      IMAGE_CHANNEL_COOLDOWN_MS: "30000"
    });
    assert.equal(overridden.failureThreshold, 5);
    assert.equal(overridden.cooldownMs, 30_000);

    // 未单独配置时继承 RUNTIME_STATE_PROVIDER，避免两套开关打架
    assert.equal(resolveChannelHealthProvider({ RUNTIME_STATE_PROVIDER: "redis" }), "redis");
    assert.equal(resolveChannelHealthProvider({ IMAGE_CHANNEL_HEALTH_PROVIDER: "memory" }), "memory");
    assert.equal(resolveChannelHealthProvider({ NODE_ENV: "production" }), "redis");
    assert.throws(() => resolveChannelHealthProvider({ IMAGE_CHANNEL_HEALTH_PROVIDER: "sqlite" }), /must be memory/);
  } finally {
    restoreEnv(previous);
  }
});

test("provider fails over to the next channel when the first one returns 500", async () => {
  const failing = await startImageGateway(() => ({ status: 500, body: { error: { message: "upstream boom" } } }));
  const healthy = await startImageGateway(() => ({
    status: 200,
    body: { id: "req-ok", data: [{ b64_json: onePixelPngBase64 }] }
  }));

  try {
    const events = [];
    const provider = new OpenAiImageGenerationProvider({
      channels: [
        { name: "broken", baseUrl: failing.baseUrl, apiKey: "sk-broken", priority: 0, enabled: true },
        { name: "backup", baseUrl: healthy.baseUrl, apiKey: "sk-backup", priority: 1, enabled: true }
      ],
      healthStore: createChannelHealthStore({ provider: "memory" }),
      onChannelEvent: (event) => events.push(event)
    });

    const result = await provider.generateImage(baseInput);

    assert.equal(result.images.length, 1);
    assert.deepEqual(result.channels, ["backup"]);
    // 5xx 属于可重试错误：先在原渠道按 OPENAI_MAX_RETRIES 重试一次，仍失败才切渠道
    assert.equal(failing.requests.length, 2);
    assert.equal(healthy.requests.length, 1);
    assert.equal(healthy.requests[0].authorization, "Bearer sk-backup");

    const failed = events.find((event) => event.type === "channel_failed");
    assert.equal(failed.channel, "broken");
    assert.equal(failed.willFailover, true);

    await provider.close();
  } finally {
    await failing.close();
    await healthy.close();
  }
});

test("provider does not fail over on content block or client error", async () => {
  const blocking = await startImageGateway(() => ({
    status: 400,
    body: { error: { message: "blocked by policy", code: "content_policy_violation" } }
  }));
  const healthy = await startImageGateway(() => ({ status: 200, body: { data: [{ b64_json: onePixelPngBase64 }] } }));

  try {
    const provider = new OpenAiImageGenerationProvider({
      channels: [
        { name: "blocking", baseUrl: blocking.baseUrl, apiKey: "sk-a", priority: 0, enabled: true },
        { name: "backup", baseUrl: healthy.baseUrl, apiKey: "sk-b", priority: 1, enabled: true }
      ],
      healthStore: createChannelHealthStore({ provider: "memory" })
    });

    await assert.rejects(
      () => provider.generateImage(baseInput),
      (error) => {
        assert.equal(error.code, "PROVIDER_CONTENT_BLOCKED");
        return true;
      }
    );
    // 内容拦截换渠道一样被拦，不能浪费第二个站的额度
    assert.equal(healthy.requests.length, 0);

    await provider.close();
  } finally {
    await blocking.close();
    await healthy.close();
  }
});

test("provider keeps timeouts on the same channel but still records the failure", async () => {
  const stalling = await startImageGateway(() => ({ status: 200, body: {}, delayMs: 400 }));
  const healthy = await startImageGateway(() => ({ status: 200, body: { data: [{ b64_json: onePixelPngBase64 }] } }));

  const previous = snapshotEnv(["OPENAI_TIMEOUT_MS", "OPENAI_MAX_RETRIES"]);
  try {
    process.env.OPENAI_TIMEOUT_MS = "80";
    process.env.OPENAI_MAX_RETRIES = "0";

    const healthStore = createChannelHealthStore({
      provider: "memory",
      settings: { failureThreshold: 1, cooldownMs: 60_000, failureWindowMs: 60_000 }
    });
    const provider = new OpenAiImageGenerationProvider({
      channels: [
        { name: "stalling", baseUrl: stalling.baseUrl, apiKey: "sk-a", priority: 0, enabled: true },
        { name: "backup", baseUrl: healthy.baseUrl, apiKey: "sk-b", priority: 1, enabled: true }
      ],
      healthStore,
      failoverOnTimeout: false
    });

    await assert.rejects(
      () => provider.generateImage(baseInput),
      (error) => {
        assert.equal(error.code, "PROVIDER_TIMEOUT");
        return true;
      }
    );

    // 超时不换渠道重发（上游可能仍在出图，重发会双份计费）……
    assert.equal(healthy.requests.length, 0);
    // ……但必须计入熔断，后续任务才会自动绕开这个摆烂的渠道
    assert.equal(await healthStore.isTripped("stalling"), true);

    await provider.close();
  } finally {
    restoreEnv(previous);
    await stalling.close();
    await healthy.close();
  }
});

test("provider skips a tripped channel and reports per-channel cost", async () => {
  const primary = await startImageGateway(() => ({ status: 200, body: { data: [{ b64_json: onePixelPngBase64 }] } }));
  const backup = await startImageGateway(() => ({ status: 200, body: { data: [{ b64_json: onePixelPngBase64 }] } }));

  try {
    const healthStore = createChannelHealthStore({
      provider: "memory",
      settings: { failureThreshold: 1, cooldownMs: 60_000, failureWindowMs: 60_000 }
    });
    await healthStore.recordFailure("primary");

    const provider = new OpenAiImageGenerationProvider({
      channels: [
        { name: "primary", baseUrl: primary.baseUrl, apiKey: "sk-a", priority: 0, enabled: true, costCentsPerImage: 4 },
        { name: "backup", baseUrl: backup.baseUrl, apiKey: "sk-b", priority: 1, enabled: true, costCentsPerImage: 9 }
      ],
      healthStore
    });

    const result = await provider.generateImage(baseInput);

    // 冷却中的渠道降级到队尾，健康渠道优先
    assert.deepEqual(result.channels, ["backup"]);
    assert.equal(primary.requests.length, 0);
    // 命中哪个渠道就按哪个渠道记账，否则毛利报表会骗人
    assert.equal(result.providerCostCents, 9);

    const health = await provider.channelHealth();
    assert.equal(health.channels.find((channel) => channel.name === "primary").tripped, true);

    await provider.close();
  } finally {
    await primary.close();
    await backup.close();
  }
});

test("provider uses the per-channel upstream model override", async () => {
  const gateway = await startImageGateway(() => ({ status: 200, body: { data: [{ b64_json: onePixelPngBase64 }] } }));

  try {
    const provider = new OpenAiImageGenerationProvider({
      channels: [
        {
          name: "renamed",
          baseUrl: gateway.baseUrl,
          apiKey: "sk-a",
          priority: 0,
          enabled: true,
          upstreamModel: "gpt-image-2-vip"
        }
      ],
      healthStore: createChannelHealthStore({ provider: "memory" })
    });

    await provider.generateImage(baseInput);
    assert.equal(gateway.requests[0].body.model, "gpt-image-2-vip");

    await provider.close();
  } finally {
    await gateway.close();
  }
});

test("provider throws when every channel is exhausted", async () => {
  const first = await startImageGateway(() => ({ status: 503, body: { error: { message: "down" } } }));
  const second = await startImageGateway(() => ({ status: 502, body: { error: { message: "also down" } } }));

  const previous = snapshotEnv(["OPENAI_MAX_RETRIES"]);
  try {
    process.env.OPENAI_MAX_RETRIES = "0";
    const provider = new OpenAiImageGenerationProvider({
      channels: [
        { name: "a", baseUrl: first.baseUrl, apiKey: "sk-a", priority: 0, enabled: true },
        { name: "b", baseUrl: second.baseUrl, apiKey: "sk-b", priority: 1, enabled: true }
      ],
      healthStore: createChannelHealthStore({ provider: "memory" })
    });

    await assert.rejects(
      () => provider.generateImage(baseInput),
      (error) => {
        assert.equal(error.code, "PROVIDER_FAILED");
        return true;
      }
    );
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 1);

    await provider.close();
  } finally {
    restoreEnv(previous);
    await first.close();
    await second.close();
  }
});

test("provider construction fails when no channel is configured", () => {
  const previous = snapshotEnv(["IMAGE_CHANNELS", "OPENAI_API_KEY"]);
  try {
    delete process.env.IMAGE_CHANNELS;
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => new OpenAiImageGenerationProvider(), /IMAGE_CHANNELS/);
  } finally {
    restoreEnv(previous);
  }
});

async function startImageGateway(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      requests.push({ url: req.url, authorization: req.headers.authorization, body });
      const response = handler(requests.length);
      const send = () => {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(response.body));
      };
      if (response.delayMs) {
        setTimeout(send, response.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  };
}

function snapshotEnv(names) {
  return names.map((name) => [name, process.env[name]]);
}

function restoreEnv(entries) {
  for (const [name, value] of entries) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
