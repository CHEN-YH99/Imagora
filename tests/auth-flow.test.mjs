import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 全链路 auth 测试：用 app.inject 跑注册→登录→改密→令牌重试→登出其他设备→注销。
// 关键前置（必须在 import main.js 之前设好，因为很多副作用在模块加载时就触发）：
// - API_NO_LISTEN：只构建 app、不监听端口、不起后台定时器
// - IMAGORA_STORE_PATH：把数据指向临时文件，不污染真实 data
// - EXPOSE_CAPTCHA_ANSWER_FOR_TESTS：让 captcha 接口吐出答案，测试才能过图片验证
// - MAILER_PROVIDER=console：避免真连 SMTP
//
// 用例隔离原则：任何会改密码/注销的用例都用自己的独立邮箱注册，绝不共享密码状态；
// 只有纯读取（登录、令牌重试）的用例才复用 TEST_EMAIL，且 delete-account 放最后。

const storeDir = await mkdtemp(join(tmpdir(), "imagora-auth-test-"));
process.env.API_NO_LISTEN = "true";
process.env.NODE_ENV = "test";
process.env.IMAGORA_STORE_PATH = join(storeDir, "store.json");
process.env.EXPOSE_CAPTCHA_ANSWER_FOR_TESTS = "true";
process.env.MAILER_PROVIDER = "console";
process.env.RATE_LIMIT_PROVIDER = "memory";
// 限流额度调高，避免多用例跑下来撞到限流。
process.env.RATE_LIMIT_AUTH_MAX = "1000";
process.env.RATE_LIMIT_CAPTCHA_MAX = "1000";
process.env.RATE_LIMIT_PASSWORD_RESET_MAX = "1000";
// 重发冷却缩到 1 秒，测试才能在窗口过后验证“能再次重发”。
process.env.RESEND_VERIFICATION_COOLDOWN_SECONDS = "1";

const { app } = await import("../apps/api/dist/main.js");
await app.ready();

test.after(async () => {
  await app.close();
  await rm(storeDir, { recursive: true, force: true });
});

// ---- 辅助 ----

// inject 不带 cookie jar，自己维护一个简单的 name=value 映射。
function makeJar() {
  return new Map();
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

// 把响应的 set-cookie 合并进 jar，处理过期（Expires=1970 或空值视为删除）。
function absorbCookies(jar, response) {
  const raw = response.headers["set-cookie"];
  if (!raw) {
    return;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => /expires=/i.test(a) && /1970/.test(a));
    if (expired || value === "") {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

async function inject(jar, opts) {
  const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
  const cookies = cookieHeader(jar);
  if (cookies) {
    headers.cookie = cookies;
  }
  const response = await app.inject({
    method: opts.method,
    url: opts.url,
    headers,
    payload: opts.payload
  });
  absorbCookies(jar, response);
  return response;
}

function body(response) {
  return response.json();
}

// 走完整两轮图片验证，返回两个 verificationId。
async function solveCaptcha(jar) {
  const ids = [];
  for (let round = 0; round < 2; round += 1) {
    const challengeRes = await inject(jar, { method: "GET", url: "/api/auth/captcha" });
    assert.equal(challengeRes.statusCode, 200, "captcha challenge should return 200");
    const challenge = body(challengeRes).data;
    assert.ok(Array.isArray(challenge.answer), "test mode must expose captcha answer");
    const verifyRes = await inject(jar, {
      method: "POST",
      url: "/api/auth/captcha/verify",
      payload: { captchaId: challenge.captchaId, captchaSelections: challenge.answer }
    });
    assert.equal(verifyRes.statusCode, 200, "captcha verify should return 200");
    ids.push(body(verifyRes).data.verificationId);
  }
  return ids;
}

// 注册一个独立用户并返回其已登录的 jar（携带 session cookie）。
async function registerUser(email, password) {
  const jar = makeJar();
  const res = await inject(jar, {
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password }
  });
  assert.equal(res.statusCode, 201, `register ${email} should return 201`);
  return jar;
}

// 用邮箱+密码走完整验证码流程登录，返回带 session cookie 的 jar。
async function loginUser(email, password) {
  const jar = makeJar();
  const ids = await solveCaptcha(jar);
  const res = await inject(jar, {
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password, captchaVerificationIds: ids }
  });
  assert.equal(res.statusCode, 200, `login ${email} should succeed`);
  assert.ok(jar.has("imagora_session"), "login should set a session cookie");
  return jar;
}

// ---- 共享账号（只被“不改密码”的用例读取；delete-account 用例最后回收）----

const TEST_EMAIL = "flow-user@example.com";
const PASSWORD_1 = "FlowPass123abc";

// ---- 用例 ----

test("register creates an active session", async () => {
  const jar = makeJar();
  const res = await inject(jar, {
    method: "POST",
    url: "/api/auth/register",
    payload: { email: TEST_EMAIL, password: PASSWORD_1 }
  });
  assert.equal(res.statusCode, 201, "register should return 201");
  const data = body(res).data;
  assert.equal(data.user.email, TEST_EMAIL);
  assert.ok(jar.has("imagora_session"), "register should set a session cookie");

  // 带 cookie 应能拿到自己
  const meRes = await inject(jar, { method: "GET", url: "/api/auth/me" });
  assert.equal(meRes.statusCode, 200);
  assert.equal(body(meRes).data.user.email, TEST_EMAIL);
});

test("login requires captcha and succeeds with valid rounds", async () => {
  const jar = makeJar();
  const ids = await solveCaptcha(jar);
  const res = await inject(jar, {
    method: "POST",
    url: "/api/auth/login",
    payload: { email: TEST_EMAIL, password: PASSWORD_1, captchaVerificationIds: ids }
  });
  assert.equal(res.statusCode, 200, "login should succeed");
  assert.ok(jar.has("imagora_session"), "login should set a session cookie");
});

test("login without captcha is rejected", async () => {
  const jar = makeJar();
  const res = await inject(jar, {
    method: "POST",
    url: "/api/auth/login",
    payload: { email: TEST_EMAIL, password: PASSWORD_1 }
  });
  assert.equal(res.statusCode, 400, "login without captcha should be 400");
  assert.equal(body(res).error.code, "CAPTCHA_REQUIRED");
});

test("login attempt token lets a wrong password retry without redoing captcha", async () => {
  const jar = makeJar();
  const ids = await solveCaptcha(jar);
  // 第一次：验证码验过 + 密码错 → 401，但应签发尝试令牌 cookie
  const wrongRes = await inject(jar, {
    method: "POST",
    url: "/api/auth/login",
    payload: { email: TEST_EMAIL, password: "WrongPass999zzz", captchaVerificationIds: ids }
  });
  assert.equal(wrongRes.statusCode, 401, "wrong password should return 401");
  assert.ok(jar.has("imagora_login_attempt"), "a login attempt token should be issued");

  // 第二次：不带任何 verificationId，仅凭尝试令牌重试正确密码 → 应成功
  const retryRes = await inject(jar, {
    method: "POST",
    url: "/api/auth/login",
    payload: { email: TEST_EMAIL, password: PASSWORD_1 }
  });
  assert.equal(retryRes.statusCode, 200, "retry with attempt token should succeed without captcha");
  assert.ok(jar.has("imagora_session"), "successful retry should set a session cookie");
});

test("change-password rejects wrong current password and rotates sessions on success", async () => {
  // 自包含：独立邮箱，不碰共享账号密码。
  const email = "changepw-user@example.com";
  const pass1 = "ChangePass123abc";
  const pass2 = "ChangePass456xyz";
  await registerUser(email, pass1);
  const jar = await loginUser(email, pass1);

  // 错误旧密码 → 拒绝（接口对错误旧密码返回 400 INVALID_CURRENT_PASSWORD）
  const badRes = await inject(jar, {
    method: "POST",
    url: "/api/auth/change-password",
    payload: { currentPassword: "TotallyWrong123", newPassword: pass2 }
  });
  assert.equal(badRes.statusCode, 400);
  assert.equal(body(badRes).error.code, "INVALID_CURRENT_PASSWORD");

  // 正确旧密码 → 成功，且当前会话被换新（仍然有效）
  const okRes = await inject(jar, {
    method: "POST",
    url: "/api/auth/change-password",
    payload: { currentPassword: pass1, newPassword: pass2 }
  });
  assert.equal(okRes.statusCode, 200, "change-password should succeed");

  // 换密后当前会话（新签发的）仍能访问 me
  const meRes = await inject(jar, { method: "GET", url: "/api/auth/me" });
  assert.equal(meRes.statusCode, 200, "rotated current session should still work");
});

test("old sessions are invalidated after password change", async () => {
  // 自包含：注册独立用户，两个会话（stale + active），active 改密后 stale 应失效。
  const email = "invalidate-user@example.com";
  const pass1 = "InvalidatePass123abc";
  const pass2 = "InvalidatePass456xyz";
  await registerUser(email, pass1);

  const staleJar = await loginUser(email, pass1);
  const activeJar = await loginUser(email, pass1);

  const changeRes = await inject(activeJar, {
    method: "POST",
    url: "/api/auth/change-password",
    payload: { currentPassword: pass1, newPassword: pass2 }
  });
  assert.equal(changeRes.statusCode, 200, "change-password should succeed");

  const staleMe = await inject(staleJar, { method: "GET", url: "/api/auth/me" });
  assert.equal(staleMe.statusCode, 401, "stale session should be invalidated after password change");
});

test("logout-others keeps current session and drops the rest", async () => {
  // 自包含：独立邮箱，两个会话，B 登出其他设备后 A 应失效。
  const email = "logout-others-user@example.com";
  const pass = "LogoutPass123abc";
  await registerUser(email, pass);

  const jarA = await loginUser(email, pass);
  const jarB = await loginUser(email, pass);

  const res = await inject(jarB, { method: "POST", url: "/api/auth/logout-others" });
  assert.equal(res.statusCode, 200);
  assert.ok(body(res).data.removed >= 1, "should remove at least one other session");

  // B 仍有效、A 失效
  assert.equal((await inject(jarB, { method: "GET", url: "/api/auth/me" })).statusCode, 200);
  assert.equal((await inject(jarA, { method: "GET", url: "/api/auth/me" })).statusCode, 401);
});

test("resend-verification enforces a per-user cooldown after registration", async () => {
  // 自包含：独立邮箱。注册时已签发一条 token（createdAt=now），
  // 立即重发必然落在冷却窗口内 → 应被 429 RESEND_TOO_SOON 挡下，不新发邮件。
  const email = "resend-cooldown-user@example.com";
  const pass = "ResendPass123abc";
  const jar = await registerUser(email, pass);

  const res = await inject(jar, { method: "POST", url: "/api/auth/resend-verification" });
  assert.equal(res.statusCode, 429, "resend right after register should hit the cooldown");
  assert.equal(body(res).error.code, "RESEND_TOO_SOON");

  // 冷却窗口（测试环境 1s）过后应能再次重发。
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const okRes = await inject(jar, { method: "POST", url: "/api/auth/resend-verification" });
  assert.equal(okRes.statusCode, 200, "resend after cooldown window should succeed");
});

test("delete-account soft-deletes, frees email, and blocks re-login", async () => {
  // 用共享账号收尾：注销 TEST_EMAIL，验证软删+邮箱释放。
  const jar = await loginUser(TEST_EMAIL, PASSWORD_1);

  const res = await inject(jar, {
    method: "POST",
    url: "/api/auth/delete-account",
    payload: { currentPassword: PASSWORD_1, reason: "test cleanup" }
  });
  assert.equal(res.statusCode, 200, "delete-account should succeed");

  // 注销后当前会话失效
  const meRes = await inject(jar, { method: "GET", url: "/api/auth/me" });
  assert.equal(meRes.statusCode, 401, "session should be cleared after deletion");

  // 原邮箱应已释放：可以用同邮箱重新注册
  const reJar = makeJar();
  const reRes = await inject(reJar, {
    method: "POST",
    url: "/api/auth/register",
    payload: { email: TEST_EMAIL, password: "RebornPass123abc" }
  });
  assert.equal(reRes.statusCode, 201, "email should be freed for re-registration after soft delete");
});
