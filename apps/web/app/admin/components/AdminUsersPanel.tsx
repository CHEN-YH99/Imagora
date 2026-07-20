import type { Dispatch, SetStateAction } from "react";
import { BarChart3, Coins } from "lucide-react";
import { EmptyState, Panel, StatusPill } from "../../../components/AppFrame";
import { formatNickname, formatStatusLabel, type User } from "../../../lib/api";
import type { CreditAdjustmentDraft } from "../admin-types";
import { Field } from "./AdminPrimitives";

type AdminUsersPanelProps = {
  users: User[];
  userSearch: string;
  setUserSearch: Dispatch<SetStateAction<string>>;
  userStatusFilter: "ALL" | User["status"];
  setUserStatusFilter: Dispatch<SetStateAction<"ALL" | User["status"]>>;
  creditAdjustments: Record<string, CreditAdjustmentDraft>;
  onUpdateCreditDraft(userId: string, patch: Partial<CreditAdjustmentDraft>): void;
  onOpenDetail(userId: string): void;
  onRequestStatusChange(user: User): void;
  onRequestCreditAdjustment(user: User): void;
  onRefresh(): void;
};

export function AdminUsersPanel({
  users,
  userSearch,
  setUserSearch,
  userStatusFilter,
  setUserStatusFilter,
  creditAdjustments,
  onUpdateCreditDraft,
  onOpenDetail,
  onRequestStatusChange,
  onRequestCreditAdjustment,
  onRefresh
}: AdminUsersPanelProps) {
  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <BarChart3 className="size-5 text-mint" aria-hidden="true" />
          用户管理
        </h2>
        <div className="grid min-w-[240px] gap-2 sm:grid-cols-2">
          <Field label="用户搜索">
            <input
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
            />
          </Field>
          <Field label="状态筛选">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={userStatusFilter}
              onChange={(event) => setUserStatusFilter(event.target.value as "ALL" | User["status"])}
            >
              <option value="ALL">全部</option>
              <option value="ACTIVE">启用</option>
              <option value="SUSPENDED">停用</option>
              <option value="DELETED">已删除</option>
            </select>
          </Field>
        </div>
      </div>
      <div className="space-y-3">
        {users.map((user) => (
          <article key={user.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-medium">{user.email}</p>
                <p className="mt-1 text-sm text-white/50">{formatNickname(user.nickname)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill>
                  {formatStatusLabel(user.role)} · {formatStatusLabel(user.status)}
                </StatusPill>
                <button
                  className="focus-ring rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                  onClick={() => onOpenDetail(user.id)}
                  type="button"
                >
                  详情
                </button>
                {user.role !== "ADMIN" ? (
                  <button
                    className="focus-ring rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                    onClick={() => onRequestStatusChange(user)}
                    type="button"
                  >
                    {user.status === "ACTIVE" ? "停用" : "启用"}
                  </button>
                ) : null}
              </div>
            </div>
            {user.role !== "ADMIN" ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-[90px_1fr_auto]">
                <Field label="调整数量">
                  <input
                    className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                    inputMode="numeric"
                    value={creditAdjustments[user.id]?.amount ?? "10"}
                    onChange={(event) => onUpdateCreditDraft(user.id, { amount: event.target.value })}
                  />
                </Field>
                <Field label="调整原因">
                  <input
                    className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                    value={creditAdjustments[user.id]?.reason ?? "人工调整积分"}
                    onChange={(event) => onUpdateCreditDraft(user.id, { reason: event.target.value })}
                  />
                </Field>
                <div className="flex items-end">
                  <button
                    className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                    onClick={() => onRequestCreditAdjustment(user)}
                    type="button"
                  >
                    <Coins className="size-4" aria-hidden="true" />
                    调整
                  </button>
                </div>
              </div>
            ) : null}
          </article>
        ))}
        {users.length === 0 ? (
          <EmptyState
            title="暂无符合条件的用户"
            description="调整搜索词或状态筛选后再试，必要时刷新后台数据。"
            actionLabel="刷新用户列表"
            onAction={onRefresh}
          />
        ) : null}
      </div>
    </Panel>
  );
}
