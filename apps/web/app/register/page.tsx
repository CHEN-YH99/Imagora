"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { register, setStoredToken } from "../../lib/api";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setMessage("");
    try {
      const result = await register(email, password, nickname || email.split("@")[0] || "创作者");
      setStoredToken(result.token);
      router.push("/generate");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "注册失败，请检查信息后重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
      <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6">
        <Link className="focus-ring text-sm text-white/70 hover:text-white" href="/">
          返回 Imagora
        </Link>
        <h1 className="mt-6 text-3xl font-semibold">创建账号</h1>
        <p className="mt-2 text-sm leading-6 text-white/62">新用户可获得欢迎积分，用于体验图片生成、历史记录和下载流程。</p>
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
            昵称
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
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
          {message ? <p className="rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{message}</p> : null}
          <button
            className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
            type="button"
            disabled={loading}
            onClick={submit}
          >
            <UserPlus className="size-4" aria-hidden="true" />
            {loading ? "创建中..." : "创建账号"}
          </button>
          <p className="text-center text-sm text-white/56">
            已有账号？{" "}
            <Link className="text-mint hover:text-volt" href="/login">
              登录
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
