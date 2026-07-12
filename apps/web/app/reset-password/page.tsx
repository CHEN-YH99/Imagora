"use client";

import { type FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { PasswordInput } from "../../components/PasswordInput";

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
          <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6">
            <p className="text-sm text-white/60">加载中...</p>
          </section>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const tokenParam = searchParams.get("token");
    if (!tokenParam) {
      setMessage("重置链接无效，请重新申请。");
    } else {
      setToken(tokenParam);
    }
  }, [searchParams]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationMessage = validateResetPasswordForm(token, password, confirmPassword);
    if (validationMessage) {
      setMessage(validationMessage);
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      await apiFetch<{ ok: boolean; message: string }>("/api/auth/reset-password", {
        method: "POST",
        body: { token, password }
      });
      setSuccess(true);
      setMessage("密码重置成功，请使用新密码登录。");
      setTimeout(() => {
        router.push("/login");
      }, 2000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重置失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
      <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6">
        <Link
          className="focus-ring inline-flex items-center gap-2 rounded-full text-white/70 hover:text-white"
          href="/login"
        >
          <Lock className="size-5" aria-hidden="true" />
          返回登录
        </Link>
        <h1 className="mt-6 text-3xl font-semibold">设置新密码</h1>
        <p className="mt-2 text-sm leading-6 text-white/62">请输入符合安全策略的新密码。</p>
        <form className="mt-6 space-y-4" noValidate onSubmit={submit}>
          <label className="block text-sm text-white/70">
            新密码
            <PasswordInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={!token || success}
              maxLength={128}
              minLength={12}
              placeholder="至少 12 位，包含字母和数字"
              required
            />
          </label>
          <label className="block text-sm text-white/70">
            确认密码
            <PasswordInput
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              disabled={!token || success}
              maxLength={128}
              minLength={12}
              placeholder="再次输入新密码"
              required
            />
          </label>
          {message ? (
            <p
              aria-live="polite"
              className={`rounded-2xl border p-3 text-sm ${
                success ? "border-mint/40 bg-mint/10 text-mint" : "border-ember/40 bg-ember/10 text-ember"
              }`}
              role={success ? "status" : "alert"}
            >
              {message}
            </p>
          ) : null}
          {!success && token ? (
            <button
              className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
              type="submit"
              disabled={loading || !password || !confirmPassword}
            >
              <Lock className="size-4" aria-hidden="true" />
              {loading ? "重置中..." : "重置密码"}
            </button>
          ) : null}
        </form>
      </section>
    </main>
  );
}

function validateResetPasswordForm(token: string, password: string, confirmPassword: string): string | null {
  if (!token) {
    return "重置链接无效，请重新申请。";
  }
  if (!password) {
    return "请输入新密码。";
  }
  if (password.length < 12) {
    return "密码至少需要 12 位。";
  }
  if (password.length > 128) {
    return "密码长度不能超过 128 位。";
  }
  if (password.trim() !== password) {
    return "密码开头和结尾不能包含空格。";
  }
  if (hasControlCharacter(password)) {
    return "密码包含不支持的字符。";
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return "密码需要同时包含字母和数字。";
  }
  if (commonPasswordBlocklist.has(normalizePasswordForBlocklist(password))) {
    return "密码过于常见，请更换更安全的密码。";
  }
  if (!confirmPassword) {
    return "请再次输入新密码。";
  }
  if (password !== confirmPassword) {
    return "两次输入的密码不一致。";
  }
  return null;
}

const commonPasswordBlocklist = new Set([
  "123456",
  "12345678",
  "123456789",
  "imagora",
  "imagora123",
  "password",
  "password123",
  "qwerty123"
]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function normalizePasswordForBlocklist(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
