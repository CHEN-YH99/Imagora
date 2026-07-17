import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    assert.equal(firstAttempt.payload.error.code, "UNAUTHORIZED");
    assert.equal(secondAttempt.status, 429);
    assert.equal(secondAttempt.payload.error.code, "RATE_LIMITED");
  } finally {
    firstApi.kill();
    secondApi.kill();
    await redis.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
