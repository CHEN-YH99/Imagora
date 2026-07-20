import assert from "node:assert/strict";
import test from "node:test";
import {
  allowBearerSessionAuth,
  appendSetCookie,
  assertEmailVerified,
  clearSessionCookie,
  cookieValue,
  createAuthRuntime,
  defaultNicknameForEmail,
  requireEmailVerification,
  serializeCookie,
  sessionCookieName,
  sessionCookieSameSite,
  sessionToken,
  setSessionCookie
} from "../apps/api/dist/auth-runtime.js";

test("authentication cookie and policy helpers cover secure defaults", () => {
  delete process.env.ALLOW_BEARER_SESSION_AUTH;
  delete process.env.REQUIRE_EMAIL_VERIFICATION;
  delete process.env.SESSION_COOKIE_NAME;
  delete process.env.SESSION_COOKIE_SAMESITE;
  process.env.NODE_ENV = "test";
  assert.equal(allowBearerSessionAuth(), false);
  assert.equal(requireEmailVerification(), false);
  assert.equal(sessionCookieName(), "imagora_session");
  assert.equal(sessionCookieSameSite(), "Strict");
  process.env.SESSION_COOKIE_SAMESITE = "lax";
  assert.equal(sessionCookieSameSite(), "Lax");
  process.env.SESSION_COOKIE_SAMESITE = "none";
  assert.equal(sessionCookieSameSite(), "None");
  assert.equal(defaultNicknameForEmail("hello.world@example.com"), "helloworld");
  assert.equal(defaultNicknameForEmail("@@@"), "Imagora 用户");
  assert.equal(cookieValue("a=1; imagora_session=token%20value", "imagora_session"), "token value");
  assert.equal(cookieValue(undefined, "imagora_session"), null);
  assert.equal(cookieValue("a=1", "imagora_session"), null);
  assert.match(
    serializeCookie("session", "token", {
      expires: new Date("2026-07-20T00:00:00.000Z"),
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/"
    }),
    /HttpOnly; Secure/
  );
});

test("authentication request and reply helpers cover cookies and bearer tokens", () => {
  let setCookie;
  const reply = {
    getHeader() {
      return setCookie;
    },
    header(name, value) {
      assert.equal(name, "set-cookie");
      setCookie = value;
      return this;
    }
  };
  setSessionCookie(reply, "session-token", new Date(Date.now() + 60_000).toISOString());
  assert.equal(typeof setCookie, "string");
  appendSetCookie(reply, "custom=value");
  assert.equal(setCookie.length, 2);
  setSessionCookie(reply, "replacement-token", new Date(Date.now() + 60_000).toISOString());
  assert.equal(setCookie.length, 2);
  clearSessionCookie(reply);
  assert.equal(setCookie.length, 3);

  assert.equal(sessionToken({ headers: { cookie: "imagora_session=cookie-token" } }), "cookie-token");
  process.env.ALLOW_BEARER_SESSION_AUTH = "false";
  assert.throws(() => sessionToken({ headers: { authorization: "Bearer bearer-token" } }), /disabled/);
  process.env.ALLOW_BEARER_SESSION_AUTH = "true";
  assert.equal(sessionToken({ headers: { authorization: "Bearer bearer-token" } }), "bearer-token");
  assert.equal(sessionToken({ headers: {} }, true), "");
  assert.throws(() => sessionToken({ headers: {} }), /Missing session token/);
});

test("email verification guard accepts verified users and rejects unverified users when enabled", () => {
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
  assert.doesNotThrow(() => assertEmailVerified({ emailVerifiedAt: new Date().toISOString() }));
  assert.throws(() => assertEmailVerified({ emailVerifiedAt: null }), /Email verification is required/);
  process.env.REQUIRE_EMAIL_VERIFICATION = "false";
  assert.doesNotThrow(() => assertEmailVerified({ emailVerifiedAt: null }));
});

test("authentication runtime enforces active sessions and admin roles", async () => {
  const now = Date.now();
  const data = {
    sessions: [
      { token: "user-token", userId: "user-1", expiresAt: new Date(now + 60_000).toISOString() },
      { token: "admin-token", userId: "admin-1", expiresAt: new Date(now + 60_000).toISOString() },
      { token: "expired-token", userId: "user-1", expiresAt: new Date(now - 60_000).toISOString() }
    ],
    users: [
      { id: "user-1", status: "ACTIVE", role: "USER" },
      { id: "admin-1", status: "ACTIVE", role: "ADMIN" }
    ]
  };
  const runtime = createAuthRuntime({
    async read() {
      return JSON.parse(JSON.stringify(data));
    }
  });
  assert.equal((await runtime.requireAuth({ headers: { cookie: "imagora_session=user-token" } })).user.id, "user-1");
  assert.equal((await runtime.requireAdmin({ headers: { cookie: "imagora_session=admin-token" } })).user.id, "admin-1");
  await assert.rejects(runtime.requireAdmin({ headers: { cookie: "imagora_session=user-token" } }), /Admin role/);
  await assert.rejects(
    runtime.requireAuth({ headers: { cookie: "imagora_session=expired-token" } }),
    /Invalid or expired/
  );
  const inactiveRuntime = createAuthRuntime({
    async read() {
      return { sessions: data.sessions, users: [{ id: "user-1", status: "SUSPENDED", role: "USER" }] };
    }
  });
  await assert.rejects(
    inactiveRuntime.requireAuth({ headers: { cookie: "imagora_session=user-token" } }),
    /not active/
  );
});
