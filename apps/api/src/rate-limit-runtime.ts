import { createConnection } from "node:net";
import { AppError, type StoreData } from "@imagora/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sessionToken } from "./auth-runtime.js";
import { envNumber, pathOnly } from "./runtime.js";

interface RateLimitStore {
  read(): Promise<StoreData>;
}

export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitRule {
  id: string;
  method: string;
  pattern: RegExp;
  max: number;
  // 限流维度：默认按 IP；登录态接口应按 user，避免换 IP 绕过 / 同 NAT 出口互相误伤。
  keyBy?: "ip" | "user";
}

export const rateLimitBuckets = new Map<string, RateLimitBucket>();
export const rateLimitWindowMs = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
export const rateLimitRules: RateLimitRule[] = [
  {
    id: "auth-captcha",
    method: "GET",
    pattern: /^\/api\/auth\/captcha$/,
    max: envNumber("RATE_LIMIT_CAPTCHA_MAX", 60)
  },
  { id: "auth-login", method: "POST", pattern: /^\/api\/auth\/login$/, max: envNumber("RATE_LIMIT_AUTH_MAX", 20) },
  {
    id: "auth-register",
    method: "POST",
    pattern: /^\/api\/auth\/register$/,
    max: envNumber("RATE_LIMIT_AUTH_MAX", 20)
  },
  {
    id: "auth-password-reset-request",
    method: "POST",
    pattern: /^\/api\/auth\/request-password-reset$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-password-reset",
    method: "POST",
    pattern: /^\/api\/auth\/reset-password$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-verify-email",
    method: "POST",
    pattern: /^\/api\/auth\/verify-email$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-resend-verification",
    method: "POST",
    pattern: /^\/api\/auth\/resend-verification$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5),
    keyBy: "user"
  },
  {
    id: "auth-change-password",
    method: "POST",
    pattern: /^\/api\/auth\/change-password$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "auth-change-email",
    method: "POST",
    pattern: /^\/api\/auth\/change-email$/,
    max: envNumber("RATE_LIMIT_PASSWORD_RESET_MAX", 5)
  },
  {
    id: "generation-create",
    method: "POST",
    pattern: /^\/api\/generation\/tasks$/,
    max: envNumber("RATE_LIMIT_GENERATION_MAX", 30)
  },
  {
    id: "reference-upload",
    method: "POST",
    pattern: /^\/api\/uploads\/reference-images$/,
    max: envNumber("RATE_LIMIT_UPLOAD_MAX", 20)
  },
  {
    id: "download-url",
    method: "POST",
    pattern: /^\/api\/images\/[^/]+\/download-url$/,
    max: envNumber("RATE_LIMIT_DOWNLOAD_MAX", 60)
  },
  {
    id: "preview-url",
    method: "POST",
    pattern: /^\/api\/images\/[^/]+\/preview-url$/,
    max: envNumber("RATE_LIMIT_PREVIEW_MAX", envNumber("RATE_LIMIT_DOWNLOAD_MAX", 60))
  },
  {
    id: "payment-webhook",
    method: "POST",
    pattern: /^\/api\/payments\/webhooks\/[^/]+$/,
    max: envNumber("RATE_LIMIT_WEBHOOK_MAX", 120)
  }
];

export function createRateLimitRuntime(store: RateLimitStore): {
  enforceRateLimit: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
} {
  async function enforceRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = pathOnly(request.url);
    const rule = rateLimitRules.find((item) => item.method === request.method && item.pattern.test(path));
    if (!rule || rule.max <= 0) {
      return;
    }

    const now = Date.now();
    if (rateLimitBuckets.size > 5000) {
      pruneRateLimitBuckets(now);
    }

    const key = `${rule.id}:${await rateLimitScope(request, rule)}`;
    if ((process.env.RATE_LIMIT_PROVIDER ?? "memory") === "redis") {
      let redisResult: { count: number; resetAt: number };
      try {
        redisResult = await redisFixedWindowIncrement(key, rateLimitWindowMs);
      } catch (error) {
        request.log.error({ error, rateLimitRule: rule.id }, "Redis rate limiter unavailable");
        throw new AppError("RATE_LIMIT_UNAVAILABLE", "Rate limit service is unavailable", 503);
      }
      reply.header("x-ratelimit-limit", String(rule.max));
      reply.header("x-ratelimit-remaining", String(Math.max(rule.max - redisResult.count, 0)));
      reply.header("x-ratelimit-reset", new Date(redisResult.resetAt).toISOString());
      if (redisResult.count > rule.max) {
        throw new AppError("RATE_LIMITED", "Too many requests, please retry later", 429, {
          limit: rule.max,
          resetAt: new Date(redisResult.resetAt).toISOString()
        });
      }
      return;
    }

    const bucket = rateLimitBuckets.get(key);
    const nextBucket =
      !bucket || bucket.resetAt <= now
        ? { count: 1, resetAt: now + rateLimitWindowMs }
        : { ...bucket, count: bucket.count + 1 };
    rateLimitBuckets.set(key, nextBucket);

    reply.header("x-ratelimit-limit", String(rule.max));
    reply.header("x-ratelimit-remaining", String(Math.max(rule.max - nextBucket.count, 0)));
    reply.header("x-ratelimit-reset", new Date(nextBucket.resetAt).toISOString());

    if (nextBucket.count > rule.max) {
      throw new AppError("RATE_LIMITED", "Too many requests, please retry later", 429, {
        limit: rule.max,
        resetAt: new Date(nextBucket.resetAt).toISOString()
      });
    }
  }

  // 限流维度：默认按 IP；登录态接口（如重发验证邮件）按 userId，避免换 IP 绕过或同 NAT 出口互相挤占。
  // 取不到有效 session 时退回 IP，保证未登录命中该规则的请求仍受 IP 兜底限制。
  async function rateLimitScope(request: FastifyRequest, rule: RateLimitRule): Promise<string> {
    if (rule.keyBy !== "user") {
      return request.ip;
    }
    let token: string;
    try {
      token = sessionToken(request, true);
    } catch {
      return request.ip;
    }
    if (!token) {
      return request.ip;
    }
    const data = await store.read();
    const now = new Date();
    const session = data.sessions.find((item) => item.token === token && new Date(item.expiresAt) > now);
    return session ? `user:${session.userId}` : request.ip;
  }

  return { enforceRateLimit };
}

export async function redisFixedWindowIncrement(
  key: string,
  windowMs: number
): Promise<{ count: number; resetAt: number }> {
  const redisKey = `imagora:ratelimit:${key}`;
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const count = Number(await redisCommand(redisUrl, ["INCR", redisKey]));
  if (count === 1) {
    await redisCommand(redisUrl, ["PEXPIRE", redisKey, String(windowMs)]);
  }
  const ttl = Number(await redisCommand(redisUrl, ["PTTL", redisKey]));
  const resetAt = Date.now() + Math.max(ttl, 0);
  return { count, resetAt };
}

function redisCommand(redisUrl: string, args: string[]): Promise<string> {
  const url = new URL(redisUrl);
  const port = Number(url.port || 6379);
  const password = decodeURIComponent(url.password);
  const db = Number(url.pathname.replace("/", "") || 0);
  const commands: string[][] = [];
  if (password) {
    commands.push(["AUTH", password]);
  }
  if (db) {
    commands.push(["SELECT", String(db)]);
  }
  commands.push(args);

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port });
    let buffer = Buffer.alloc(0);
    const responses: string[] = [];
    socket.setTimeout(envNumber("REDIS_RATE_LIMIT_TIMEOUT_MS", 500));
    socket.on("connect", () => {
      socket.write(commands.map(encodeRedisCommand).join(""));
    });
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length) {
          const parsed = parseRedisResponse(buffer);
          if (!parsed) {
            break;
          }
          responses.push(parsed.value);
          buffer = buffer.subarray(parsed.bytes);
          if (responses.length === commands.length) {
            socket.end();
            resolve(responses[responses.length - 1] ?? "");
          }
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Redis rate limit command timed out"));
    });
    socket.on("error", reject);
  });
}

function encodeRedisCommand(args: string[]): string {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`;
}

function parseRedisResponse(buffer: Buffer): { value: string; bytes: number } | null {
  const type = String.fromCharCode(buffer[0] ?? 0);
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.subarray(1, lineEnd).toString("utf8");
  if (type === "+" || type === ":") {
    return { value: line, bytes: lineEnd + 2 };
  }
  if (type === "-") {
    throw new Error(`Redis error: ${line}`);
  }
  if (type === "$") {
    const length = Number(line);
    if (length < 0) {
      return { value: "", bytes: lineEnd + 2 };
    }
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) {
      return null;
    }
    return { value: buffer.subarray(start, end).toString("utf8"), bytes: end + 2 };
  }
  throw new Error(`Unsupported Redis response type: ${type}`);
}

function pruneRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}
