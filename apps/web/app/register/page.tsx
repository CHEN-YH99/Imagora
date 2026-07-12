"use client";

import { type FormEvent, Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { UserPlus } from "lucide-react";
import { register } from "../../lib/api";
import { PasswordInput } from "../../components/PasswordInput";

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
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState(false);

  const fromDemo = searchParams.get("from") === "demo";

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
      setRegistered(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "注册失败，请检查信息后重试。");
    } finally {
      setLoading(false);
    }
  }

  if (registered) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
        <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-mint/20 text-2xl text-mint">
            ✓
          </div>
          <h1 className="mt-4 text-2xl font-semibold">账号创建成功</h1>
          <p className="mt-3 text-sm leading-6 text-white/70">
            我们已向 <span className="font-medium text-white">{email.trim().toLowerCase()}</span>{" "}
            发送了一封验证邮件，请查收并点击其中的链接完成邮箱验证后再开始生成图片。
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <Link
              className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt"
              href="/verify-email"
            >
              没收到？前往重新发送
            </Link>
            <Link className="focus-ring text-sm text-white/56 hover:text-mint" href="/generate">
              先进入生成工作台
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
      <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6">
        <Link className="focus-ring text-sm text-white/70 hover:text-white" href="/">
          返回 Imagora
        </Link>
        <h1 className="mt-6 text-3xl font-semibold">创建账号</h1>
        {fromDemo ? (
          <div className="mt-3 rounded-2xl border border-mint/30 bg-mint/8 px-4 py-3">
            <p className="text-sm text-white/80">注册并完成邮箱验证后即可进入生成工作台，你的当前预设会在本标签页内保留。</p>
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
            <PasswordInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              maxLength={128}
              minLength={12}
              required
            />
          </label>
          <label className="block text-sm text-white/70">
            确认密码
            <PasswordInput
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              maxLength={128}
              minLength={12}
              required
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
            {loading ? "创建中..." : "创建账号"}
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
