"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";
import { apiFetch } from "../../lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationMessage = validateForgotPasswordForm(email);
    if (validationMessage) {
      setSuccess(false);
      setMessage(validationMessage);
      return;
    }

    setLoading(true);
    setMessage("");
    setSuccess(false);
    try {
      await apiFetch<{ ok: boolean; message: string }>("/api/auth/request-password-reset", {
        method: "POST",
        body: { email }
      });
      setSuccess(true);
      setMessage("如果该邮箱已注册，您将收到密码重置链接。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "请求失败，请稍后重试。");
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
          <Mail className="size-5" aria-hidden="true" />
          返回登录
        </Link>
        <h1 className="mt-6 text-3xl font-semibold">重置密码</h1>
        <p className="mt-2 text-sm leading-6 text-white/62">输入您的注册邮箱，我们将发送密码重置链接到您的邮箱。</p>
        <form className="mt-6 space-y-4" noValidate onSubmit={submit}>
          <label className="block text-sm text-white/70">
            邮箱
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              disabled={success}
              maxLength={254}
              required
              type="email"
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
          {!success ? (
            <button
              className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
              type="submit"
              disabled={loading || !email.trim()}
            >
              <Mail className="size-4" aria-hidden="true" />
              {loading ? "发送中..." : "发送重置链接"}
            </button>
          ) : (
            <Link
              className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-5 py-3 font-semibold text-white transition-colors duration-200 hover:bg-white/10"
              href="/login"
            >
              返回登录
            </Link>
          )}
        </form>
      </section>
    </main>
  );
}

function validateForgotPasswordForm(email: string): string | null {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) {
    return "请输入邮箱。";
  }
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return "请输入有效的邮箱地址。";
  }
  return null;
}
