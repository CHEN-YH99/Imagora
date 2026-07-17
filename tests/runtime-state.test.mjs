import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeState } from "../apps/api/dist/runtime-state.js";

test("redis runtime state shares and consumes captcha challenges across instances", async () => {
  const redis = createRuntimeRedisServer();
  await redis.listen();
  const first = createRedisRuntime(redis.url, "captcha-shared");
  const second = createRedisRuntime(redis.url, "captcha-shared");
  const challenge = {
    answerHash: "answer-hash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  };

  try {
    await first.setCaptchaChallenge("challenge-1", challenge, 60_000);
    assert.deepEqual(await second.consumeCaptchaChallenge("challenge-1"), challenge);
    assert.equal(await first.consumeCaptchaChallenge("challenge-1"), null);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await redis.close();
  }
});

test("redis runtime state atomically consumes multi-round captcha verification", async () => {
  const redis = createRuntimeRedisServer();
  await redis.listen();
  const first = createRedisRuntime(redis.url, "captcha-verification");
  const second = createRedisRuntime(redis.url, "captcha-verification");

  try {
    await Promise.all([
      first.setCaptchaVerification("verification-1", 60_000),
      second.setCaptchaVerification("verification-2", 60_000)
    ]);
    const results = await Promise.all([
      first.consumeCaptchaVerifications(["verification-1", "verification-2"]),
      second.consumeCaptchaVerifications(["verification-1", "verification-2"])
    ]);

    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await first.consumeCaptchaVerifications(["verification-1", "verification-2"]), false);
    assert.equal(await first.consumeCaptchaVerifications(["verification-1", "verification-1"]), false);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await redis.close();
  }
});

test("redis runtime state never overspends concurrent login attempt allowance", async () => {
  const redis = createRuntimeRedisServer();
  await redis.listen();
  const first = createRedisRuntime(redis.url, "login-attempt");
  const second = createRedisRuntime(redis.url, "login-attempt");

  try {
    await first.setLoginAttempt("login-token", 3, 60_000);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? first : second).consumeLoginAttempt("login-token"))
    );

    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(await second.consumeLoginAttempt("login-token"), false);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await redis.close();
  }
});

test("redis runtime state aggregates shared HTTP metrics correctly", async () => {
  const redis = createRuntimeRedisServer();
  await redis.listen();
  const first = createRedisRuntime(redis.url, "http-metrics");
  const second = createRedisRuntime(redis.url, "http-metrics");

  try {
    await Promise.all([
      first.recordHttpMetric("GET /health", 200, 10),
      second.recordHttpMetric("GET /health", 503, 40),
      first.recordHttpMetric("GET /health", 200, 20),
      second.recordHttpMetric("POST /api/auth/login", 401, 5)
    ]);

    assert.deepEqual(await first.httpMetricsSnapshot(), {
      requestsTotal: 4,
      failuresTotal: 1,
      routes: [
        {
          route: "GET /health",
          requests: 3,
          failures: 1,
          averageDurationMs: 23.33,
          maxDurationMs: 40
        },
        {
          route: "POST /api/auth/login",
          requests: 1,
          failures: 0,
          averageDurationMs: 5,
          maxDurationMs: 5
        }
      ]
    });
  } finally {
    await Promise.all([first.close(), second.close()]);
    await redis.close();
  }
});

test("redis runtime state reconnects after a command failure", async () => {
  const redis = createRuntimeRedisServer();
  await redis.listen();
  const port = redis.port;
  const runtime = createRedisRuntime(redis.url, "reconnect");

  try {
    await runtime.setLoginAttempt("before-restart", 1, 60_000);
    await redis.close();

    await assert.rejects(runtime.setLoginAttempt("during-restart", 1, 60_000));

    await redis.listen(port);
    await runtime.setLoginAttempt("after-restart", 1, 60_000);
    assert.equal(await runtime.consumeLoginAttempt("after-restart"), true);
  } finally {
    await runtime.close();
    if (redis.listening) {
      await redis.close();
    }
  }
});

test("login removes the new session when redis attempt cleanup fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-runtime-state-login-compensation-"));
  const storePath = join(dir, "store.json");
  const redis = createRuntimeRedisServer();
  await redis.listen();
  const runtime = createRedisRuntime(redis.url, "login-compensation");
  const apiPort = await reserveUnusedPort();
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      IMAGORA_STORE_PATH: storePath,
      IMAGORA_SEED_DEMO_DATA: "true",
      DATA_STORE: "json",
      RATE_LIMIT_PROVIDER: "memory",
      RUNTIME_STATE_PROVIDER: "redis",
      RUNTIME_STATE_KEY_PREFIX: "imagora:test:login-compensation",
      REDIS_URL: redis.url,
      RUNTIME_STATE_REDIS_CONNECT_TIMEOUT_MS: "500",
      RUNTIME_STATE_REDIS_COMMAND_TIMEOUT_MS: "500",
      GENERATION_MAINTENANCE_INTERVAL_MS: "0",
      GENERATION_ENQUEUE_RECONCILE_INTERVAL_MS: "0",
      ORDER_MAINTENANCE_INTERVAL_MS: "0",
      ORDER_PROVIDER_RECONCILE_INTERVAL_MS: "0",
      ALERT_EVALUATION_INTERVAL_MS: "0"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  api.stderr.setEncoding("utf8");
  api.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHealth(baseUrl, () => `exitCode=${String(api.exitCode)} stderr=${stderr}`);
    const before = await readJsonFileWithRetry(storePath, () => `exitCode=${String(api.exitCode)} stderr=${stderr}`);
    const demo = before.users.find((user) => user.email === "demo@imagora.local");
    assert.ok(demo);
    const sessionsBefore = before.sessions.filter((session) => session.userId === demo.id).length;
    const loginAttemptToken = "cleanup-failure-token";
    await runtime.setLoginAttempt(loginAttemptToken, 2, 60_000);
    redis.failNext("DEL");

    let response;
    try {
      response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:3100",
          Cookie: `imagora_login_attempt=${loginAttemptToken}`
        },
        body: JSON.stringify({
          email: "demo@imagora.local",
          password: "Demo123!"
        })
      });
    } catch (error) {
      throw new Error(`login request failed: exitCode=${String(api.exitCode)} stderr=${stderr}`, { cause: error });
    }
    const payload = await response.json();
    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.equal(payload.error.code, "RUNTIME_STATE_UNAVAILABLE");

    const after = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(
      after.sessions.filter((session) => session.userId === demo.id).length,
      sessionsBefore,
      "failed redis cleanup must not leave a usable session behind"
    );
  } finally {
    api.kill();
    await waitForExit(api);
    await runtime.close();
    await redis.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unavailable redis returns controlled auth errors without breaking completed responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-runtime-state-unavailable-"));
  const apiPort = await reserveUnusedPort();
  const redisPort = await reserveUnusedPort();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    IMAGORA_STORE_PATH: join(dir, "store.json"),
    DATA_STORE: "json",
    RATE_LIMIT_PROVIDER: "memory",
    RUNTIME_STATE_PROVIDER: "redis",
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    RUNTIME_STATE_REDIS_CONNECT_TIMEOUT_MS: "100",
    RUNTIME_STATE_REDIS_COMMAND_TIMEOUT_MS: "100",
    GENERATION_MAINTENANCE_INTERVAL_MS: "0",
    GENERATION_ENQUEUE_RECONCILE_INTERVAL_MS: "0",
    ORDER_MAINTENANCE_INTERVAL_MS: "0",
    ORDER_PROVIDER_RECONCILE_INTERVAL_MS: "0",
    ALERT_EVALUATION_INTERVAL_MS: "0"
  };
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  api.stderr.setEncoding("utf8");
  api.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHealth(baseUrl, () => `exitCode=${String(api.exitCode)} stderr=${stderr}`);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const captcha = await fetch(`${baseUrl}/api/auth/captcha`);
    const captchaPayload = await captcha.json();
    assert.equal(captcha.status, 503);
    assert.equal(captchaPayload.error.code, "RUNTIME_STATE_UNAVAILABLE");

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3100",
        Cookie: "imagora_login_attempt=unavailable-redis-token"
      },
      body: JSON.stringify({
        email: "demo@imagora.local",
        password: "wrong-password"
      })
    });
    const loginPayload = await login.json();
    assert.equal(login.status, 503);
    assert.equal(loginPayload.error.code, "RUNTIME_STATE_UNAVAILABLE");
    assert.equal(api.exitCode, null, stderr);
  } finally {
    api.kill();
    await waitForExit(api);
    await rm(dir, { recursive: true, force: true });
  }
});

function createRedisRuntime(redisUrl, keyPrefix) {
  return new RuntimeState({
    provider: "redis",
    redisUrl,
    keyPrefix: `imagora:test:${keyPrefix}`,
    connectTimeoutMs: 500,
    commandTimeoutMs: 500
  });
}

function createRuntimeRedisServer() {
  const values = new Map();
  const hashes = new Map();
  const commandFailures = new Map();
  const sockets = new Set();
  let port = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => {
      // RuntimeState intentionally resets failed clients; the test server only needs to release that socket.
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseRedisArray(buffer);
        if (!parsed) {
          return;
        }
        buffer = buffer.subarray(parsed.bytes);
        const result = handleRedisCommand(parsed.args, values, hashes, commandFailures);
        socket.write(result.response, () => {
          if (result.close) {
            socket.end();
          }
        });
      }
    });
  });

  return {
    get listening() {
      return server.listening;
    },
    get port() {
      return port;
    },
    get url() {
      return `redis://127.0.0.1:${port}`;
    },
    failNext(command) {
      const normalized = command.toUpperCase();
      commandFailures.set(normalized, (commandFailures.get(normalized) ?? 0) + 1);
    },
    listen(requestedPort = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          assert.ok(address && typeof address === "object");
          port = address.port;
          resolve();
        });
      });
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
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

function handleRedisCommand(args, values, hashes, commandFailures) {
  const command = args[0]?.toUpperCase();
  const remainingFailures = command ? (commandFailures.get(command) ?? 0) : 0;
  if (command && remainingFailures > 0) {
    if (remainingFailures === 1) {
      commandFailures.delete(command);
    } else {
      commandFailures.set(command, remainingFailures - 1);
    }
    return commandResponse(errorResponse(`injected ${command} failure`));
  }
  switch (command) {
    case "CLIENT":
    case "SELECT":
      return commandResponse(simpleResponse("OK"));
    case "PING":
      return commandResponse(simpleResponse("PONG"));
    case "INFO":
      return commandResponse(bulkResponse("# Server\r\nredis_version:7.4.0\r\nloading:0\r\n"));
    case "ECHO":
      return commandResponse(bulkResponse(args[1] ?? ""));
    case "SET":
      return handleSet(args, values);
    case "GET":
      return commandResponse(readValueResponse(values, args[1]));
    case "GETDEL":
      return handleGetDel(args, values);
    case "DEL":
      return handleDelete(args, values, hashes);
    case "EVAL":
      return handleEval(args, values, hashes);
    case "HGETALL":
      return handleHashGetAll(args, hashes);
    case "QUIT":
      return commandResponse(simpleResponse("OK"), true);
    default:
      return commandResponse(errorResponse(`unsupported command ${command ?? "UNKNOWN"}`));
  }
}

function handleSet(args, values) {
  const key = args[1];
  const value = args[2];
  if (!key || value === undefined) {
    return commandResponse(errorResponse("invalid SET"));
  }
  pruneExpiredValue(values, key);
  const current = values.get(key);
  let expiresAt = null;
  for (let index = 3; index < args.length; index += 1) {
    const option = args[index]?.toUpperCase();
    if (option === "PX") {
      expiresAt = Date.now() + Number(args[index + 1]);
      index += 1;
    } else if (option === "KEEPTTL") {
      expiresAt = current?.expiresAt ?? null;
    }
  }
  values.set(key, { value, expiresAt });
  return commandResponse(simpleResponse("OK"));
}

function handleGetDel(args, values) {
  const key = args[1];
  if (!key) {
    return commandResponse(nullBulkResponse());
  }
  pruneExpiredValue(values, key);
  const entry = values.get(key);
  values.delete(key);
  return commandResponse(entry ? bulkResponse(entry.value) : nullBulkResponse());
}

function handleDelete(args, values, hashes) {
  let deleted = 0;
  for (const key of args.slice(1)) {
    pruneExpiredValue(values, key);
    deleted += values.delete(key) ? 1 : 0;
    deleted += hashes.delete(key) ? 1 : 0;
  }
  return commandResponse(integerResponse(deleted));
}

function handleEval(args, values, hashes) {
  const script = args[1] ?? "";
  const keyCount = Number(args[2] ?? 0);
  const keys = args.slice(3, 3 + keyCount);
  const argv = args.slice(3 + keyCount);

  if (script.includes('redis.call("EXISTS"')) {
    for (const key of keys) {
      pruneExpiredValue(values, key);
      if (!values.has(key)) {
        return commandResponse(integerResponse(0));
      }
    }
    for (const key of keys) {
      values.delete(key);
    }
    return commandResponse(integerResponse(1));
  }

  if (script.includes("remaining = remaining - 1")) {
    const key = keys[0];
    if (!key) {
      return commandResponse(integerResponse(0));
    }
    pruneExpiredValue(values, key);
    const entry = values.get(key);
    const remaining = Number(entry?.value);
    if (!entry || !Number.isFinite(remaining) || remaining <= 0) {
      values.delete(key);
      return commandResponse(integerResponse(0));
    }
    if (remaining === 1) {
      values.delete(key);
    } else {
      entry.value = String(remaining - 1);
    }
    return commandResponse(integerResponse(1));
  }

  if (script.includes('redis.call("HINCRBY"')) {
    const key = keys[0];
    const prefix = argv[0];
    if (!key || !prefix) {
      return commandResponse(errorResponse("invalid metrics EVAL"));
    }
    const failure = Number(argv[1] ?? 0);
    const duration = Number(argv[2] ?? 0);
    const hash = hashes.get(key) ?? new Map();
    incrementHash(hash, `${prefix}:requests`, 1);
    incrementHash(hash, `${prefix}:failures`, failure);
    incrementHash(hash, `${prefix}:totalDurationMs`, duration);
    const maxField = `${prefix}:maxDurationMs`;
    hash.set(maxField, String(Math.max(Number(hash.get(maxField) ?? 0), duration)));
    hashes.set(key, hash);
    return commandResponse(integerResponse(1));
  }

  return commandResponse(errorResponse("unsupported EVAL script"));
}

function handleHashGetAll(args, hashes) {
  const hash = hashes.get(args[1]);
  if (!hash) {
    return commandResponse(arrayResponse([]));
  }
  return commandResponse(arrayResponse([...hash.entries()].flat()));
}

function readValueResponse(values, key) {
  if (!key) {
    return nullBulkResponse();
  }
  pruneExpiredValue(values, key);
  const entry = values.get(key);
  return entry ? bulkResponse(entry.value) : nullBulkResponse();
}

function incrementHash(hash, field, amount) {
  hash.set(field, String(Number(hash.get(field) ?? 0) + amount));
}

function pruneExpiredValue(values, key) {
  const entry = values.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
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

function commandResponse(response, close = false) {
  return { response, close };
}

function simpleResponse(value) {
  return `+${value}\r\n`;
}

function errorResponse(value) {
  return `-ERR ${value}\r\n`;
}

function integerResponse(value) {
  return `:${Math.round(value)}\r\n`;
}

function bulkResponse(value) {
  const bytes = Buffer.byteLength(value);
  return `$${bytes}\r\n${value}\r\n`;
}

function nullBulkResponse() {
  return "$-1\r\n";
}

function arrayResponse(values) {
  return `*${values.length}\r\n${values.map((value) => bulkResponse(value)).join("")}`;
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

async function waitForHealth(baseUrl, diagnostics = () => "") {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling while the process starts.
    }
    await sleep(100);
  }
  throw new Error(`API health check timed out: ${diagnostics()}`);
}

async function readJsonFileWithRetry(filePath, diagnostics = () => "") {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await sleep(100);
  }
  throw new Error(`JSON file was not initialized: ${filePath}; ${diagnostics()}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
