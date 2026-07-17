import { Redis } from "ioredis";
import { envNumber } from "./runtime.js";

export type RuntimeStateProvider = "memory" | "redis";

export interface CaptchaChallengeState {
  answerHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface HttpRouteMetric {
  route: string;
  requests: number;
  failures: number;
  averageDurationMs: number;
  maxDurationMs: number;
}

export interface HttpMetricsSnapshot {
  requestsTotal: number;
  failuresTotal: number;
  routes: HttpRouteMetric[];
}

interface ExpiringValue<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

interface MutableRouteMetric {
  requests: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface RuntimeStateOptions {
  provider?: RuntimeStateProvider;
  redisUrl?: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

const consumeCaptchaVerificationsScript = `
for index = 1, #KEYS do
  if redis.call("EXISTS", KEYS[index]) ~= 1 then
    return 0
  end
end
redis.call("DEL", unpack(KEYS))
return 1
`;

const consumeLoginAttemptScript = `
local remaining = tonumber(redis.call("GET", KEYS[1]))
if not remaining or remaining <= 0 then
  redis.call("DEL", KEYS[1])
  return 0
end
remaining = remaining - 1
if remaining <= 0 then
  redis.call("DEL", KEYS[1])
else
  redis.call("SET", KEYS[1], remaining, "KEEPTTL")
end
return 1
`;

const recordHttpMetricScript = `
local prefix = ARGV[1]
local failure = tonumber(ARGV[2])
local duration = tonumber(ARGV[3])
redis.call("HINCRBY", KEYS[1], prefix .. ":requests", 1)
redis.call("HINCRBY", KEYS[1], prefix .. ":failures", failure)
redis.call("HINCRBY", KEYS[1], prefix .. ":totalDurationMs", duration)
local maxField = prefix .. ":maxDurationMs"
local currentMax = tonumber(redis.call("HGET", KEYS[1], maxField)) or 0
if duration > currentMax then
  redis.call("HSET", KEYS[1], maxField, duration)
end
return 1
`;

export class RuntimeState {
  readonly provider: RuntimeStateProvider;

  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly captchaChallenges = new Map<string, ExpiringValue<CaptchaChallengeState>>();
  private readonly captchaVerifications = new Map<string, ExpiringValue<true>>();
  private readonly loginAttempts = new Map<string, ExpiringValue<number>>();
  private readonly routeMetrics = new Map<string, MutableRouteMetric>();
  private redisClient: Redis | null = null;
  private redisConnectPromise: Promise<Redis> | null = null;
  private closed = false;

  constructor(options: RuntimeStateOptions = {}) {
    this.provider = options.provider ?? resolveRuntimeStateProvider();
    this.redisUrl =
      options.redisUrl ?? process.env.RUNTIME_STATE_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    this.keyPrefix = (options.keyPrefix ?? process.env.RUNTIME_STATE_KEY_PREFIX ?? "imagora:runtime").replace(
      /:+$/,
      ""
    );
    this.connectTimeoutMs = options.connectTimeoutMs ?? envNumber("RUNTIME_STATE_REDIS_CONNECT_TIMEOUT_MS", 500);
    this.commandTimeoutMs = options.commandTimeoutMs ?? envNumber("RUNTIME_STATE_REDIS_COMMAND_TIMEOUT_MS", 500);
  }

  async setCaptchaChallenge(id: string, challenge: CaptchaChallengeState, ttlMs: number): Promise<void> {
    if (this.provider === "memory") {
      this.setExpiringValue(this.captchaChallenges, id, challenge, ttlMs, envNumber("CAPTCHA_MAX_CHALLENGES", 5000));
      return;
    }
    await this.withRedis((redis) =>
      redis.set(this.key("captcha:challenge", id), JSON.stringify(challenge), "PX", ttlMs)
    );
  }

  async consumeCaptchaChallenge(id: string): Promise<CaptchaChallengeState | null> {
    if (this.provider === "memory") {
      return this.consumeExpiringValue(this.captchaChallenges, id);
    }
    const serialized = await this.withRedis((redis) => redis.getdel(this.key("captcha:challenge", id)));
    if (!serialized) {
      return null;
    }
    return parseCaptchaChallenge(serialized);
  }

  async setCaptchaVerification(id: string, ttlMs: number): Promise<void> {
    if (this.provider === "memory") {
      this.setExpiringValue(this.captchaVerifications, id, true, ttlMs, envNumber("CAPTCHA_MAX_VERIFICATIONS", 5000));
      return;
    }
    await this.withRedis((redis) => redis.set(this.key("captcha:verification", id), "1", "PX", ttlMs));
  }

  async consumeCaptchaVerifications(ids: string[]): Promise<boolean> {
    if (new Set(ids).size !== ids.length || ids.length === 0) {
      return false;
    }
    if (this.provider === "memory") {
      const now = Date.now();
      for (const id of ids) {
        const entry = this.captchaVerifications.get(id);
        if (!entry || entry.expiresAt <= now) {
          if (entry) {
            this.captchaVerifications.delete(id);
          }
          return false;
        }
      }
      for (const id of ids) {
        this.captchaVerifications.delete(id);
      }
      return true;
    }
    const keys = ids.map((id) => this.key("captcha:verification", id));
    const result = await this.withRedis((redis) => redis.eval(consumeCaptchaVerificationsScript, keys.length, ...keys));
    return Number(result) === 1;
  }

  async setLoginAttempt(token: string, remaining: number, ttlMs: number): Promise<void> {
    if (this.provider === "memory") {
      this.setExpiringValue(this.loginAttempts, token, remaining, ttlMs, envNumber("LOGIN_ATTEMPT_MAX_TOKENS", 5000));
      return;
    }
    await this.withRedis((redis) => redis.set(this.key("login:attempt", token), String(remaining), "PX", ttlMs));
  }

  async consumeLoginAttempt(token: string): Promise<boolean> {
    if (this.provider === "memory") {
      const entry = this.loginAttempts.get(token);
      if (!entry || entry.expiresAt <= Date.now() || entry.value <= 0) {
        this.loginAttempts.delete(token);
        return false;
      }
      entry.value -= 1;
      if (entry.value <= 0) {
        this.loginAttempts.delete(token);
      }
      return true;
    }
    const key = this.key("login:attempt", token);
    const result = await this.withRedis((redis) => redis.eval(consumeLoginAttemptScript, 1, key));
    return Number(result) === 1;
  }

  async deleteLoginAttempt(token: string): Promise<void> {
    if (this.provider === "memory") {
      this.loginAttempts.delete(token);
      return;
    }
    await this.withRedis((redis) => redis.del(this.key("login:attempt", token)));
  }

  async recordHttpMetric(route: string, statusCode: number, durationMs: number): Promise<void> {
    const normalizedDurationMs = Math.max(0, Math.round(durationMs));
    const failure = statusCode >= 500 ? 1 : 0;
    if (this.provider === "memory") {
      const metric = this.routeMetrics.get(route) ?? {
        requests: 0,
        failures: 0,
        totalDurationMs: 0,
        maxDurationMs: 0
      };
      metric.requests += 1;
      metric.failures += failure;
      metric.totalDurationMs += normalizedDurationMs;
      metric.maxDurationMs = Math.max(metric.maxDurationMs, normalizedDurationMs);
      this.routeMetrics.set(route, metric);
      return;
    }
    const prefix = encodeRoute(route);
    await this.withRedis((redis) =>
      redis.eval(
        recordHttpMetricScript,
        1,
        this.key("metrics:http"),
        prefix,
        String(failure),
        String(normalizedDurationMs)
      )
    );
  }

  async httpMetricsSnapshot(): Promise<HttpMetricsSnapshot> {
    const metrics =
      this.provider === "memory"
        ? [...this.routeMetrics.entries()]
        : parseRedisMetrics(await this.withRedis((redis) => redis.hgetall(this.key("metrics:http"))));
    const routes = metrics
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([route, metric]) => ({
        route,
        requests: metric.requests,
        failures: metric.failures,
        averageDurationMs: roundMetric(metric.totalDurationMs / Math.max(metric.requests, 1)),
        maxDurationMs: metric.maxDurationMs
      }));
    return {
      requestsTotal: routes.reduce((sum, route) => sum + route.requests, 0),
      failuresTotal: routes.reduce((sum, route) => sum + route.failures, 0),
      routes
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const connecting = this.redisConnectPromise;
    const connected = this.redisClient;
    this.redisConnectPromise = null;
    this.redisClient = null;
    let client = connected;
    if (!client && connecting) {
      try {
        client = await connecting;
      } catch {
        return;
      }
    }
    if (!client) {
      return;
    }
    try {
      await client.quit();
    } catch {
      client.disconnect(false);
    }
  }

  private key(namespace: string, id?: string): string {
    return id ? `${this.keyPrefix}:${namespace}:${id}` : `${this.keyPrefix}:${namespace}`;
  }

  private setExpiringValue<T>(
    values: Map<string, ExpiringValue<T>>,
    id: string,
    value: T,
    ttlMs: number,
    maxEntries: number
  ): void {
    const now = Date.now();
    pruneExpired(values, now);
    values.set(id, { value, expiresAt: now + ttlMs, createdAt: now });
    if (values.size <= maxEntries) {
      return;
    }
    const overflow = [...values.entries()]
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
      .slice(0, values.size - maxEntries);
    for (const [key] of overflow) {
      values.delete(key);
    }
  }

  private consumeExpiringValue<T>(values: Map<string, ExpiringValue<T>>, id: string): T | null {
    const entry = values.get(id);
    values.delete(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      return null;
    }
    return entry.value;
  }

  private async withRedis<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    const redis = await this.getRedis();
    try {
      return await operation(redis);
    } catch (error) {
      this.invalidateRedis(redis);
      throw error;
    }
  }

  private async getRedis(): Promise<Redis> {
    if (this.closed) {
      throw new Error("Runtime state is closed");
    }
    if (this.redisClient?.status === "ready") {
      return this.redisClient;
    }
    if (this.redisConnectPromise) {
      return this.redisConnectPromise;
    }

    const redis = new Redis(this.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: this.connectTimeoutMs,
      commandTimeout: this.commandTimeoutMs,
      retryStrategy: () => null
    });
    redis.on("error", () => {
      // Command callers receive and handle the actual error. The listener prevents unhandled EventEmitter errors.
    });
    this.redisClient = redis;
    this.redisConnectPromise = redis
      .connect()
      .then(() => redis)
      .catch((error) => {
        this.invalidateRedis(redis);
        throw error;
      })
      .finally(() => {
        if (this.redisConnectPromise) {
          this.redisConnectPromise = null;
        }
      });
    return this.redisConnectPromise;
  }

  private invalidateRedis(redis: Redis): void {
    if (this.redisClient === redis) {
      this.redisClient = null;
    }
    redis.disconnect(false);
  }
}

export function resolveRuntimeStateProvider(): RuntimeStateProvider {
  const fallback: RuntimeStateProvider = process.env.NODE_ENV === "production" ? "redis" : "memory";
  const provider = process.env.RUNTIME_STATE_PROVIDER?.trim() || fallback;
  if (provider !== "memory" && provider !== "redis") {
    throw new Error("RUNTIME_STATE_PROVIDER must be memory or redis");
  }
  return provider;
}

export function createRuntimeState(options: RuntimeStateOptions = {}): RuntimeState {
  return new RuntimeState(options);
}

export const runtimeState = createRuntimeState();

function pruneExpired<T>(values: Map<string, ExpiringValue<T>>, now: number): void {
  for (const [key, entry] of values) {
    if (entry.expiresAt <= now) {
      values.delete(key);
    }
  }
}

function parseCaptchaChallenge(serialized: string): CaptchaChallengeState {
  const parsed = JSON.parse(serialized) as Partial<CaptchaChallengeState>;
  if (
    typeof parsed.answerHash !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Invalid captcha challenge state");
  }
  return {
    answerHash: parsed.answerHash,
    expiresAt: parsed.expiresAt,
    createdAt: parsed.createdAt
  };
}

function encodeRoute(route: string): string {
  return Buffer.from(route, "utf8").toString("base64url");
}

function decodeRoute(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function parseRedisMetrics(fields: Record<string, string>): Array<[string, MutableRouteMetric]> {
  const metrics = new Map<string, MutableRouteMetric>();
  for (const [field, value] of Object.entries(fields)) {
    const separator = field.lastIndexOf(":");
    if (separator <= 0) {
      continue;
    }
    const route = decodeRoute(field.slice(0, separator));
    const metricField = field.slice(separator + 1) as keyof MutableRouteMetric;
    if (!["requests", "failures", "totalDurationMs", "maxDurationMs"].includes(metricField)) {
      continue;
    }
    const metric = metrics.get(route) ?? {
      requests: 0,
      failures: 0,
      totalDurationMs: 0,
      maxDurationMs: 0
    };
    metric[metricField] = Number(value) || 0;
    metrics.set(route, metric);
  }
  return [...metrics.entries()];
}

function roundMetric(value: number): number {
  return Number(value.toFixed(2));
}
