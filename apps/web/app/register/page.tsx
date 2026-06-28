"use client";

import { type ClipboardEvent, type FormEvent, Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { UserPlus } from "lucide-react";
import { register } from "../../lib/api";

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
          <p className="text-sm text-white/60">加载中...</p>
        </main>
      }
    >
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const promptParam = searchParams.get("prompt");
  const fromDemo = searchParams.get("from") === "demo";

  function handleConfirmPasswordPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    setMessage("请手动输入确认密码，不能直接粘贴。");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationMessage = validateRegisterForm(email, password, confirmPassword);
    if (validationMessage) {
      setMessage(validationMessage);
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      await register(email.trim().toLowerCase(), password);
      if (promptParam) {
        router.push(`/generate?prompt=${encodeURIComponent(promptParam)}`);
      } else {
        router.push("/generate");
      }
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
        {fromDemo && promptParam ? (
          <div className="mt-3 rounded-2xl border border-mint/30 bg-mint/8 px-4 py-3">
            <p className="text-sm text-white/80">注册后将直接生成你的图片：</p>
            <p className="mt-1 line-clamp-2 text-sm text-white/60">{promptParam}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm leading-6 text-white/62">
            新用户可获得欢迎积分，用于体验图片生成、历史记录和下载流程。
          </p>
        )}
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
              autoComplete="new-password"
              maxLength={128}
              minLength={12}
              required
              type="password"
            />
          </label>
          <label className="block text-sm text-white/70">
            确认密码
            <input
              className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onPaste={handleConfirmPasswordPaste}
              autoComplete="new-password"
              maxLength={128}
              minLength={12}
              required
              type="password"
            />
          </label>
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
            disabled={loading || !email.trim() || !password || !confirmPassword}
          >
            <UserPlus className="size-4" aria-hidden="true" />
            {loading ? "创建中..." : fromDemo ? "注册并生成图片" : "创建账号"}
          </button>
          <p className="text-center text-sm text-white/56">
            已有账号？{" "}
            <Link className="text-mint hover:text-volt" href="/login">
              登录
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}

function validateRegisterForm(email: string, password: string, confirmPassword: string): string | null {
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
  const emailName = normalizedEmail.split("@")[0]?.toLowerCase() ?? "";
  if (emailName.length >= 4 && password.toLowerCase().includes(emailName)) {
    return "密码不能包含邮箱名称。";
  }
  if (!confirmPassword) {
    return "请再次输入密码。";
  }
  if (password !== confirmPassword) {
    return "两次输入的密码不一致。";
  }
  return null;
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
