"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, XCircle } from "lucide-react";
import { apiFetch } from "../../lib/api";

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
          <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6">
            <p className="text-sm text-white/60">正在验证...</p>
          </section>
        </main>
      }
    >
      <VerifyEmailForm />
    </Suspense>
  );
}

function VerifyEmailForm() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState("正在验证邮箱，请稍候...");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      setMessage("验证链接无效，请重新申请验证邮件。");
      return;
    }
    apiFetch<{ ok: boolean; email: string }>("/api/auth/verify-email", {
      method: "POST",
      body: { token }
    })
      .then((result) => {
        setStatus("success");
        setMessage(`邮箱 ${result.email} 验证成功！`);
      })
      .catch((error) => {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "验证失败，链接可能已过期，请重新申请。");
      });
  }, [searchParams]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4 text-white">
      <section className="w-full max-w-md rounded-[1.5rem] border border-white/12 bg-white/7 p-6 text-center">
        {status === "pending" ? (
          <p className="py-8 text-sm text-white/60">{message}</p>
        ) : status === "success" ? (
          <>
            <CheckCircle className="mx-auto size-12 text-mint" aria-hidden="true" />
            <h1 className="mt-4 text-2xl font-semibold">邮箱验证成功</h1>
            <p className="mt-2 text-sm text-white/62">{message}</p>
            <Link
              className="focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors hover:bg-volt"
              href="/generate"
            >
              开始创作
            </Link>
          </>
        ) : (
          <>
            <XCircle className="mx-auto size-12 text-ember" aria-hidden="true" />
            <h1 className="mt-4 text-2xl font-semibold">验证失败</h1>
            <p className="mt-2 text-sm text-white/62">{message}</p>
            <Link
              className="focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors hover:bg-volt"
              href="/login"
            >
              返回登录
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
