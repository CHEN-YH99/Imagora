"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Edit2,
  KeyRound,
  Mail,
  MailCheck,
  MonitorSmartphone,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import { AppFrame, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { PasswordInput } from "../../components/PasswordInput";
import {
  apiFetch,
  changeEmail,
  changePassword,
  deleteAccount,
  formatCredits,
  formatLedgerRemark,
  formatNickname,
  formatMoney,
  formatPaymentProvider,
  getSessions,
  logoutOtherSessions,
  type CreditAccount,
  type CreditLedgerEntry,
  type Order,
  type User,
  type UserSession
} from "../../lib/api";

const ACCOUNT_SYNC_INTERVAL_MS = 5000;

type ExceptionalOrderStatus = Exclude<Order["status"], "PAID">;
type ExceptionalOrder = Order & { status: ExceptionalOrderStatus };

const exceptionalOrderStatuses: ExceptionalOrderStatus[] = ["PENDING", "CLOSED", "CANCELED", "REFUNDED"];

const exceptionalOrderDescriptions: Record<ExceptionalOrderStatus, string> = {
  PENDING: "订单仍待支付，若已完成支付回跳但未到账，请先去订单页刷新状态。",
  CLOSED: "订单已超时关闭，本次支付未完成，需要重新创建订单。",
  CANCELED: "订单已取消，不会再自动发放积分。",
  REFUNDED: "订单退款成功，请核对余额和订单状态。"
};

function isExceptionalOrder(order: Order): order is ExceptionalOrder {
  return exceptionalOrderStatuses.includes(order.status as ExceptionalOrderStatus);
}

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "danger">("danger");
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [savingNickname, setSavingNickname] = useState(false);
  const [resendingVerification, setResendingVerification] = useState(false);

  // 账户安全：修改密码
  const [currentPasswordForPwd, setCurrentPasswordForPwd] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  // 账户安全：修改邮箱
  const [currentPasswordForEmail, setCurrentPasswordForEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [changingEmail, setChangingEmail] = useState(false);

  // 账户安全：会话管理
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [loggingOutOthers, setLoggingOutOthers] = useState(false);

  // 账户安全：注销账户
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const result = await getSessions();
      setSessions(result.sessions);
    } catch {
      // 会话列表加载失败不阻断主流程，仅在面板内静默留空。
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadAll = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) {
      setMessage("");
    }
    try {
      const [userResult, accountResult, ledgerResult, ordersResult] = await Promise.all([
        apiFetch<{ user: User }>("/api/users/me"),
        apiFetch<{ account: CreditAccount }>("/api/users/me/credits"),
        apiFetch<{ entries: CreditLedgerEntry[] }>("/api/users/me/credit-ledger?limit=50"),
        apiFetch<{ orders: Order[] }>("/api/orders?limit=12")
      ]);
      setUser(userResult.user);
      setAccount(accountResult.account);
      setEntries(ledgerResult.entries);
      setRecentOrders(ordersResult.orders);
    } catch (error) {
      if (!background) {
        setMessageTone("danger");
        setMessage(error instanceof Error ? error.message : "账户信息加载失败，请稍后重试。");
      }
    }
  }, []);

  useEffect(() => {
    void loadAll();
    void loadSessions();
  }, [loadAll, loadSessions]);

  useEffect(() => {
    function syncVisibleAccount() {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadAll({ background: true });
      void loadSessions();
    }

    const intervalId = window.setInterval(syncVisibleAccount, ACCOUNT_SYNC_INTERVAL_MS);
    window.addEventListener("focus", syncVisibleAccount);
    document.addEventListener("visibilitychange", syncVisibleAccount);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncVisibleAccount);
      document.removeEventListener("visibilitychange", syncVisibleAccount);
    };
  }, [loadAll, loadSessions]);

  async function submitChangePassword() {
    const validationMessage = validateNewPassword(currentPasswordForPwd, newPassword, confirmNewPassword);
    if (validationMessage) {
      setMessageTone("danger");
      setMessage(validationMessage);
      return;
    }
    setChangingPassword(true);
    setMessage("");
    try {
      await changePassword(currentPasswordForPwd, newPassword);
      setCurrentPasswordForPwd("");
      setNewPassword("");
      setConfirmNewPassword("");
      setMessageTone("success");
      setMessage("密码已更新，其他设备的登录状态已失效。");
      void loadSessions();
    } catch (error) {
      setMessageTone("danger");
      setMessage(error instanceof Error ? error.message : "密码修改失败，请稍后重试。");
    } finally {
      setChangingPassword(false);
    }
  }

  async function submitChangeEmail() {
    const trimmed = newEmail.trim().toLowerCase();
    if (!currentPasswordForEmail) {
      setMessageTone("danger");
      setMessage("请输入当前密码以确认身份。");
      return;
    }
    if (!isEmailLike(trimmed) || trimmed.length > 254) {
      setMessageTone("danger");
      setMessage("请输入有效的新邮箱地址。");
      return;
    }
    if (trimmed === user?.email) {
      setMessageTone("danger");
      setMessage("新邮箱不能与当前邮箱相同。");
      return;
    }
    setChangingEmail(true);
    setMessage("");
    try {
      const result = await changeEmail(currentPasswordForEmail, trimmed);
      setUser(result.user);
      setCurrentPasswordForEmail("");
      setNewEmail("");
      setMessageTone("success");
      setMessage("邮箱已更新，我们已向新邮箱发送验证邮件，请查收并完成验证。");
    } catch (error) {
      setMessageTone("danger");
      setMessage(error instanceof Error ? error.message : "邮箱修改失败，请稍后重试。");
    } finally {
      setChangingEmail(false);
    }
  }

  async function submitLogoutOthers() {
    setLoggingOutOthers(true);
    setMessage("");
    try {
      const result = await logoutOtherSessions();
      setMessageTone("success");
      setMessage(
        result.removed > 0 ? `已登出其他 ${result.removed} 个设备的登录状态。` : "当前没有其他设备的登录状态。"
      );
      void loadSessions();
    } catch (error) {
      setMessageTone("danger");
      setMessage(error instanceof Error ? error.message : "操作失败，请稍后重试。");
    } finally {
      setLoggingOutOthers(false);
    }
  }

  async function submitDeleteAccount() {
    if (!deletePassword) {
      setMessageTone("danger");
      setMessage("请输入当前密码以确认注销。");
      return;
    }
    setDeletingAccount(true);
    setMessage("");
    try {
      await deleteAccount(deletePassword);
      router.replace("/login?deleted=1");
    } catch (error) {
      setMessageTone("danger");
      setMessage(error instanceof Error ? error.message : "注销失败，请稍后重试。");
      setDeletingAccount(false);
    }
  }

  function startEditNickname() {
    setNicknameDraft(user?.nickname ?? "");
    setEditingNickname(true);
  }

  function cancelEditNickname() {
    setEditingNickname(false);
    setNicknameDraft("");
  }

  async function resendVerificationEmail() {
    setResendingVerification(true);
    setMessage("");
    try {
      await apiFetch<{ ok: boolean; message: string }>("/api/auth/resend-verification", {
        method: "POST",
        body: {}
      });
      setMessageTone("success");
      setMessage("验证邮件已重新发送，请前往邮箱完成验证。");
    } catch (error) {
      setMessageTone("danger");
      setMessage(error instanceof Error ? error.message : "验证邮件发送失败，请稍后重试。");
    } finally {
      setResendingVerification(false);
    }
  }

  async function saveNickname() {
    const trimmed = nicknameDraft.trim();
    if (!trimmed || trimmed.length > 80) {
      setMessageTone("danger");
      setMessage("昵称长度须在 1 到 80 个字符之间。");
      return;
    }
    setSavingNickname(true);
    setMessage("");
    try {
      const result = await apiFetch<{ user: User }>("/api/users/me", {
        method: "PATCH",
        body: { nickname: trimmed }
      });
      setUser(result.user);
      setEditingNickname(false);
      setNicknameDraft("");
      setMessageTone("success");
      setMessage("昵称已更新。");
    } catch (error) {
      setMessageTone("danger");
      setMessage(error instanceof Error ? error.message : "昵称保存失败，请稍后重试。");
    } finally {
      setSavingNickname(false);
    }
  }

  const latestGrantEntry = entries.find((entry) => entry.type === "GRANT" && entry.amount > 0);
  const now = Date.now();
  const soonThreshold = now + 7 * 24 * 60 * 60 * 1000;
  const expiringSoonEntries = entries.filter(
    (entry) =>
      entry.type === "GRANT" &&
      entry.amount > 0 &&
      typeof entry.expiresAt === "string" &&
      new Date(entry.expiresAt).getTime() > now &&
      new Date(entry.expiresAt).getTime() <= soonThreshold
  );
  const expiringSoonTotal = expiringSoonEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const soonestExpiry = expiringSoonEntries
    .map((entry) => entry.expiresAt as string)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
  const exceptionalOrders = recentOrders.filter(isExceptionalOrder);
  const visibleRecentOrders = recentOrders.slice(0, 5);
  const paidOrders = recentOrders.filter((order) => order.status === "PAID");

  return (
    <AppFrame title="账户中心" subtitle="查看用户资料、积分余额和积分流水，确保每一次发放、消耗和退回都有记录。">
      {message ? (
        <div className="mb-5">
          <InlineNotice tone={messageTone}>
            {message}
            {messageTone === "danger" ? (
              <>
                {" "}
                <button className="underline underline-offset-4" onClick={() => void loadAll()} type="button">
                  重新加载账户
                </button>
              </>
            ) : null}
          </InlineNotice>
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="space-y-5">
          <Panel>
            <h2 className="text-xl font-semibold">个人资料</h2>
            {user && !user.emailVerifiedAt ? (
              <div className="mt-5">
                <InlineNotice tone="danger">
                  邮箱尚未验证，部分安全操作可能受限。
                  <button
                    className="ml-2 inline-flex items-center gap-1 underline underline-offset-4"
                    disabled={resendingVerification}
                    onClick={() => void resendVerificationEmail()}
                    type="button"
                  >
                    <Send className="size-3.5" aria-hidden="true" />
                    {resendingVerification ? "发送中..." : "重新发送验证邮件"}
                  </button>
                </InlineNotice>
              </div>
            ) : null}
            <div className="mt-5 space-y-4 text-sm text-white/68">
              <div>
                <p className="text-white/50">邮箱</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-white/82">
                  <span>{user?.email ?? "-"}</span>
                  {user?.emailVerifiedAt ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-mint/30 bg-mint/10 px-2.5 py-1 text-xs text-mint">
                      <MailCheck className="size-3.5" aria-hidden="true" />
                      已验证
                    </span>
                  ) : user ? (
                    <span className="rounded-full border border-ember/30 bg-ember/10 px-2.5 py-1 text-xs text-ember">
                      待验证
                    </span>
                  ) : null}
                </div>
              </div>
              <div>
                <p className="text-white/50">昵称</p>
                {editingNickname ? (
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      className="focus-ring min-w-0 flex-1 rounded-xl border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                      value={nicknameDraft}
                      onChange={(event) => setNicknameDraft(event.target.value)}
                      maxLength={80}
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveNickname();
                        if (event.key === "Escape") cancelEditNickname();
                      }}
                    />
                    <button
                      className="focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-mint text-ink transition-colors hover:bg-volt disabled:opacity-60"
                      type="button"
                      disabled={savingNickname}
                      onClick={() => void saveNickname()}
                      aria-label="保存昵称"
                    >
                      <Save className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      className="focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-white/12 text-white/60 transition-colors hover:bg-white/10"
                      type="button"
                      onClick={cancelEditNickname}
                      aria-label="取消编辑"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-white/82">{formatNickname(user?.nickname)}</span>
                    <button
                      className="focus-ring inline-flex size-6 items-center justify-center rounded-full text-white/40 transition-colors hover:text-white/70"
                      type="button"
                      onClick={startEditNickname}
                      aria-label="编辑昵称"
                    >
                      <Edit2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill>{user?.role ?? "-"}</StatusPill>
                <StatusPill>{user?.status ?? "-"}</StatusPill>
              </div>
            </div>
            <div className="mt-6 rounded-2xl border border-white/10 bg-black/24 p-4">
              <p className="text-sm text-white/56">当前余额</p>
              <p className="mt-2 text-4xl font-semibold text-volt">{account ? formatCredits(account.balance) : "-"}</p>
              <p className="mt-2 text-sm text-white/52">
                累计获得 {account ? formatCredits(account.totalEarned) : "0 积分"} · 累计消耗{" "}
                {account ? formatCredits(account.totalSpent) : "0 积分"}
              </p>
              {expiringSoonTotal > 0 ? (
                <p className="mt-3 rounded-xl border border-ember/30 bg-ember/10 px-3 py-2 text-xs text-ember">
                  有最多 {formatCredits(expiringSoonTotal)} 将在 {soonestExpiry} 前过期，建议尽快使用。
                </p>
              ) : null}
              <Link
                className="focus-ring mt-4 inline-flex items-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                href="/pricing"
              >
                充值积分
              </Link>
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-mint" aria-hidden="true" />
              <h2 className="text-xl font-semibold">账户安全</h2>
            </div>

            <div className="mt-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-white/82">
                <KeyRound className="size-4 text-white/60" aria-hidden="true" />
                修改密码
              </div>
              <PasswordInput
                value={currentPasswordForPwd}
                onChange={(event) => setCurrentPasswordForPwd(event.target.value)}
                autoComplete="current-password"
                maxLength={128}
                placeholder="当前密码"
              />
              <PasswordInput
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                maxLength={128}
                placeholder="新密码（至少 12 位，含字母和数字）"
              />
              <PasswordInput
                value={confirmNewPassword}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                autoComplete="new-password"
                maxLength={128}
                placeholder="确认新密码"
              />
              <button
                className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-volt disabled:opacity-60"
                disabled={changingPassword || !currentPasswordForPwd || !newPassword || !confirmNewPassword}
                onClick={() => void submitChangePassword()}
                type="button"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                {changingPassword ? "提交中..." : "更新密码"}
              </button>
            </div>

            <div className="mt-6 space-y-3 border-t border-white/8 pt-6">
              <div className="flex items-center gap-2 text-sm font-medium text-white/82">
                <Mail className="size-4 text-white/60" aria-hidden="true" />
                修改邮箱
              </div>
              <p className="text-xs leading-5 text-white/46">更换邮箱后需重新验证，我们会向新邮箱发送验证邮件。</p>
              <input
                className="focus-ring w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-sm text-white"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
                placeholder="新邮箱地址"
                type="email"
              />
              <PasswordInput
                value={currentPasswordForEmail}
                onChange={(event) => setCurrentPasswordForEmail(event.target.value)}
                autoComplete="current-password"
                maxLength={128}
                placeholder="当前密码（确认身份）"
              />
              <button
                className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-4 py-2.5 text-sm font-semibold text-white/82 transition-colors hover:bg-white/10 disabled:opacity-60"
                disabled={changingEmail || !newEmail.trim() || !currentPasswordForEmail}
                onClick={() => void submitChangeEmail()}
                type="button"
              >
                <Mail className="size-4" aria-hidden="true" />
                {changingEmail ? "提交中..." : "更新邮箱"}
              </button>
            </div>

            <div className="mt-6 space-y-3 border-t border-white/8 pt-6">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-white/82">
                  <MonitorSmartphone className="size-4 text-white/60" aria-hidden="true" />
                  登录设备
                </div>
                <button
                  className="focus-ring rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/10 disabled:opacity-60"
                  disabled={loggingOutOthers || sessions.length <= 1}
                  onClick={() => void submitLogoutOthers()}
                  type="button"
                >
                  {loggingOutOthers ? "处理中..." : "登出其他设备"}
                </button>
              </div>
              {sessionsLoading ? (
                <p className="text-xs text-white/46">正在加载登录设备...</p>
              ) : sessions.length > 0 ? (
                <ul className="space-y-2">
                  {sessions.map((session) => (
                    <li
                      key={session.id}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="text-white/72">登录于 {new Date(session.createdAt).toLocaleString("zh-CN")}</p>
                        <p className="mt-0.5 text-white/42">
                          有效期至 {new Date(session.expiresAt).toLocaleString("zh-CN")}
                        </p>
                      </div>
                      {session.current ? (
                        <span className="shrink-0 rounded-full border border-mint/30 bg-mint/10 px-2.5 py-1 text-mint">
                          当前设备
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-white/46">暂无其他登录设备。</p>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <Trash2 className="size-5 text-ember" aria-hidden="true" />
              <h2 className="text-lg font-semibold">注销账户</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-white/60">
              注销后账户将被停用，无法再登录。积分、订单和历史记录会保留归档，但不再可用。此操作不可自助撤销，请谨慎处理。
            </p>
            {deleteConfirming ? (
              <div className="mt-4 space-y-3 rounded-2xl border border-ember/30 bg-ember/8 p-4">
                <p className="text-sm text-ember">请输入当前密码以确认注销。</p>
                <PasswordInput
                  autoComplete="current-password"
                  maxLength={128}
                  onChange={(event) => setDeletePassword(event.target.value)}
                  placeholder="当前密码"
                  value={deletePassword}
                />
                <div className="flex gap-2">
                  <button
                    className="focus-ring inline-flex items-center gap-2 rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-ember/80 disabled:opacity-60"
                    disabled={deletingAccount || !deletePassword}
                    onClick={() => void submitDeleteAccount()}
                    type="button"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {deletingAccount ? "注销中..." : "确认注销"}
                  </button>
                  <button
                    className="focus-ring rounded-full border border-white/12 px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
                    disabled={deletingAccount}
                    onClick={() => {
                      setDeleteConfirming(false);
                      setDeletePassword("");
                    }}
                    type="button"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="focus-ring mt-4 inline-flex items-center gap-2 rounded-full border border-ember/40 px-4 py-2 text-sm font-semibold text-ember transition-colors hover:bg-ember/10"
                onClick={() => setDeleteConfirming(true)}
                type="button"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                注销账户
              </button>
            )}
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-mint" aria-hidden="true" />
              <h2 className="text-lg font-semibold">权益到账</h2>
            </div>
            {latestGrantEntry ? (
              <div className="mt-4 rounded-2xl border border-mint/20 bg-mint/8 p-4">
                <p className="text-sm text-white/76">{formatLedgerRemark(latestGrantEntry.remark)}</p>
                <p className="mt-2 text-2xl font-semibold text-mint">+{latestGrantEntry.amount} 积分</p>
                <p className="mt-2 text-xs text-white/46">
                  {new Date(latestGrantEntry.createdAt).toLocaleString("zh-CN")} · 到账后余额{" "}
                  {formatCredits(latestGrantEntry.balanceAfter)}
                </p>
              </div>
            ) : (
              <EmptyState
                title="暂未检测到到账权益"
                description="完成支付后，到账积分会优先显示在这里，方便快速确认充值结果。"
                actionLabel="查看积分套餐"
                actionHref="/pricing"
              />
            )}
            {paidOrders.length > 0 ? (
              <p className="mt-4 text-sm text-white/56">
                最近已完成 {paidOrders.length} 笔充值，到账后会自动写入积分流水。
              </p>
            ) : null}
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-ember" aria-hidden="true" />
                <h2 className="text-lg font-semibold">异常订单</h2>
              </div>
              <Link className="focus-ring text-sm text-white/50 transition-colors hover:text-white" href="/orders">
                去订单页处理
              </Link>
            </div>
            {exceptionalOrders.length > 0 ? (
              <div className="mt-4 space-y-3">
                {exceptionalOrders.map((order) => (
                  <article key={order.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{order.orderNo}</p>
                        <p className="mt-1 text-xs text-white/46">
                          {formatMoney(order.amountCents, order.currency)} ·{" "}
                          {formatPaymentProvider(order.paymentProvider)}
                        </p>
                      </div>
                      <StatusPill>{order.status}</StatusPill>
                    </div>
                    <p className="mt-3 text-sm text-white/62">{exceptionalOrderDescriptions[order.status]}</p>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="近期没有异常订单"
                description="待支付、已关闭、已取消和退款成功订单会在这里集中提示，省得你翻半天。"
                actionLabel="查看全部订单"
                actionHref="/orders"
              />
            )}
          </Panel>

          {visibleRecentOrders.length > 0 ? (
            <Panel>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">最近订单</h2>
                <Link className="focus-ring text-sm text-white/50 transition-colors hover:text-white" href="/orders">
                  查看全部
                </Link>
              </div>
              <div className="space-y-3">
                {visibleRecentOrders.map((order) => (
                  <article
                    key={order.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{order.orderNo}</p>
                      <p className="mt-0.5 text-xs text-white/46">
                        {formatMoney(order.amountCents, order.currency)} ·{" "}
                        {formatPaymentProvider(order.paymentProvider)}
                      </p>
                    </div>
                    <StatusPill>{order.status}</StatusPill>
                  </article>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">积分流水</h2>
          <div className="space-y-3">
            {entries.map((entry) => (
              <article
                key={entry.id}
                className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <StatusPill>{entry.type}</StatusPill>
                  <p className="mt-2 text-sm text-white/68">{formatLedgerRemark(entry.remark)}</p>
                  <p className="mt-1 text-xs text-white/42">{new Date(entry.createdAt).toLocaleString("zh-CN")}</p>
                </div>
                <p
                  className={entry.amount >= 0 ? "text-lg font-semibold text-mint" : "text-lg font-semibold text-ember"}
                >
                  {entry.amount >= 0 ? "+" : ""}
                  {entry.amount}
                </p>
              </article>
            ))}
            {entries.length === 0 ? (
              <EmptyState
                title="暂无积分流水"
                description="充值、生成扣减、失败退款和人工调整都会形成流水记录。"
                actionLabel="查看积分套餐"
                actionHref="/pricing"
              />
            ) : null}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// 与后端 newPasswordSchema 对齐的前端预校验，减少无谓请求。
function validateNewPassword(currentPassword: string, newPassword: string, confirmNewPassword: string): string | null {
  if (!currentPassword) {
    return "请输入当前密码。";
  }
  if (!newPassword) {
    return "请输入新密码。";
  }
  if (newPassword.length < 12) {
    return "新密码至少需要 12 位。";
  }
  if (newPassword.length > 128) {
    return "新密码长度不能超过 128 位。";
  }
  if (newPassword.trim() !== newPassword) {
    return "新密码开头和结尾不能包含空格。";
  }
  if ([...newPassword].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    return "新密码包含不支持的字符。";
  }
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return "新密码需要同时包含字母和数字。";
  }
  if (newPassword === currentPassword) {
    return "新密码不能与当前密码相同。";
  }
  if (newPassword !== confirmNewPassword) {
    return "两次输入的新密码不一致。";
  }
  return null;
}
