import { Redis } from "ioredis";

// 渠道熔断状态。多 worker 部署时必须共享判断，否则每个进程都要各自撞死一遍渠道才会绕开。
// 生产强制 redis（与 RUNTIME_STATE_PROVIDER 同一口径），本地默认走内存。

export type ChannelHealthProvider = "memory" | "redis";

export interface ChannelHealthSettings {
  /** 连续失败达到该次数即熔断该渠道 */
  failureThreshold: number;
  /** 熔断后的冷却时长（毫秒），冷却结束自动放行探测 */
  cooldownMs: number;
  /** 失败计数的滑动窗口（毫秒），窗口内无新失败则计数自然过期 */
  failureWindowMs: number;
}

export interface ChannelHealthState {
  channel: string;
  tripped: boolean;
  failures: number;
}

export interface ChannelHealthStore {
  readonly provider: ChannelHealthProvider;
  isTripped(channel: string): Promise<boolean>;
  recordSuccess(channel: string): Promise<void>;
  /** 返回记录后该渠道是否已进入熔断 */
  recordFailure(channel: string): Promise<boolean>;
  snapshot(channels: string[]): Promise<ChannelHealthState[]>;
  close(): Promise<void>;
}

export interface ChannelHealthStoreOptions {
  provider?: ChannelHealthProvider;
  settings?: ChannelHealthSettings;
  redisUrl?: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export const DEFAULT_CHANNEL_FAILURE_THRESHOLD = 3;
export const DEFAULT_CHANNEL_COOLDOWN_MS = 120_000;
export const DEFAULT_CHANNEL_FAILURE_WINDOW_MS = 300_000;

// 失败计数与熔断标记必须原子推进，否则并发失败会各自读到旧值而漏掉熔断。
const recordFailureScript = `
local failures = redis.call("INCR", KEYS[1])
if failures == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
if failures >= tonumber(ARGV[2]) then
  redis.call("SET", KEYS[2], "1", "PX", ARGV[3])
  redis.call("DEL", KEYS[1])
  return 1
end
return 0
`;

export function readChannelHealthSettings(
  env: Partial<Record<string, string | undefined>> = process.env
): ChannelHealthSettings {
  return {
    failureThreshold: readPositiveInt(env.IMAGE_CHANNEL_FAILURE_THRESHOLD, DEFAULT_CHANNEL_FAILURE_THRESHOLD, 1, 100),
    cooldownMs: readPositiveInt(env.IMAGE_CHANNEL_COOLDOWN_MS, DEFAULT_CHANNEL_COOLDOWN_MS, 1_000, 60 * 60_000),
    failureWindowMs: readPositiveInt(
      env.IMAGE_CHANNEL_FAILURE_WINDOW_MS,
      DEFAULT_CHANNEL_FAILURE_WINDOW_MS,
      1_000,
      60 * 60_000
    )
  };
}

export function resolveChannelHealthProvider(
  env: Partial<Record<string, string | undefined>> = process.env
): ChannelHealthProvider {
  const fallback: ChannelHealthProvider = env.NODE_ENV === "production" ? "redis" : "memory";
  const provider = env.IMAGE_CHANNEL_HEALTH_PROVIDER?.trim() || env.RUNTIME_STATE_PROVIDER?.trim() || fallback;
  if (provider !== "memory" && provider !== "redis") {
    throw new Error("IMAGE_CHANNEL_HEALTH_PROVIDER must be memory or redis");
  }
  return provider;
}

class MemoryChannelHealthStore implements ChannelHealthStore {
  readonly provider = "memory" as const;

  private readonly failures = new Map<string, { count: number; expiresAt: number }>();
  private readonly tripped = new Map<string, number>();

  constructor(private readonly settings: ChannelHealthSettings) {}

  async isTripped(channel: string): Promise<boolean> {
    const trippedUntil = this.tripped.get(channel);
    if (trippedUntil === undefined) {
      return false;
    }
    if (trippedUntil <= Date.now()) {
      this.tripped.delete(channel);
      return false;
    }
    return true;
  }

  async recordSuccess(channel: string): Promise<void> {
    this.failures.delete(channel);
    this.tripped.delete(channel);
  }

  async recordFailure(channel: string): Promise<boolean> {
    const now = Date.now();
    const entry = this.failures.get(channel);
    const count = entry && entry.expiresAt > now ? entry.count + 1 : 1;
    if (count >= this.settings.failureThreshold) {
      this.failures.delete(channel);
      this.tripped.set(channel, now + this.settings.cooldownMs);
      return true;
    }
    this.failures.set(channel, { count, expiresAt: now + this.settings.failureWindowMs });
    return false;
  }

  async snapshot(channels: string[]): Promise<ChannelHealthState[]> {
    const now = Date.now();
    return Promise.all(
      channels.map(async (channel) => {
        const entry = this.failures.get(channel);
        return {
          channel,
          tripped: await this.isTripped(channel),
          failures: entry && entry.expiresAt > now ? entry.count : 0
        };
      })
    );
  }

  async close(): Promise<void> {
    this.failures.clear();
    this.tripped.clear();
  }
}

class RedisChannelHealthStore implements ChannelHealthStore {
  readonly provider = "redis" as const;

  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private redisClient: Redis | null = null;
  private redisConnectPromise: Promise<Redis> | null = null;
  private closed = false;

  constructor(
    private readonly settings: ChannelHealthSettings,
    options: ChannelHealthStoreOptions
  ) {
    this.redisUrl =
      options.redisUrl ?? process.env.RUNTIME_STATE_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    this.keyPrefix = (options.keyPrefix ?? process.env.RUNTIME_STATE_KEY_PREFIX ?? "imagora:runtime").replace(
      /:+$/,
      ""
    );
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? readPositiveInt(process.env.RUNTIME_STATE_REDIS_CONNECT_TIMEOUT_MS, 500, 50, 30_000);
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? readPositiveInt(process.env.RUNTIME_STATE_REDIS_COMMAND_TIMEOUT_MS, 500, 50, 30_000);
  }

  async isTripped(channel: string): Promise<boolean> {
    const result = await this.withRedis((redis) => redis.exists(this.trippedKey(channel)));
    return Number(result) === 1;
  }

  async recordSuccess(channel: string): Promise<void> {
    await this.withRedis((redis) => redis.del(this.failureKey(channel), this.trippedKey(channel)));
  }

  async recordFailure(channel: string): Promise<boolean> {
    const result = await this.withRedis((redis) =>
      redis.eval(
        recordFailureScript,
        2,
        this.failureKey(channel),
        this.trippedKey(channel),
        String(this.settings.failureWindowMs),
        String(this.settings.failureThreshold),
        String(this.settings.cooldownMs)
      )
    );
    return Number(result) === 1;
  }

  async snapshot(channels: string[]): Promise<ChannelHealthState[]> {
    if (!channels.length) {
      return [];
    }
    return this.withRedis(async (redis) => {
      const pipeline = redis.pipeline();
      for (const channel of channels) {
        pipeline.exists(this.trippedKey(channel));
        pipeline.get(this.failureKey(channel));
      }
      const results = (await pipeline.exec()) ?? [];
      return channels.map((channel, index) => ({
        channel,
        tripped: Number(results[index * 2]?.[1] ?? 0) === 1,
        failures: Number(results[index * 2 + 1]?.[1] ?? 0) || 0
      }));
    });
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

  private failureKey(channel: string): string {
    return `${this.keyPrefix}:image:channel:failures:${encodeChannel(channel)}`;
  }

  private trippedKey(channel: string): string {
    return `${this.keyPrefix}:image:channel:tripped:${encodeChannel(channel)}`;
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
      throw new Error("Channel health store is closed");
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
      // 实际错误由命令调用方接收处理，监听器只用于避免 EventEmitter 未捕获异常。
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

export function createChannelHealthStore(options: ChannelHealthStoreOptions = {}): ChannelHealthStore {
  const settings = options.settings ?? readChannelHealthSettings();
  const provider = options.provider ?? resolveChannelHealthProvider();
  return provider === "redis" ? new RedisChannelHealthStore(settings, options) : new MemoryChannelHealthStore(settings);
}

/**
 * redis 不可用时不能让生图整体瘫掉：熔断只是优化项，读失败按「渠道可用」放行，
 * 写失败静默丢弃。生图可用性优先于熔断精度。
 */
export function createResilientChannelHealthStore(
  store: ChannelHealthStore,
  onError?: (error: unknown, operation: string) => void
): ChannelHealthStore {
  return {
    provider: store.provider,
    async isTripped(channel) {
      try {
        return await store.isTripped(channel);
      } catch (error) {
        onError?.(error, "isTripped");
        return false;
      }
    },
    async recordSuccess(channel) {
      try {
        await store.recordSuccess(channel);
      } catch (error) {
        onError?.(error, "recordSuccess");
      }
    },
    async recordFailure(channel) {
      try {
        return await store.recordFailure(channel);
      } catch (error) {
        onError?.(error, "recordFailure");
        return false;
      }
    },
    async snapshot(channels) {
      try {
        return await store.snapshot(channels);
      } catch (error) {
        onError?.(error, "snapshot");
        return channels.map((channel) => ({ channel, tripped: false, failures: 0 }));
      }
    },
    close() {
      return store.close();
    }
  };
}

function encodeChannel(channel: string): string {
  return Buffer.from(channel, "utf8").toString("base64url");
}

function readPositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}
