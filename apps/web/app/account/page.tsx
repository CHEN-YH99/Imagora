"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Edit2, Save, X } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  formatLedgerRemark,
  formatNickname,
  formatMoney,
  formatPaymentProvider,
  type CreditAccount,
  type CreditLedgerEntry,
  type Order,
  type User
} from "../../lib/api";

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [savingNickname, setSavingNickname] = useState(false);

  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    setMessage("");
    try {
      const [userResult, accountResult, ledgerResult, ordersResult] = await Promise.all([
        apiFetch<{ user: User }>("/api/users/me"),
        apiFetch<{ account: CreditAccount }>("/api/users/me/credits"),
        apiFetch<{ entries: CreditLedgerEntry[] }>("/api/users/me/credit-ledger?limit=50"),
        apiFetch<{ orders: Order[] }>("/api/orders?limit=5")
      ]);
      setUser(userResult.user);
      setAccount(accountResult.account);
      setEntries(ledgerResult.entries);
      setRecentOrders(ordersResult.orders);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账户信息加载失败，请稍后重试。");
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

  async function saveNickname() {
    const trimmed = nicknameDraft.trim();
    if (!trimmed || trimmed.length > 80) {
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "昵称保存失败，请稍后重试。");
    } finally {
      setSavingNickname(false);
    }
  }

  return (
    <AppFrame title="账户中心" subtitle="查看用户资料、积分余额和积分流水，确保每一次发放、消耗和退回都有记录。">
      {message ? (
        <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="space-y-5">
          <Panel>
            <h2 className="text-xl font-semibold">个人资料</h2>
            <div className="mt-5 space-y-4 text-sm text-white/68">
              <div>
                <p className="text-white/50">邮箱</p>
                <p className="mt-1 text-white/82">{user?.email ?? "-"}</p>
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
              <Link
                className="focus-ring mt-4 inline-flex items-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                href="/pricing"
              >
                充值积分
              </Link>
            </div>
          </Panel>

          {recentOrders.length > 0 ? (
            <Panel>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">最近订单</h2>
                <Link
                  className="focus-ring text-sm text-white/50 transition-colors hover:text-white"
                  href="/orders"
                >
                  查看全部
                </Link>
              </div>
              <div className="space-y-3">
                {recentOrders.map((order) => (
                  <article
                    key={order.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{order.orderNo}</p>
                      <p className="mt-0.5 text-xs text-white/46">
                        {formatMoney(order.amountCents, order.currency)} · {formatPaymentProvider(order.paymentProvider)}
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
            {entries.length === 0 ? <p className="text-sm text-white/50">暂无积分流水。</p> : null}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}
