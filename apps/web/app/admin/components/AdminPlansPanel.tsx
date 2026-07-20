import { Plus, Save } from "lucide-react";
import { EmptyState, Panel, StatusPill } from "../../../components/AppFrame";
import { formatCredits, formatMoney, formatPlanName, type Plan } from "../../../lib/api";
import type { PlanFormState } from "../admin-types";
import { Field } from "./AdminPrimitives";

type PlanEdit = Pick<PlanFormState, "priceCents" | "credits" | "sortOrder">;

type AdminPlansPanelProps = {
  plans: Plan[];
  planDraft: PlanFormState;
  planEdits: Record<string, PlanEdit>;
  onUpdatePlanDraft(patch: Partial<PlanFormState>): void;
  onUpdatePlanEdit(planId: string, patch: Partial<PlanEdit>): void;
  onRequestCreate(): void;
  onRequestSave(plan: Plan): void;
  onRequestStatusChange(plan: Plan): void;
  onRefresh(): void;
};

export function AdminPlansPanel({
  plans,
  planDraft,
  planEdits,
  onUpdatePlanDraft,
  onUpdatePlanEdit,
  onRequestCreate,
  onRequestSave,
  onRequestStatusChange,
  onRefresh
}: AdminPlansPanelProps) {
  return (
    <Panel>
      <h2 className="mb-4 text-xl font-semibold">套餐管理</h2>
      <div className="mb-4 grid gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 md:grid-cols-2">
        <Field label="套餐名称">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={planDraft.name}
            onChange={(event) => onUpdatePlanDraft({ name: event.target.value })}
          />
        </Field>
        <Field label="套餐描述">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={planDraft.description}
            onChange={(event) => onUpdatePlanDraft({ description: event.target.value })}
          />
        </Field>
        <Field label="价格（分）">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            inputMode="numeric"
            value={planDraft.priceCents}
            onChange={(event) => onUpdatePlanDraft({ priceCents: event.target.value })}
          />
        </Field>
        <Field label="积分数量">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            inputMode="numeric"
            value={planDraft.credits}
            onChange={(event) => onUpdatePlanDraft({ credits: event.target.value })}
          />
        </Field>
        <Field label="币种代码">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={planDraft.currency}
            onChange={(event) => onUpdatePlanDraft({ currency: event.target.value })}
          />
        </Field>
        <Field label="有效天数">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            inputMode="numeric"
            value={planDraft.validDays}
            onChange={(event) => onUpdatePlanDraft({ validDays: event.target.value })}
          />
        </Field>
        <Field label="套餐状态">
          <select
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={planDraft.status}
            onChange={(event) => onUpdatePlanDraft({ status: event.target.value as Plan["status"] })}
          >
            <option value="ACTIVE">启用</option>
            <option value="INACTIVE">停用</option>
          </select>
        </Field>
        <Field label="排序值">
          <div className="flex gap-2">
            <input
              className="focus-ring min-w-0 flex-1 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              inputMode="numeric"
              value={planDraft.sortOrder}
              onChange={(event) => onUpdatePlanDraft({ sortOrder: event.target.value })}
            />
            <button
              className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
              onClick={onRequestCreate}
              type="button"
            >
              <Plus className="size-4" aria-hidden="true" />
              新增
            </button>
          </div>
        </Field>
      </div>
      <div className="space-y-3">
        {plans.map((plan) => (
          <article key={plan.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-medium">{formatPlanName(plan.name)}</p>
                <p className="mt-1 text-sm text-white/50">
                  {formatMoney(plan.priceCents, plan.currency)} · {formatCredits(plan.credits)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill>{plan.status}</StatusPill>
                <button
                  className="focus-ring rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                  onClick={() => onRequestStatusChange(plan)}
                  type="button"
                >
                  {plan.status === "ACTIVE" ? "停用" : "启用"}
                </button>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Field label="价格（分）">
                <input
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  inputMode="numeric"
                  value={planEdits[plan.id]?.priceCents ?? String(plan.priceCents)}
                  onChange={(event) => onUpdatePlanEdit(plan.id, { priceCents: event.target.value })}
                />
              </Field>
              <Field label="积分数量">
                <input
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  inputMode="numeric"
                  value={planEdits[plan.id]?.credits ?? String(plan.credits)}
                  onChange={(event) => onUpdatePlanEdit(plan.id, { credits: event.target.value })}
                />
              </Field>
              <Field label="排序值">
                <input
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  inputMode="numeric"
                  value={planEdits[plan.id]?.sortOrder ?? String(plan.sortOrder)}
                  onChange={(event) => onUpdatePlanEdit(plan.id, { sortOrder: event.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <button
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-mint/70"
                  onClick={() => onRequestSave(plan)}
                  type="button"
                >
                  <Save className="size-4" aria-hidden="true" />
                  保存
                </button>
              </div>
            </div>
          </article>
        ))}
        {plans.length === 0 ? (
          <EmptyState
            title="暂无套餐配置"
            description="当前还没有套餐，先填写上面的表单并创建第一个积分套餐。"
            actionLabel="刷新套餐"
            onAction={onRefresh}
          />
        ) : null}
      </div>
    </Panel>
  );
}
