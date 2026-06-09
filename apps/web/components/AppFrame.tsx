"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogOut, Sparkles } from "lucide-react";
import { apiFetch, formatStatusLabel, getStoredToken, logout as apiLogout, setStoredToken, type User } from "../lib/api";

const navItems = [
  { href: "/generate", label: "生成" },
  { href: "/history", label: "历史" },
  { href: "/favorites", label: "收藏" },
  { href: "/pricing", label: "套餐" },
  { href: "/account", label: "账户" },
  { href: "/orders", label: "订单" },
  { href: "/admin", label: "管理" }
];

export function AppFrame({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    apiFetch<{ user: User }>("/api/auth/me", { token: getStoredToken() })
      .then((result) => setUser(result.user))
      .catch(() => setStoredToken(null));
  }, []);

  function logout() {
    void apiLogout(getStoredToken()).catch(() => setStoredToken(null));
    setUser(null);
  }

  return (
    <main className="min-h-screen bg-ink text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink/90 px-4 py-3 backdrop-blur-xl">
        <nav className="mx-auto flex max-w-7xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Link className="focus-ring flex items-center gap-3 rounded-full" href="/">
            <span className="flex size-10 items-center justify-center rounded-full bg-white text-ink">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <span className="text-lg font-semibold">Imagora</span>
          </Link>
          <div className="flex gap-2 overflow-x-auto pb-1 lg:pb-0">
            {navItems.map((item) => (
              <Link
                key={item.href}
                className="focus-ring shrink-0 rounded-full border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                href={item.href}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-3 text-sm text-white/64">
            {user ? (
              <>
                <span className="truncate">{user.email}</span>
                <button
                  type="button"
                  onClick={logout}
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  退出
                </button>
              </>
            ) : (
              <Link
                className="focus-ring rounded-full bg-white px-4 py-2 font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                href="/login"
              >
                登录
              </Link>
            )}
          </div>
        </nav>
      </header>

      <section className="mx-auto max-w-7xl px-4 py-10">
        <div className="mb-8 max-w-3xl">
          <p className="text-sm text-mint">Imagora 创作控制台</p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-5xl">{title}</h1>
          <p className="mt-4 text-base leading-7 text-white/66">{subtitle}</p>
        </div>
        {children}
      </section>
    </main>
  );
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-[1.35rem] border border-white/12 bg-white/7 p-5 ${className}`}>{children}</section>;
}

export function StatusPill({ children }: { children: React.ReactNode }) {
  const label = typeof children === "string" ? formatStatusLabel(children) : children;
  return <span className="rounded-full border border-white/10 bg-white/8 px-3 py-1 text-xs text-white/68">{label}</span>;
}
