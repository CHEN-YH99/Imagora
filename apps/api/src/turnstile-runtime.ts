import { AppError } from "@imagora/shared";
import { envString } from "./runtime.js";

/**
 * 验证码提供方切换。
 *
 * - `builtin`：仓库自带的 SVG 点选验证码（多轮），可被脚本 100% 破解，仅供本地开发/测试兜底。
 * - `turnstile`：Cloudflare Turnstile，前端渲染 widget 拿 token，后端调 siteverify 校验。
 *
 * 生产强制 `turnstile`（见 production-config.ts）。默认 builtin，保证无 key 的本地/CI 环境照常跑。
 */
export type CaptchaMode = "builtin" | "turnstile";

export function captchaMode(): CaptchaMode {
  const value = (process.env.CAPTCHA_PROVIDER ?? "builtin").trim().toLowerCase();
  return value === "turnstile" ? "turnstile" : "builtin";
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileVerifyResponse {
  success?: boolean;
  "error-codes"?: string[];
  action?: string;
  cdata?: string;
  hostname?: string;
}

/**
 * 向 Cloudflare 校验一个 Turnstile token。
 *
 * 校验失败（token 无效/过期/重放、密钥错、网络异常）一律抛 CAPTCHA_INVALID，
 * 让 auth 路由拒绝这次注册/登录。约定：token 一次性，Cloudflare 侧对同一 token 二次校验会失败，
 * 天然防重放，无需本地额外记账。
 *
 * @param remoteIp 可选，透传客户端 IP 给 Cloudflare 做风控（拿不到就不传）。
 */
export async function verifyTurnstileToken(token: string | undefined, remoteIp?: string | null): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw new AppError("CAPTCHA_REQUIRED", "Turnstile verification is required", 400);
  }
  const secret = envString("TURNSTILE_SECRET_KEY", "");
  if (!secret) {
    // 配成 turnstile 模式却没给密钥属于部署错配。生产会在启动期被 production-config 拦下；
    // 这里是非生产误配的兜底，明确报错而不是静默放行。
    throw new AppError("CAPTCHA_INVALID", "Turnstile secret key is not configured", 500);
  }

  const timeoutMs = Number(process.env.TURNSTILE_TIMEOUT_MS ?? 10_000);
  const body = new URLSearchParams({ secret, response: token.trim() });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  } catch (error) {
    // 校验服务不可达时 fail-closed：宁可拒绝本次登录/注册，也不放行未验证流量。
    throw new AppError(
      "CAPTCHA_INVALID",
      `Turnstile verification failed: ${error instanceof Error ? error.message : "network error"}`,
      400
    );
  }

  const payload = (await response.json().catch(() => ({}))) as TurnstileVerifyResponse;
  if (!response.ok || payload.success !== true) {
    const codes = Array.isArray(payload["error-codes"]) ? payload["error-codes"].join(",") : "unknown";
    throw new AppError("CAPTCHA_INVALID", `Turnstile verification rejected (${codes})`, 400);
  }
}

/**
 * 下发给前端的 Turnstile 客户端配置。
 *
 * siteKey 是公开值（本来就要嵌进前端页面），可安全下发；secret 只在服务端用。
 * builtin 模式返回 enabled:false，前端据此回退到内置 SVG 验证码。
 */
export function turnstileConfigForClient(): { enabled: boolean; siteKey: string } {
  if (captchaMode() !== "turnstile") {
    return { enabled: false, siteKey: "" };
  }
  return { enabled: true, siteKey: envString("TURNSTILE_SITE_KEY", "") };
}
