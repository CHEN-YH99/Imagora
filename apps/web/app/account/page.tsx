"use client";

import { useEffect, useState } from "react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  formatLedgerRemark,
  formatNickname,
  getStoredToken,
  type CreditAccount,
  type CreditLedgerEntry,
  type User
} from "../../lib/api";

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setMessage("请先登录后查看账户信息。");
      return;
    }
    Promise.all([
      apiFetch<{ user: User }>("/api/users/me", { token }),
      apiFetch<{ account: CreditAccount }>("/api/users/me/credits", { token }),
      apiFetch<{ entries: CreditLedgerEntry[] }>("/api/users/me/credit-ledger?limit=50", { token })
    ])
      .then(([userResult, accountResult, ledgerResult]) => {
        setUser(userResult.user);
        setAccount(accountResult.account);
        setEntries(ledgerResult.entries);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "账户信息加载失败，请稍后重试。"));
  }, []);

  return (
    <AppFrame title="账户中心" subtitle="查看用户资料、积分余额和积分流水，确保每一次发放、消耗和退回都有记录。">
      {message ? <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p> : null}
      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <Panel>
          <h2 className="text-xl font-semibold">个人资料</h2>
          <div className="mt-5 space-y-3 text-sm text-white/68">
            <p>邮箱：{user?.email ?? "-"}</p>
            <p>昵称：{formatNickname(user?.nickname)}</p>
            <p>角色：<StatusPill>{user?.role ?? "-"}</StatusPill></p>
            <p>状态：<StatusPill>{user?.status ?? "-"}</StatusPill></p>
          </div>
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/24 p-4">
            <p className="text-sm text-white/56">当前余额</p>
            <p className="mt-2 text-4xl font-semibold text-volt">{account ? formatCredits(account.balance) : "-"}</p>
            <p className="mt-2 text-sm text-white/52">
              累计获得 {account ? formatCredits(account.totalEarned) : "0 积分"} · 累计消耗 {account ? formatCredits(account.totalSpent) : "0 积分"}
            </p>
          </div>
        </Panel>
        <Panel>
          <h2 className="mb-4 text-xl font-semibold">积分流水</h2>
          <div className="space-y-3">
            {entries.map((entry) => (
              <article key={entry.id} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <StatusPill>{entry.type}</StatusPill>
                  <p className="mt-2 text-sm text-white/68">{formatLedgerRemark(entry.remark)}</p>
                  <p className="mt-1 text-xs text-white/42">{new Date(entry.createdAt).toLocaleString("zh-CN")}</p>
                </div>
                <p className={entry.amount >= 0 ? "text-lg font-semibold text-mint" : "text-lg font-semibold text-ember"}>
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
