"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { LogOut, Sparkles } from "lucide-react";
import {
  formatStatusLabel,
  getCurrentUser,
  logout as apiLogout,
  peekCurrentUser,
  SESSION_EXPIRED_EVENT,
  setCurrentUser,
  type User
} from "../lib/api";

const navItems = [
  { href: "/generate", label: "生成" },
  { href: "/history", label: "历史" },
  { href: "/favorites", label: "收藏" },
  { href: "/pricing", label: "套餐" },
  { href: "/account", label: "账户" },
  { href: "/orders", label: "订单" },
  { href: "/admin", label: "管理", adminOnly: true }
];

function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppFrame({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const [user, setUserState] = useState<User | null | undefined>(() => peekCurrentUser());
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutMessage, setLogoutMessage] = useState("");
  const logoutTitleId = useId();
  const logoutDescriptionId = useId();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let active = true;

    getCurrentUser()
      .then((currentUser) => {
        if (active) {
          setUserState(currentUser);
        }
      })
      .catch(() => {
        if (active) {
          setUserState(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // 会话过期时统一跳登录并带上回跳地址，避免受保护页只弹红字卡死
  useEffect(() => {
    function handleSessionExpired() {
      setCurrentUser(null);
      setUserState(null);
      const next = pathname && pathname !== "/login" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${next}`);
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [pathname, router]);

  useEffect(() => {
    if (!logoutConfirmOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !logoutLoading) {
        setLogoutConfirmOpen(false);
        setLogoutMessage("");
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [logoutConfirmOpen, logoutLoading]);

  function requestLogout() {
    setLogoutMessage("");
    setLogoutConfirmOpen(true);
  }

  function cancelLogout() {
    if (logoutLoading) {
      return;
    }
    setLogoutConfirmOpen(false);
    setLogoutMessage("");
  }

  async function confirmLogout() {
    if (logoutLoading) {
      return;
    }
    setLogoutLoading(true);
    setLogoutMessage("");
    try {
      await apiLogout();
      setUserState(null);
      setLogoutConfirmOpen(false);
    } catch (error) {
      setLogoutMessage(error instanceof Error ? error.message : "退出失败，请稍后重试。");
    } finally {
      setLogoutLoading(false);
    }
  }

  const visibleNavItems = navItems.filter((item) => !item.adminOnly || user?.role === "ADMIN");

  return (
    <main className="min-h-screen bg-ink text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink/90 px-4 py-3 backdrop-blur-xl">
        <nav className="mx-auto grid max-w-7xl gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
          <Link className="focus-ring flex items-center gap-3 rounded-full lg:justify-self-start" href="/">
            <span className="flex size-10 items-center justify-center rounded-full bg-white text-ink">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <span className="text-lg font-semibold">Imagora</span>
          </Link>
          <div className="flex gap-2 overflow-x-auto pb-1 lg:justify-self-center lg:pb-0">
            {visibleNavItems.map((item) => {
              const active = isNavItemActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  className={`focus-ring shrink-0 rounded-full border px-4 py-2 text-sm transition-colors duration-200 ${
                    active
                      ? "border-mint/40 bg-mint/12 text-white"
                      : "border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
                  }`}
                  href={item.href}
                >
                  {item.label}
                </Link>
               );
            })}
          </div>
          <div className="flex min-h-10 items-center gap-3 text-sm text-white/64 lg:min-w-[15rem] lg:justify-self-end">
            {user === undefined ? (
              <div
                aria-hidden="true"
                className="h-10 w-full rounded-full border border-white/10 bg-white/[0.06] motion-safe:animate-pulse"
              />
            ) : user ? (
              <>
                <span className="min-w-0 truncate">{user.email}</span>
                <button
                  type="button"
                  onClick={requestLogout}
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  退出
                </button>
              </>
            ) : (
              <Link
                className="focus-ring ml-auto rounded-full bg-white px-4 py-2 font-semibold text-ink transition-colors duration-200 hover:bg-mint"
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

      {logoutConfirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
          onClick={cancelLogout}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              cancelLogout();
            }
          }}
          role="presentation"
        >
          <section
            aria-describedby={logoutDescriptionId}
            aria-labelledby={logoutTitleId}
            aria-modal="true"
            className="w-full max-w-sm rounded-[1.25rem] border border-white/12 bg-ink p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <h2 className="text-lg font-semibold text-white" id={logoutTitleId}>
              确认退出登录？
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/66" id={logoutDescriptionId}>
              退出后需要重新登录才能访问生成历史、收藏和账户信息。
            </p>
            {logoutMessage ? (
              <p
                aria-live="polite"
                className="mt-4 rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember"
                role="alert"
              >
                {logoutMessage}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-3">
              <button
                className="focus-ring rounded-full border border-white/12 px-4 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white disabled:opacity-60"
                autoFocus
                disabled={logoutLoading}
                onClick={cancelLogout}
                type="button"
              >
                取消
              </button>
              <button
                className="focus-ring rounded-full bg-ember px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-ember/80 disabled:opacity-60"
                disabled={logoutLoading}
                onClick={() => void confirmLogout()}
                type="button"
              >
                {logoutLoading ? "退出中..." : "确认退出"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-[1.35rem] border border-white/12 bg-white/7 p-5 ${className}`}>{children}</section>
  );
}

export function StatusPill({
  children,
  className = ""
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const rawValue = typeof children === "string" ? children : null;
  const label = rawValue ? formatStatusLabel(rawValue) : children;
  return (
    <span
      className={`inline-flex min-h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3.5 py-1 text-center text-xs font-medium leading-none ${statusPillToneClass(rawValue)} ${className}`}
    >
      {label}
    </span>
  );
}

function statusPillToneClass(value: string | null): string {
  if (!value) {
    return "border-white/10 bg-white/8 text-white/68";
  }

  if (["SUCCEEDED", "PAID", "ACTIVE", "APPROVED", "PASSED", "PUBLIC", "RESOLVED", "SENT"].includes(value)) {
    return "border-mint/35 bg-mint/10 text-mint";
  }

  if (["RUNNING", "ACKNOWLEDGED", "REFUNDED", "PRIVATE", "IDLE", "info"].includes(value)) {
    return "border-cyanx/35 bg-cyanx/10 text-cyanx";
  }

  if (["PENDING", "OPEN", "REVIEW_REQUIRED", "warning"].includes(value)) {
    return "border-volt/35 bg-volt/10 text-volt";
  }

  if (["FAILED", "BLOCKED", "CANCELED", "CLOSED", "SUSPENDED", "DELETED", "REJECTED", "HIDDEN", "critical"].includes(value)) {
    return "border-ember/35 bg-ember/10 text-ember";
  }

  return "border-white/10 bg-white/8 text-white/68";
}

export function InlineNotice({
  children,
  tone = "info"
}: {
  children: React.ReactNode;
  tone?: "info" | "success" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "border-ember/40 bg-ember/10 text-ember"
      : tone === "success"
        ? "border-mint/40 bg-mint/10 text-mint"
        : "border-white/12 bg-white/7 text-white/72";
  return (
    <p
      aria-live="polite"
      className={`rounded-2xl border p-4 text-sm ${toneClass}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  onAction
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}) {
  const actionClass =
    "focus-ring inline-flex items-center justify-center rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt";
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/14 bg-black/16 p-6 text-center">
      <div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-white/54">{description}</p>
      </div>
      {actionLabel && actionHref ? (
        <Link className={actionClass} href={actionHref}>
          {actionLabel}
        </Link>
      ) : null}
      {actionLabel && onAction ? (
        <button className={actionClass} onClick={onAction} type="button">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  loading = false,
  tone = "danger",
  confirmDisabled = false,
  onCancel,
  onConfirm,
  children
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  tone?: "danger" | "default";
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open || loading) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [loading, onCancel, open]);

  if (!open) {
    return null;
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-sm rounded-[1.25rem] border border-white/12 bg-ink p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2 className="text-lg font-semibold text-white" id={titleId}>
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-white/66" id={descriptionId}>
          {description}
        </p>
        {children ? <div className="mt-4">{children}</div> : null}
        <div className="mt-5 flex justify-end gap-3">
          <button
            autoFocus
            className="focus-ring rounded-full border border-white/12 px-4 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white disabled:opacity-60"
            disabled={loading}
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={`focus-ring rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 disabled:opacity-60 ${
              tone === "danger" ? "bg-ember text-white hover:bg-ember/80" : "bg-mint text-ink hover:bg-volt"
            }`}
            disabled={loading || confirmDisabled}
            onClick={onConfirm}
            type="button"
          >
            {loading ? "处理中..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
