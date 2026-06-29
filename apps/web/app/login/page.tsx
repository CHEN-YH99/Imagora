"use client";

import { type FormEvent, type MouseEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LogIn, RefreshCw, UserRound } from "lucide-react";
import {
  getLoginCaptcha,
  login,
  verifyLoginCaptcha,
  type CaptchaChallenge,
  type CaptchaSelection
} from "../../lib/api";

const requiredCaptchaRounds = 2;

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
          <p className="text-sm text-white/60">加载中...</p>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaSelections, setCaptchaSelections] = useState<CaptchaSelection[]>([]);
  const [captchaVerificationIds, setCaptchaVerificationIds] = useState<string[]>([]);
  const [acceptLoginRules, setAcceptLoginRules] = useState(false);
  const [captchaPanelOpen, setCaptchaPanelOpen] = useState(false);
  const [captchaVerifying, setCaptchaVerifying] = useState(false);
  const [message, setMessage] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void refreshCaptcha();
  }, []);

  async function refreshCaptcha() {
    setCaptchaLoading(true);
    setCaptchaSelections([]);
    try {
      setCaptcha(await getLoginCaptcha());
    } catch (error) {
      setCaptcha(null);
      setMessage(error instanceof Error ? error.message : "图片验证加载失败，请刷新后重试。");
    } finally {
      setCaptchaLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationMessage = validateLoginForm(email, password, captchaVerificationIds, acceptLoginRules);
    if (validationMessage) {
      setMessage(validationMessage);
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      await login(email.trim().toLowerCase(), password, captchaVerificationIds);
      router.push(safeNextPath(searchParams.get("next")) ?? "/generate");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败，请检查账号信息后重试。");
      setCaptchaVerificationIds([]);
      await refreshCaptcha();
    } finally {
      setLoading(false);
    }
  }

  function handleCaptchaClick(event: MouseEvent<HTMLButtonElement>) {
    if (!captcha || captchaLoading || loading) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    setCaptchaSelections((current) => {
      const next = [...current, { x, y }];
      return next.slice(0, Math.max(captcha.requiredSelections, 1));
    });
    setMessage("");
  }

  function openCaptchaPanel() {
    if (!acceptLoginRules) {
      setMessage("请先阅读并勾选登录安全准则。");
      return;
    }
    setCaptchaPanelOpen(true);
    setMessage("");
  }

  async function checkCaptchaRound() {
    if (!captcha || captchaSelections.length < captcha.requiredSelections) {
      setMessage("请先按提示点完所有目标。");
      return;
    }
    setCaptchaVerifying(true);
    setMessage("");
    try {
      const verification = await verifyLoginCaptcha(captcha.captchaId, captchaSelections);
      const nextVerificationIds = [...captchaVerificationIds, verification.verificationId].slice(
        0,
        requiredCaptchaRounds
      );
      setCaptchaVerificationIds(nextVerificationIds);
      if (nextVerificationIds.length >= requiredCaptchaRounds) {
        setCaptcha(null);
        setCaptchaSelections([]);
        setCaptchaPanelOpen(false);
      } else {
        await refreshCaptcha();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片验证失败，请重新尝试。");
      await refreshCaptcha();
    } finally {
      setCaptchaVerifying(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
      <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6">
        <Link
          className="focus-ring inline-flex items-center gap-2 rounded-full text-white/70 hover:text-white"
          href="/"
        >
          <UserRound className="size-5" aria-hidden="true" />
          Imagora
        </Link>
        <h1 className="mt-6 text-3xl font-semibold">登录</h1>
        <p className="mt-2 text-sm leading-6 text-white/62">登录后可保存生成历史、下载图片、管理收藏并使用账户积分。</p>
        <form className="mt-6 space-y-4" noValidate onSubmit={submit}>
          <label className="block text-sm text-white/70">
            邮箱
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              maxLength={254}
              required
              type="email"
            />
          </label>
          <label className="block text-sm text-white/70">
            密码
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              maxLength={128}
              required
              type="password"
            />
          </label>
          <div className="space-y-3 rounded-2xl border border-white/12 bg-black/18 p-4 text-sm text-white/70">
            <label className="flex items-start gap-3">
              <input
                checked={acceptLoginRules}
                className="mt-1 size-4 accent-mint"
                onChange={(event) => setAcceptLoginRules(event.target.checked)}
                type="checkbox"
              />
              <span>我已阅读并同意登录安全准则，确认本次登录由本人操作。</span>
            </label>
            <button
              className="focus-ring w-full rounded-2xl border border-mint/60 bg-mint/12 px-4 py-3 text-left font-semibold text-mint transition-colors duration-200 hover:bg-mint/18 disabled:cursor-not-allowed disabled:border-white/12 disabled:bg-white/5 disabled:text-white/38"
              disabled={!acceptLoginRules || loading}
              onClick={openCaptchaPanel}
              type="button"
            >
              {captchaVerificationIds.length >= requiredCaptchaRounds
                ? "图片验证已完成"
                : captchaVerificationIds.length > 0
                  ? "继续完成图片验证"
                  : "点击文字进行图片验证"}
            </button>
            <p className="text-xs leading-5 text-white/48">
              必须先勾选安全准则，并连续通过 {requiredCaptchaRounds} 次随机图片验证，系统才会放行登录。
            </p>
          </div>
          {captchaPanelOpen ? (
            <div
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6"
              role="dialog"
            >
              <div className="w-full max-w-xl rounded-2xl border border-white/12 bg-ink p-5 shadow-2xl">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-white">图片验证</h2>
                    <p className="mt-1 text-sm text-white/56">
                      第 {Math.min(captchaVerificationIds.length + 1, requiredCaptchaRounds)}/{requiredCaptchaRounds}{" "}
                      次：
                      {captcha?.instruction ?? "请先加载图片验证。"}
                    </p>
                  </div>
                  {captcha ? (
                    <span className="text-xs text-white/48">
                      已选择 {captchaSelections.length}/{captcha.requiredSelections}
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                  <button
                    aria-label={captcha?.instruction ?? "图片验证"}
                    className="focus-ring relative flex aspect-[18/13] cursor-pointer select-none items-center justify-center overflow-hidden rounded-2xl border border-white/12 bg-white disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={!captcha || captchaLoading || loading || captchaVerifying}
                    onClick={handleCaptchaClick}
                    type="button"
                  >
                    {captcha?.imageSvg ? (
                      <>
                        <img
                          alt={captcha.instruction}
                          className="h-full w-full object-contain"
                          draggable={false}
                          src={`data:image/svg+xml;utf8,${encodeURIComponent(captcha.imageSvg)}`}
                        />
                        {captchaSelections.map((selection, index) => (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-mint text-xs font-bold leading-5 text-ink shadow-lg"
                            key={`${selection.x}-${selection.y}-${index}`}
                            style={{ left: `${selection.x * 100}%`, top: `${selection.y * 100}%` }}
                          >
                            {index + 1}
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="text-sm text-ink/60">{captchaLoading ? "加载中..." : "加载失败"}</span>
                    )}
                  </button>
                  <button
                    aria-label="刷新图片验证"
                    className="focus-ring inline-flex size-[72px] items-center justify-center rounded-2xl border border-white/12 bg-black/28 text-white/70 hover:text-mint disabled:opacity-60"
                    disabled={captchaLoading || loading || captchaVerifying}
                    onClick={() => void refreshCaptcha()}
                    type="button"
                  >
                    <RefreshCw className="size-5" aria-hidden="true" />
                  </button>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <button
                    className="focus-ring rounded-full border border-white/12 px-4 py-2 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-60"
                    disabled={loading || captchaVerifying || captchaSelections.length === 0}
                    onClick={() => setCaptchaSelections([])}
                    type="button"
                  >
                    清空
                  </button>
                  <div className="flex gap-2">
                    <button
                      className="focus-ring rounded-full border border-white/12 px-4 py-2 text-white/70 hover:bg-white/10 hover:text-white"
                      onClick={() => setCaptchaPanelOpen(false)}
                      type="button"
                    >
                      关闭
                    </button>
                    <button
                      className="focus-ring rounded-full bg-mint px-4 py-2 font-semibold text-ink hover:bg-volt disabled:opacity-60"
                      disabled={!captcha || captchaSelections.length < captcha.requiredSelections || captchaVerifying}
                      onClick={() => void checkCaptchaRound()}
                      type="button"
                    >
                      {captchaVerifying ? "检查中..." : "检查"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Link className="text-sm text-white/56 hover:text-mint" href="/forgot-password">
              忘记密码？
            </Link>
          </div>
          {message ? (
            <p
              aria-live="polite"
              className="rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember"
              role="alert"
            >
              {message}
            </p>
          ) : null}
          <button
            className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
            type="submit"
            disabled={
              loading ||
              captchaLoading ||
              !acceptLoginRules ||
              !email.trim() ||
              !password ||
              captchaVerificationIds.length < requiredCaptchaRounds
            }
          >
            <LogIn className="size-4" aria-hidden="true" />
            {loading ? "登录中..." : "登录"}
          </button>
          <p className="text-center text-sm text-white/56">
            还没有账号？{" "}
            <Link className="text-mint hover:text-volt" href="/register">
              注册
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}

function validateLoginForm(
  email: string,
  password: string,
  captchaVerificationIds: string[],
  acceptLoginRules: boolean
): string | null {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) {
    return "请输入邮箱。";
  }
  if (normalizedEmail.length > 254 || !isEmailLike(normalizedEmail)) {
    return "请输入有效的邮箱地址。";
  }
  if (!password) {
    return "请输入密码。";
  }
  if (password.length > 128) {
    return "密码长度不能超过 128 位。";
  }
  if (!acceptLoginRules) {
    return "请先阅读并勾选登录安全准则。";
  }
  if (captchaVerificationIds.length < requiredCaptchaRounds) {
    return `请先完成 ${requiredCaptchaRounds} 次图片验证。`;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeNextPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  return value;
}
