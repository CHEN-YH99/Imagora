"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { apiFetch } from "../../lib/api";

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

  async function submit() {
    if (password !== confirmPassword) {
      setMessage("两次输入的密码不一致。");
      return;
    }
    if (password.length < 8) {
      setMessage("密码至少需要 8 个字符。");
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
        <p className="mt-2 text-sm leading-6 text-white/62">请输入您的新密码。</p>
        <div className="mt-6 space-y-4">
          <label className="block text-sm text-white/70">
            新密码
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              disabled={!token || success}
              placeholder="至少 8 个字符"
            />
          </label>
          <label className="block text-sm text-white/70">
            确认密码
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              disabled={!token || success}
              placeholder="再次输入新密码"
            />
          </label>
          {message ? (
            <p
              className={`rounded-2xl border p-3 text-sm ${
                success
                  ? "border-mint/40 bg-mint/10 text-mint"
                  : "border-ember/40 bg-ember/10 text-ember"
              }`}
            >
              {message}
            </p>
          ) : null}
          {!success && token ? (
            <button
              className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
              type="button"
              disabled={loading || !password.trim() || !confirmPassword.trim()}
              onClick={submit}
            >
              <Lock className="size-4" aria-hidden="true" />
              {loading ? "重置中..." : "重置密码"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
