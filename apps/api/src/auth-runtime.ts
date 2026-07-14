import { AppError, type StoreData, type User } from "@imagora/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { envBool } from "./runtime.js";

interface AuthStore {
  read(): Promise<StoreData>;
}

export function createAuthRuntime(store: AuthStore): {
  requireAuth: (request: FastifyRequest) => Promise<{ data: StoreData; user: User }>;
  requireAdmin: (request: FastifyRequest) => Promise<{ data: StoreData; user: User }>;
} {
  async function requireAuth(request: FastifyRequest): Promise<{ data: StoreData; user: User }> {
    const token = sessionToken(request);
    const data = await store.read();
    const now = new Date();
    data.sessions = data.sessions.filter((session) => new Date(session.expiresAt) > now);
    const session = data.sessions.find((item) => item.token === token);
    if (!session) {
      throw new AppError("UNAUTHORIZED", "Invalid or expired session", 401);
    }
    const user = data.users.find((item) => item.id === session.userId);
    if (!user || user.status !== "ACTIVE") {
      throw new AppError("FORBIDDEN", "User is not active", 403);
    }
    return { data, user };
  }

  async function requireAdmin(request: FastifyRequest): Promise<{ data: StoreData; user: User }> {
    const session = await requireAuth(request);
    if (session.user.role !== "ADMIN") {
      throw new AppError("FORBIDDEN", "Admin role is required", 403);
    }
    return session;
  }

  return { requireAuth, requireAdmin };
}

export function sessionToken(request: FastifyRequest, optional = false): string {
  const cookieToken = cookieValue(request.headers.cookie, sessionCookieName());
  if (cookieToken) {
    return cookieToken;
  }
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    if (allowBearerSessionAuth()) {
      return authorization.slice("Bearer ".length);
    }
    throw new AppError("UNAUTHORIZED", "Bearer session auth is disabled", 401);
  }
  if (optional) {
    return "";
  }
  throw new AppError("UNAUTHORIZED", "Missing session token", 401);
}

export function allowBearerSessionAuth(): boolean {
  return envBool("ALLOW_BEARER_SESSION_AUTH", false);
}

// 邮箱验证门槛：防止一次性邮箱注册即领 120 积分直接消耗。
// 开发/测试默认关闭（无痛调试）；生产默认开启，且 validateProductionConfig
// 会拒绝任何显式关闭（REQUIRE_EMAIL_VERIFICATION=false）的生产配置。
export function requireEmailVerification(): boolean {
  return envBool("REQUIRE_EMAIL_VERIFICATION", process.env.NODE_ENV === "production");
}

export function assertEmailVerified(user: User): void {
  if (!requireEmailVerification()) {
    return;
  }
  if (!user.emailVerifiedAt) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Email verification is required before generating images", 403);
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
  const sessionCookie = serializeCookie(sessionCookieName(), token, {
    expires: new Date(expiresAt),
    httpOnly: true,
    secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
    sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
    path: "/"
  });
  const existing = reply.getHeader("set-cookie");
  if (existing === undefined) {
    reply.header("set-cookie", sessionCookie);
    return;
  }
  const existingCookies = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header("set-cookie", [
    sessionCookie,
    ...existingCookies.filter((cookie) => !cookie.startsWith(`${sessionCookieName()}=`))
  ]);
}

export function clearSessionCookie(reply: FastifyReply): void {
  appendSetCookie(
    reply,
    serializeCookie(sessionCookieName(), "", {
      expires: new Date(0),
      httpOnly: true,
      secure: envBool("SESSION_COOKIE_SECURE", process.env.NODE_ENV === "production"),
      sameSite: process.env.SESSION_COOKIE_SAMESITE ?? "Lax",
      path: "/"
    })
  );
}

export function sessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? "imagora_session";
}

export function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

// 追加一个 Set-Cookie 头，避免同一响应里多次 reply.header("set-cookie") 相互覆盖
// （典型场景：登录成功同时要种 session cookie 并清掉登录尝试令牌 cookie）。
export function appendSetCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  if (existing === undefined) {
    reply.header("set-cookie", cookie);
    return;
  }
  const list = Array.isArray(existing) ? [...existing.map(String), cookie] : [String(existing), cookie];
  reply.header("set-cookie", list);
}

export function serializeCookie(
  name: string,
  value: string,
  options: { expires: Date; httpOnly: boolean; secure: boolean; sameSite: string; path: string }
): string {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    `Expires=${options.expires.toUTCString()}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`
  ];
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
}

export function defaultNicknameForEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart.replace(/[^a-z0-9_-]/gi, "").slice(0, 32);
  return cleaned || "Imagora 用户";
}
