import type { User } from "@imagora/shared";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerAuthRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    AppError,
    addDays,
    audit,
    buildVerificationEmail,
    captchaMode,
    captchaOptions,
    captchaRequiredRounds,
    captchaVerifySchema,
    changeEmailSchema,
    changePasswordSchema,
    clearLoginAttempt,
    clearSessionCookie,
    consumeLoginAttempt,
    createCaptchaChallenge,
    createHash,
    defaultNicknameForEmail,
    deleteAccountSchema,
    descCreated,
    envelope,
    envNumber,
    envString,
    exposeCaptchaAnswerForTests,
    hashCaptchaAnswer,
    hashPassword,
    issueLoginAttempt,
    loginSchema,
    mailer,
    mustFindCreditAccount,
    mustFindUser,
    paginationSchema,
    publicUser,
    randomUUID,
    registerSchema,
    requestPasswordResetSchema,
    requireAuth,
    resetPasswordSchema,
    saveCaptchaChallenge,
    saveCaptchaVerification,
    sessionToken,
    setSessionCookie,
    store,
    turnstileConfigForClient,
    updateProfileSchema,
    verifyCaptchaChallenge,
    verifyCaptchaVerifications,
    verifyPassword,
    verifyTurnstileToken,
    z
  } = context;

  // 前端据此决定渲染 Turnstile widget 还是内置 SVG 验证码。siteKey 可公开。
  app.get("/api/auth/captcha-config", async (request) => {
    return envelope(request, { mode: captchaMode(), turnstile: turnstileConfigForClient() });
  });

  app.get("/api/auth/captcha", async (request) => {
    const challenge = createCaptchaChallenge();
    const captchaId = randomUUID();
    const ttlMs = envNumber("CAPTCHA_TTL_SECONDS", 180) * 1000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await saveCaptchaChallenge(
      captchaId,
      {
        answerHash: hashCaptchaAnswer(challenge.answer),
        expiresAt,
        createdAt: new Date().toISOString()
      },
      ttlMs
    );
    return envelope(request, {
      captchaId,
      imageSvg: challenge.imageSvg,
      instruction: `请点击图中所有${challenge.targetLabel}`,
      targetLabel: challenge.targetLabel,
      requiredSelections: challenge.answer.length,
      optionCount: captchaOptions.length,
      expiresAt,
      ...(exposeCaptchaAnswerForTests() ? { answer: challenge.answer } : {})
    });
  });

  app.post("/api/auth/captcha/verify", async (request) => {
    const input = captchaVerifySchema.parse(request.body);
    await verifyCaptchaChallenge(input.captchaId, input.captchaSelections);
    const verificationId = randomUUID();
    const ttlMs = envNumber("CAPTCHA_VERIFICATION_TTL_SECONDS", 180) * 1000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await saveCaptchaVerification(verificationId, ttlMs);
    return envelope(request, { verificationId, expiresAt });
  });

  app.post("/api/auth/register", async (request, reply) => {
    const input = registerSchema.parse(request.body);
    // turnstile 模式：注册强制人机验证，堵住批量注册薅 120 迎新积分的正门。
    // builtin 模式下注册维持原样（无验证码），仅本地/测试使用。
    if (captchaMode() === "turnstile") {
      await verifyTurnstileToken(input.turnstileToken, request.ip);
    }
    const result = await store.update(async (data) => {
      const email = input.email.toLowerCase();
      if (data.users.some((user) => user.email === email)) {
        throw new AppError("CONFLICT", "Unable to create account with these credentials", 409);
      }
      const now = new Date().toISOString();
      const user: User = {
        id: randomUUID(),
        email,
        passwordHash: hashPassword(input.password),
        nickname: defaultNicknameForEmail(email),
        avatarUrl: null,
        emailVerifiedAt: null,
        role: "USER",
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now
      };
      const sessionToken = randomUUID();
      const verifyTokenPlain = randomUUID();
      const verifyTokenHash = createHash("sha256").update(verifyTokenPlain).digest("hex");
      const verifyTtlHours = envNumber("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24);
      const verifyExpiresAt = new Date(Date.now() + verifyTtlHours * 60 * 60 * 1000).toISOString();
      data.users.push(user);
      data.sessions.push({ token: sessionToken, userId: user.id, createdAt: now, expiresAt: addDays(now, 14) });
      data.emailVerificationTokens.push({
        id: randomUUID(),
        userId: user.id,
        tokenHash: verifyTokenHash,
        expiresAt: verifyExpiresAt,
        usedAt: null,
        createdAt: now
      });
      data.creditAccounts.push({ userId: user.id, balance: 120, totalEarned: 120, totalSpent: 0, updatedAt: now });
      data.creditLedgerEntries.push({
        id: randomUUID(),
        userId: user.id,
        type: "GRANT",
        amount: 120,
        balanceAfter: 120,
        sourceType: "SYSTEM",
        sourceId: "welcome",
        idempotencyKey: `welcome:${user.id}`,
        remark: "Welcome credits",
        createdAt: now,
        expiresAt: null
      });
      setSessionCookie(reply, sessionToken, addDays(now, 14));
      reply.status(201);
      return { user, verifyTokenPlain };
    });

    const verifyUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/verify-email?token=${result.verifyTokenPlain}`;
    // 发信成败通过 emailDelivered 透传给前端：失败时提示用户可稍后重发，不再假装一切正常。
    let emailDelivered = false;
    try {
      await mailer.sendEmail(
        buildVerificationEmail({ to: result.user.email, nickname: result.user.nickname, verifyUrl })
      );
      emailDelivered = true;
      request.log.info({ userId: result.user.id }, "Verification email sent");
    } catch (error) {
      request.log.error({ userId: result.user.id, error }, "Failed to send verification email");
    }

    return envelope(request, { user: publicUser(result.user), emailDelivered });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    // 两条放行路径：① 已有未耗尽的登录尝试令牌 → 扣一次额度直接放行；
    // ② 无有效令牌 → 必须提交两轮图片验证，验过后签发新令牌。
    const canReuseLoginAttempt = await consumeLoginAttempt(request);
    const canIssueLoginAttempt = !canReuseLoginAttempt;
    if (canReuseLoginAttempt) {
      // 走令牌路径：本次尝试无需重做人机验证。
    } else if (captchaMode() === "turnstile") {
      // turnstile 模式：无有效令牌则必须带上 Cloudflare token。token 一次性，前端每次登录取新的。
      await verifyTurnstileToken(input.turnstileToken, request.ip);
    } else {
      // builtin 模式：沿用进程内 SVG 多轮点选验证（本地/测试）。
      if (!input.captchaVerificationIds || input.captchaVerificationIds.length !== captchaRequiredRounds) {
        throw new AppError("CAPTCHA_REQUIRED", "Image verification is required", 400);
      }
      await verifyCaptchaVerifications(input.captchaVerificationIds);
    }

    const result = await store.update((data) => {
      const user = data.users.find((item) => item.email === input.email.toLowerCase());
      if (!user || !verifyPassword(input.password, user.passwordHash)) {
        return {
          ok: false as const,
          error: new AppError("UNAUTHORIZED", "Invalid email or password", 401)
        };
      }
      if (user.status !== "ACTIVE") {
        return {
          ok: false as const,
          error: new AppError("FORBIDDEN", "User is not active", 403)
        };
      }
      const now = new Date().toISOString();
      const token = randomUUID();
      const expiresAt = addDays(now, 14);
      user.lastLoginAt = now;
      user.updatedAt = now;
      data.sessions.push({ token, userId: user.id, createdAt: now, expiresAt });
      return { ok: true as const, user: publicUser(user), token, expiresAt };
    });

    if (!result.ok) {
      // 密码错误时保留已有令牌的剩余额度；首次验证码通过则在事务外签发新令牌。
      if (canIssueLoginAttempt) {
        await issueLoginAttempt(reply);
      }
      throw result.error;
    }

    try {
      // Redis I/O 放在 store 事务外；失败时撤销刚创建的会话，避免返回 503 却留下孤儿会话。
      await clearLoginAttempt(request, reply);
    } catch (error) {
      await store.update((data) => {
        data.sessions = data.sessions.filter((session) => session.token !== result.token);
      });
      throw error;
    }
    setSessionCookie(reply, result.token, result.expiresAt);
    return envelope(request, { user: result.user });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = sessionToken(request);
    await store.update((data) => {
      data.sessions = data.sessions.filter((session) => session.token !== token);
    });
    clearSessionCookie(reply);
    return envelope(request, { ok: true });
  });

  // 修改密码：必须校验旧密码，成功后签发新会话并踢掉其余会话，防止旧凭据继续有效。
  app.post("/api/auth/change-password", async (request, reply) => {
    const { user } = await requireAuth(request);
    const input = changePasswordSchema.parse(request.body);
    return store.update(async (data) => {
      const current = mustFindUser(data, user.id);
      if (!verifyPassword(input.currentPassword, current.passwordHash)) {
        throw new AppError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 400);
      }
      const now = new Date().toISOString();
      current.passwordHash = hashPassword(input.newPassword);
      current.updatedAt = now;
      // 清掉该用户的所有会话，再为当前请求签发一个新会话，避免用户在本设备上被强制登出。
      const newToken = randomUUID();
      data.sessions = data.sessions.filter((session) => session.userId !== user.id);
      data.sessions.push({ token: newToken, userId: user.id, createdAt: now, expiresAt: addDays(now, 14) });
      setSessionCookie(reply, newToken, addDays(now, 14));
      request.log.info({ userId: user.id }, "Password changed");
      return envelope(request, { ok: true, message: "Password changed successfully" });
    });
  });

  // 修改邮箱：校验密码 + 查重，换邮箱后重置验证状态并发送新的验证邮件。
  app.post("/api/auth/change-email", async (request) => {
    const { user } = await requireAuth(request);
    const input = changeEmailSchema.parse(request.body);
    const result = await store.update(async (data) => {
      const current = mustFindUser(data, user.id);
      if (!verifyPassword(input.currentPassword, current.passwordHash)) {
        throw new AppError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 400);
      }
      const nextEmail = input.newEmail.toLowerCase();
      if (nextEmail === current.email) {
        throw new AppError("VALIDATION_ERROR", "New email is the same as the current email", 400);
      }
      if (data.users.some((item) => item.id !== current.id && item.email === nextEmail)) {
        throw new AppError("CONFLICT", "Unable to update email with this address", 409);
      }
      const now = new Date().toISOString();
      current.email = nextEmail;
      current.emailVerifiedAt = null;
      current.updatedAt = now;

      const verifyTokenPlain = randomUUID();
      const verifyTokenHash = createHash("sha256").update(verifyTokenPlain).digest("hex");
      const verifyTtlHours = envNumber("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24);
      const verifyExpiresAt = new Date(Date.now() + verifyTtlHours * 60 * 60 * 1000).toISOString();
      data.emailVerificationTokens = data.emailVerificationTokens.filter((t) => t.userId !== current.id || t.usedAt);
      data.emailVerificationTokens.push({
        id: randomUUID(),
        userId: current.id,
        tokenHash: verifyTokenHash,
        expiresAt: verifyExpiresAt,
        usedAt: null,
        createdAt: now
      });
      return { user: current, verifyTokenPlain };
    });

    const verifyUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/verify-email?token=${result.verifyTokenPlain}`;
    try {
      await mailer.sendEmail(
        buildVerificationEmail({ to: result.user.email, nickname: result.user.nickname, verifyUrl })
      );
      request.log.info({ userId: result.user.id }, "Verification email sent after email change");
    } catch (error) {
      request.log.error({ userId: result.user.id, error }, "Failed to send verification email after email change");
    }
    return envelope(request, { user: publicUser(result.user) });
  });

  // 会话列表：展示当前用户所有有效会话，并标记当前请求所在会话。
  app.get("/api/auth/sessions", async (request) => {
    const { user, data } = await requireAuth(request);
    const currentToken = sessionToken(request);
    const sessions = data.sessions
      .filter((session) => session.userId === user.id)
      .sort(descCreated)
      .map((session) => ({
        id: createHash("sha256").update(session.token).digest("hex").slice(0, 24),
        current: session.token === currentToken,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt
      }));
    return envelope(request, { sessions });
  });

  // 登出其他所有设备：只保留当前会话，清掉该用户其余会话。
  app.post("/api/auth/logout-others", async (request) => {
    const { user } = await requireAuth(request);
    const currentToken = sessionToken(request);
    const removed = await store.update((data) => {
      const before = data.sessions.length;
      data.sessions = data.sessions.filter((session) => session.userId !== user.id || session.token === currentToken);
      return before - data.sessions.length;
    });
    request.log.info({ userId: user.id, removed }, "Logged out other sessions");
    return envelope(request, { ok: true, removed });
  });

  // 注销账户：软删（status=DELETED），墓碑化邮箱以释放原邮箱供重新注册，清会话并审计留档。
  // 积分/订单等数据保留不动，仅停用账户；requireAuth 会自动拦截非 ACTIVE 账户。
  app.post("/api/auth/delete-account", async (request, reply) => {
    const { user } = await requireAuth(request);
    const input = deleteAccountSchema.parse(request.body);
    await store.update((data) => {
      const current = mustFindUser(data, user.id);
      if (!verifyPassword(input.currentPassword, current.passwordHash)) {
        throw new AppError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 401);
      }
      if (current.role === "ADMIN") {
        const otherActiveAdmins = data.users.filter(
          (item) => item.id !== current.id && item.role === "ADMIN" && item.status === "ACTIVE"
        );
        if (otherActiveAdmins.length === 0) {
          throw new AppError("VALIDATION_ERROR", "Cannot remove the last active administrator", 400);
        }
      }
      const now = new Date().toISOString();
      const originalEmail = current.email;
      // 墓碑化邮箱：把原邮箱挪到一个不可登录的占位地址，释放原邮箱供他人/本人重新注册。
      const tombstoneEmail = `deleted+${current.id}@deleted.imagora.local`;
      const before = { email: originalEmail, status: current.status };
      current.email = tombstoneEmail;
      current.status = "DELETED";
      current.updatedAt = now;
      // 清掉该用户所有会话，注销后立即失效。
      data.sessions = data.sessions.filter((session) => session.userId !== current.id);
      // 清理未使用的验证/重置令牌，避免遗留可用凭据。
      data.emailVerificationTokens = data.emailVerificationTokens.filter((t) => t.userId !== current.id);
      data.passwordResetTokens = data.passwordResetTokens.filter((t) => t.userId !== current.id);
      audit(
        data,
        current.id,
        "account.self-delete",
        "USER",
        current.id,
        input.reason ?? null,
        before,
        { email: tombstoneEmail, status: "DELETED" },
        request
      );
      request.log.info({ userId: current.id }, "Account self-deleted");
    });
    clearSessionCookie(reply);
    return envelope(request, { ok: true });
  });

  app.post("/api/auth/request-password-reset", async (request) => {
    const input = requestPasswordResetSchema.parse(request.body);
    const data = await store.read();
    const user = data.users.find((u) => u.email === input.email.toLowerCase());

    // Always return success to prevent email enumeration
    if (!user) {
      return envelope(request, { ok: true, message: "If email exists, reset link will be sent" });
    }

    return store.update(async (data) => {
      const now = new Date().toISOString();
      const ttlMinutes = envNumber("PASSWORD_RESET_TOKEN_TTL_MINUTES", 30);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const resetToken = randomUUID();
      const tokenHash = createHash("sha256").update(resetToken).digest("hex");

      // Clean up old reset tokens for this user
      data.passwordResetTokens = data.passwordResetTokens.filter(
        (t) => t.userId !== user.id || new Date(t.expiresAt) > new Date()
      );

      // Add new reset token
      data.passwordResetTokens.push({
        id: randomUUID(),
        userId: user.id,
        tokenHash,
        expiresAt,
        usedAt: null,
        createdAt: now
      });

      // Send reset email
      const resetUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/reset-password?token=${resetToken}`;
      try {
        await mailer.sendEmail({
          to: user.email,
          subject: "重置您的 Imagora 密码",
          text: `您好，\n\n请点击以下链接重置您的密码（${ttlMinutes} 分钟内有效）：\n\n${resetUrl}\n\n如果您没有请求重置密码，请忽略此邮件。\n\nImagora 团队`,
          html: `
          <p>您好，</p>
          <p>请点击以下链接重置您的密码（${ttlMinutes} 分钟内有效）：</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>如果您没有请求重置密码，请忽略此邮件。</p>
          <p>Imagora 团队</p>
        `
        });
        request.log.info({ userId: user.id }, "Password reset email sent");
      } catch (error) {
        request.log.error({ userId: user.id, error }, "Failed to send password reset email");
        // Don't throw - continue silently to prevent email enumeration
      }

      return envelope(request, { ok: true, message: "If email exists, reset link will be sent" });
    });
  });

  app.post("/api/auth/reset-password", async (request) => {
    const input = resetPasswordSchema.parse(request.body);

    const data = await store.read();
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const resetToken = data.passwordResetTokens.find((t) => t.tokenHash === tokenHash && !t.usedAt);

    if (!resetToken || new Date(resetToken.expiresAt) < new Date()) {
      throw new AppError("INVALID_RESET_TOKEN", "Invalid or expired reset token", 400);
    }

    return store.update(async (data) => {
      const user = mustFindUser(data, resetToken.userId);
      const now = new Date().toISOString();

      user.passwordHash = hashPassword(input.password);
      user.updatedAt = now;

      // Mark token as used
      const token = data.passwordResetTokens.find((t) => t.tokenHash === tokenHash);
      if (token) {
        token.usedAt = now;
      }

      // Invalidate all existing sessions for security
      data.sessions = data.sessions.filter((s) => s.userId !== user.id);

      request.log.info({ userId: user.id }, "Password reset completed");

      return envelope(request, {
        ok: true,
        message: "Password reset successfully. Please login with your new password."
      });
    });
  });

  app.post("/api/auth/verify-email", async (request) => {
    const input = z.object({ token: z.string().min(1) }).parse(request.body);
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const data = await store.read();
    const verifyToken = data.emailVerificationTokens.find((t) => t.tokenHash === tokenHash && !t.usedAt);
    if (!verifyToken || new Date(verifyToken.expiresAt) < new Date()) {
      throw new AppError("INVALID_VERIFY_TOKEN", "Invalid or expired verification token", 400);
    }
    return store.update(async (data) => {
      const user = mustFindUser(data, verifyToken.userId);
      const now = new Date().toISOString();
      user.emailVerifiedAt = now;
      user.updatedAt = now;
      const token = data.emailVerificationTokens.find((t) => t.tokenHash === tokenHash);
      if (token) {
        token.usedAt = now;
      }
      request.log.info({ userId: user.id }, "Email verified");
      return envelope(request, { ok: true, email: user.email });
    });
  });

  app.post("/api/auth/resend-verification", async (request) => {
    const { user } = await requireAuth(request);
    if (user.emailVerifiedAt) {
      return envelope(request, { ok: true, message: "Email is already verified" });
    }
    return store.update(async (data) => {
      // 重发冷却：同一用户两次重发至少间隔 RESEND_VERIFICATION_COOLDOWN_SECONDS（默认 60s），
      // 防连点轰炸收件箱、省邮件配额。此处尚无写入，抛错回滚无副作用。
      const cooldownSeconds = envNumber("RESEND_VERIFICATION_COOLDOWN_SECONDS", 60);
      const lastToken = data.emailVerificationTokens
        .filter((t) => t.userId === user.id && !t.usedAt)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (lastToken) {
        const elapsedMs = Date.now() - new Date(lastToken.createdAt).getTime();
        const remainingMs = cooldownSeconds * 1000 - elapsedMs;
        if (remainingMs > 0) {
          throw new AppError(
            "RESEND_TOO_SOON",
            "Verification email was sent recently, please wait before retrying",
            429,
            {
              retryAfterSeconds: Math.ceil(remainingMs / 1000)
            }
          );
        }
      }
      const now = new Date().toISOString();
      const verifyTokenPlain = randomUUID();
      const verifyTokenHash = createHash("sha256").update(verifyTokenPlain).digest("hex");
      const verifyTtlHours = envNumber("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24);
      const verifyExpiresAt = new Date(Date.now() + verifyTtlHours * 60 * 60 * 1000).toISOString();
      data.emailVerificationTokens = data.emailVerificationTokens.filter((t) => t.userId !== user.id || t.usedAt);
      data.emailVerificationTokens.push({
        id: randomUUID(),
        userId: user.id,
        tokenHash: verifyTokenHash,
        expiresAt: verifyExpiresAt,
        usedAt: null,
        createdAt: now
      });
      const verifyUrl = `${envString("WEB_ORIGIN", "http://127.0.0.1:3100")}/verify-email?token=${verifyTokenPlain}`;
      try {
        await mailer.sendEmail(buildVerificationEmail({ to: user.email, nickname: user.nickname, verifyUrl }));
        request.log.info({ userId: user.id }, "Verification email resent");
      } catch (error) {
        request.log.error({ userId: user.id, error }, "Failed to resend verification email");
      }
      return envelope(request, { ok: true, message: "Verification email sent" });
    });
  });

  app.get("/api/auth/me", async (request) => {
    const { user } = await requireAuth(request);
    return envelope(request, { user: publicUser(user) });
  });

  app.get("/api/users/me", async (request) => {
    const { user } = await requireAuth(request);
    return envelope(request, { user: publicUser(user) });
  });

  app.patch("/api/users/me", async (request) => {
    const { user } = await requireAuth(request);
    const input = updateProfileSchema.parse(request.body);
    return store.update(async (data) => {
      const current = mustFindUser(data, user.id);
      current.nickname = input.nickname ?? current.nickname;
      current.avatarUrl = input.avatarUrl ?? current.avatarUrl;
      current.updatedAt = new Date().toISOString();
      return envelope(request, { user: publicUser(current) });
    });
  });

  app.get("/api/users/me/credits", async (request) => {
    const { user, data } = await requireAuth(request);
    const account = mustFindCreditAccount(data, user.id);
    return envelope(request, { account });
  });

  app.get("/api/users/me/credit-ledger", async (request) => {
    const { user, data } = await requireAuth(request);
    const query = paginationSchema.parse(request.query);
    const entries = data.creditLedgerEntries
      .filter((entry) => entry.userId === user.id)
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { entries });
  });

  app.get("/api/users/me/safety-events", async (request) => {
    const { user, data } = await requireAuth(request);
    const query = paginationSchema.parse(request.query);
    const events = data.safetyEvents
      .filter((event) => event.userId === user.id)
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { events });
  });
}
