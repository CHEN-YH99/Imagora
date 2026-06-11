"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogIn, UserRound } from "lucide-react";
import { login, setStoredToken } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setMessage("");
    try {
      const result = await login(email, password);
      setStoredToken(result.token);
      router.push("/generate");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败，请检查账号信息后重试。");
    } finally {
      setLoading(false);
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
        <div className="mt-6 space-y-4">
          <label className="block text-sm text-white/70">
            邮箱
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
            />
          </label>
          <label className="block text-sm text-white/70">
            密码
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
            />
          </label>
          {message ? (
            <p className="rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{message}</p>
          ) : null}
          <button
            className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
            type="button"
            disabled={loading}
            onClick={submit}
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
        </div>
      </section>
    </main>
  );
}
