"use client";

import { useEffect, useState } from "react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import { apiFetch, getStoredToken, type CreditAccount, type CreditLedgerEntry, type User } from "../../lib/api";

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setMessage("Sign in first.");
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
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load account"));
  }, []);

  return (
    <AppFrame title="Account" subtitle="账户页展示用户资料、积分余额和流水，积分账本不能靠嘴说，必须可追踪。">
      {message ? <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p> : null}
      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <Panel>
          <h2 className="text-xl font-semibold">Profile</h2>
          <div className="mt-5 space-y-3 text-sm text-white/68">
            <p>Email: {user?.email ?? "-"}</p>
            <p>Nickname: {user?.nickname ?? "-"}</p>
            <p>Role: {user?.role ?? "-"}</p>
            <p>Status: {user?.status ?? "-"}</p>
          </div>
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/24 p-4">
            <p className="text-sm text-white/56">Current balance</p>
            <p className="mt-2 text-4xl font-semibold text-volt">{account?.balance.toLocaleString() ?? "-"}</p>
            <p className="mt-2 text-sm text-white/52">
              Earned {account?.totalEarned ?? 0} · Spent {account?.totalSpent ?? 0}
            </p>
          </div>
        </Panel>
        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Credit ledger</h2>
          <div className="space-y-3">
            {entries.map((entry) => (
              <article key={entry.id} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <StatusPill>{entry.type}</StatusPill>
                  <p className="mt-2 text-sm text-white/68">{entry.remark}</p>
                  <p className="mt-1 text-xs text-white/42">{new Date(entry.createdAt).toLocaleString()}</p>
                </div>
                <p className={entry.amount >= 0 ? "text-lg font-semibold text-mint" : "text-lg font-semibold text-ember"}>
                  {entry.amount >= 0 ? "+" : ""}
                  {entry.amount}
                </p>
              </article>
            ))}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}
