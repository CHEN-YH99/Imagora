import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const defaultWriteOrigin = "http://127.0.0.1:3100";

test("redis rate limiter fails closed with a service-unavailable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-redis-limit-"));
  const apiPort = 5500 + Math.floor(Math.random() * 400);
  const unavailableRedisPort = await reserveUnusedPort();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    IMAGORA_STORE_PATH: join(dir, "store.json"),
    ALLOW_BEARER_SESSION_AUTH: "false",
    RATE_LIMIT_PROVIDER: "redis",
    REDIS_URL: `redis://127.0.0.1:${unavailableRedisPort}`,
    REDIS_RATE_LIMIT_TIMEOUT_MS: "200",
    RATE_LIMIT_AUTH_MAX: "1"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHealth(baseUrl);
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        email: "demo@imagora.local",
        password: "wrong-password"
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "RATE_LIMIT_UNAVAILABLE");
  } finally {
    api.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("redis rate limiter fails closed when redis returns an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-redis-error-"));
  const apiPort = 5700 + Math.floor(Math.random() * 200);
  const redis = createErrorRedisServer();
  await redis.listen();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    IMAGORA_STORE_PATH: join(dir, "store.json"),
    ALLOW_BEARER_SESSION_AUTH: "false",
    RATE_LIMIT_PROVIDER: "redis",
    REDIS_URL: `redis://127.0.0.1:${redis.port}`,
    REDIS_RATE_LIMIT_TIMEOUT_MS: "1000",
    RATE_LIMIT_AUTH_MAX: "1"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], { env, stdio: "ignore" });

  try {
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHealth(baseUrl);
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: defaultWriteOrigin
      },
      body: JSON.stringify({
        email: "demo@imagora.local",
        password: "wrong-password"
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "RATE_LIMIT_UNAVAILABLE");
    assert.equal(api.exitCode, null);
  } finally {
    api.kill();
    await redis.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("redis rate limiter shares counters across api instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-redis-shared-"));
  const firstApiPort = 5900 + Math.floor(Math.random() * 200);
  const secondApiPort = firstApiPort + 300;
  const redis = createFakeRedisServer();
  await redis.listen();
  const commonEnv = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    IMAGORA_STORE_PATH: join(dir, "store.json"),
    ALLOW_BEARER_SESSION_AUTH: "false",
    RATE_LIMIT_PROVIDER: "redis",
    REDIS_URL: `redis://127.0.0.1:${redis.port}`,
    REDIS_RATE_LIMIT_TIMEOUT_MS: "1000",
    EXPOSE_CAPTCHA_ANSWER_FOR_TESTS: "true",
    RATE_LIMIT_AUTH_MAX: "1",
    RATE_LIMIT_WINDOW_MS: "60000"
  };
  const firstApi = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: { ...commonEnv, API_PORT: String(firstApiPort) },
    stdio: "ignore"
  });
  const secondApi = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: { ...commonEnv, API_PORT: String(secondApiPort) },
    stdio: "ignore"
  });

  try {
    const firstBaseUrl = `http://127.0.0.1:${firstApiPort}`;
    const secondBaseUrl = `http://127.0.0.1:${secondApiPort}`;
    await waitForHealth(firstBaseUrl);
    await waitForHealth(secondBaseUrl);

    const firstAttempt = await invalidLogin(firstBaseUrl);
    const secondAttempt = await invalidLogin(secondBaseUrl);

    assert.equal(firstAttempt.status, 401);
    assert.equal(firstAttempt.payload.error.code, "INVALID_CREDENTIALS");
    assert.equal(secondAttempt.status, 429);
    assert.equal(secondAttempt.payload.error.code, "RATE_LIMITED");
  } finally {
    firstApi.kill();
    secondApi.kill();
    await redis.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("proxy trust controls whether forwarded addresses can change rate-limit buckets", async (t) => {
  const cases = [
    { name: "unset ignores forged forwarding headers", trustProxy: undefined, statuses: [200, 429, 429] },
    { name: "false ignores forged forwarding headers", trustProxy: "false", statuses: [200, 429, 429] },
    { name: "zero ignores forged forwarding headers", trustProxy: "0", statuses: [200, 429, 429] },
    { name: "untrusted peer cannot forward client IPs", trustProxy: "192.0.2.0/24", statuses: [200, 429, 429] },
    {
      name: "trusted proxy separates client IPs and preserves each limit",
      trustProxy: "192.0.2.0/24, 127.0.0.0/8",
      statuses: [200, 200, 429]
    },
    {
      name: "trusted proxy stops at the nearest untrusted hop",
      trustProxy: "127.0.0.0/8",
      forwardedAddresses: ["203.0.113.1, 198.51.100.10", "203.0.113.2, 198.51.100.10"],
      statuses: [200, 429]
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, { timeout: 15_000 }, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "imagora-proxy-limit-"));
      const port = await reserveUnusedPort();
      const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
        env: proxyTestEnv(dir, port, scenario.trustProxy),
        stdio: "ignore"
      });
      t.after(async () => {
        await stopApi(api);
        await rm(dir, { recursive: true, force: true });
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl);
      const addresses = scenario.forwardedAddresses ?? ["198.51.100.10", "198.51.100.11", "198.51.100.10"];
      for (const [index, forwardedFor] of addresses.entries()) {
        const response = await fetch(`${baseUrl}/api/auth/captcha`, {
          headers: { "X-Forwarded-For": forwardedFor }
        });
        const payload = await response.json();
        assert.equal(response.status, scenario.statuses[index], JSON.stringify(payload));
        if (response.status === 429) {
          assert.equal(payload.error.code, "RATE_LIMITED");
        } else {
          assert.ok(payload.data.captchaId);
        }
      }
    });
  }
});

test("numeric proxy hop counts fail startup with a migration message", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-proxy-hop-"));
  const port = await reserveUnusedPort();
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: proxyTestEnv(dir, port, "1"),
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  api.stderr.setEncoding("utf8");
  api.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    await stopApi(api);
    await rm(dir, { recursive: true, force: true });
  });

  const [code] = await once(api, "close");
  assert.equal(code, 1, stderr);
  assert.match(
    stderr,
    /TRUST_PROXY hop counts are no longer supported; configure trusted proxy IP\/CIDR addresses or false/
  );
});

function proxyTestEnv(dir, port, trustProxy) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    DATA_STORE: "json",
    IMAGORA_STORE_PATH: join(dir, "store.json"),
    QUEUE_PROVIDER: "inline",
    MAILER_PROVIDER: "console",
    ALERT_WEBHOOK_URL: "",
    ALERT_EMAIL_TO: "",
    PAYMENT_PROVIDER: "mock",
    STORAGE_PROVIDER: "inline",
    CAPTCHA_PROVIDER: "builtin",
    RATE_LIMIT_PROVIDER: "memory",
    RATE_LIMIT_CAPTCHA_MAX: "1",
    RATE_LIMIT_WINDOW_MS: "60000"
  };
  if (trustProxy === undefined) {
    delete env.TRUST_PROXY;
  } else {
    env.TRUST_PROXY = trustProxy;
  }
  return env;
}

async function stopApi(api) {
  if (api.exitCode === null && api.signalCode === null) {
    const closed = once(api, "close");
    api.kill();
    await closed;
  }
}

function reserveUnusedPort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(200);
  }
  throw new Error("API health check timed out");
}

async function invalidLogin(baseUrl) {
  const firstProof = await verifyCaptcha(baseUrl);
  const secondProof = await verifyCaptcha(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: defaultWriteOrigin
    },
    body: JSON.stringify({
      email: "demo@imagora.local",
      password: "wrong-password",
      captchaVerificationIds: [firstProof.data.verificationId, secondProof.data.verificationId]
    })
  });
  return {
    status: response.status,
    payload: await response.json()
  };
}

async function verifyCaptcha(baseUrl) {
  const captchaResponse = await fetch(`${baseUrl}/api/auth/captcha`);
  const captchaPayload = await captchaResponse.json();
  assert.equal(captchaResponse.status, 200);
  assert.ok(captchaPayload.data.captchaId);
  assert.ok(captchaPayload.data.answer);
  const response = await fetch(`${baseUrl}/api/auth/captcha/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: defaultWriteOrigin
    },
    body: JSON.stringify({
      captchaId: captchaPayload.data.captchaId,
      captchaSelections: captchaPayload.data.answer
    })
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.ok(payload.data?.verificationId);
  return payload;
}

function createFakeRedisServer() {
  const values = new Map();
  let port = 0;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseRedisArray(buffer);
        if (!parsed) {
          return;
        }
        buffer = buffer.subarray(parsed.bytes);
        socket.write(handleRedisCommand(parsed.args, values));
      }
    });
  });

  return {
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

function createErrorRedisServer() {
  let port = 0;
  const server = createServer((socket) => {
    socket.on("data", () => {
      socket.write("-ERR simulated redis failure\r\n");
    });
  });

  return {
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

function handleRedisCommand(args, values) {
  const [command, key, value] = args;
  const normalizedCommand = command?.toUpperCase();
  if (normalizedCommand === "INCR" && key) {
    pruneExpiredRedisKey(values, key);
    const entry = values.get(key) ?? { count: 0, expiresAt: null };
    entry.count += 1;
    values.set(key, entry);
    return integerResponse(entry.count);
  }
  if (normalizedCommand === "PEXPIRE" && key && value) {
    const entry = values.get(key) ?? { count: 0, expiresAt: null };
    entry.expiresAt = Date.now() + Number(value);
    values.set(key, entry);
    return integerResponse(1);
  }
  if (normalizedCommand === "PTTL" && key) {
    pruneExpiredRedisKey(values, key);
    const entry = values.get(key);
    return integerResponse(entry?.expiresAt ? Math.max(entry.expiresAt - Date.now(), 0) : -2);
  }
  return simpleResponse("OK");
}

function pruneExpiredRedisKey(values, key) {
  const entry = values.get(key);
  if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
    values.delete(key);
  }
}

function parseRedisArray(buffer) {
  let offset = 0;
  const firstLine = readRedisLine(buffer, offset);
  if (!firstLine || !firstLine.value.startsWith("*")) {
    return null;
  }
  offset = firstLine.nextOffset;
  const itemCount = Number(firstLine.value.slice(1));
  const args = [];
  for (let index = 0; index < itemCount; index += 1) {
    const lengthLine = readRedisLine(buffer, offset);
    if (!lengthLine || !lengthLine.value.startsWith("$")) {
      return null;
    }
    offset = lengthLine.nextOffset;
    const length = Number(lengthLine.value.slice(1));
    if (buffer.length < offset + length + 2) {
      return null;
    }
    args.push(buffer.subarray(offset, offset + length).toString("utf8"));
    offset += length + 2;
  }
  return { args, bytes: offset };
}

function readRedisLine(buffer, offset) {
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }
  return {
    value: buffer.subarray(offset, lineEnd).toString("utf8"),
    nextOffset: lineEnd + 2
  };
}

function integerResponse(value) {
  return `:${Math.round(value)}\r\n`;
}

function simpleResponse(value) {
  return `+${value}\r\n`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
