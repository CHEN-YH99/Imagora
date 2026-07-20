import type { Dispatch, SetStateAction } from "react";
import { EmptyState, Panel, StatusPill } from "../../../components/AppFrame";
import {
  formatSafetyRuleTerm,
  formatStatusLabel,
  formatTargetType,
  type SafetyAppeal,
  type SafetyEvent,
  type SafetyRule
} from "../../../lib/api";
import { Field } from "./AdminPrimitives";

type AdminModerationPanelProps = {
  rules: SafetyRule[];
  newRule: string;
  setNewRule: Dispatch<SetStateAction<string>>;
  newRuleAction: "BLOCK" | "REVIEW";
  setNewRuleAction: Dispatch<SetStateAction<"BLOCK" | "REVIEW">>;
  safetyEvents: SafetyEvent[];
  safetyAppeals: SafetyAppeal[];
  safetyAppealStatusFilter: "ALL" | SafetyAppeal["status"];
  setSafetyAppealStatusFilter: Dispatch<SetStateAction<"ALL" | SafetyAppeal["status"]>>;
  onAddRule(): void;
  onRequestSafetyEventReview(event: SafetyEvent, nextStatus: Exclude<SafetyEvent["status"], "REVIEW_REQUIRED">): void;
  onRequestSafetyAppealReview(appeal: SafetyAppeal, nextStatus: Exclude<SafetyAppeal["status"], "PENDING">): void;
  onRefresh(): void;
};

export function AdminModerationPanel({
  rules,
  newRule,
  setNewRule,
  newRuleAction,
  setNewRuleAction,
  safetyEvents,
  safetyAppeals,
  safetyAppealStatusFilter,
  setSafetyAppealStatusFilter,
  onAddRule,
  onRequestSafetyEventReview,
  onRequestSafetyAppealReview,
  onRefresh
}: AdminModerationPanelProps) {
  return (
    <>
      <Panel>
        <h2 className="mb-4 text-xl font-semibold">安全规则</h2>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="flex-1" label="拦截词">
            <input
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-4 py-3 text-sm text-white"
              value={newRule}
              onChange={(event) => setNewRule(event.target.value)}
            />
          </Field>
          <Field label="处理动作">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-4 py-3 text-sm text-white sm:w-36"
              value={newRuleAction}
              onChange={(event) => setNewRuleAction(event.target.value === "REVIEW" ? "REVIEW" : "BLOCK")}
            >
              <option value="BLOCK">直接拦截</option>
              <option value="REVIEW">人工复核</option>
            </select>
          </Field>
          <button
            className="focus-ring rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-volt"
            onClick={onAddRule}
            type="button"
          >
            新增
          </button>
        </div>
        <div className="space-y-3">
          {rules.map((rule) => (
            <article
              key={rule.id}
              className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4"
            >
              <p className="font-medium">{formatSafetyRuleTerm(rule.term)}</p>
              <StatusPill>
                {formatStatusLabel(rule.action)} · {formatStatusLabel(rule.status)}
              </StatusPill>
            </article>
          ))}
          {rules.length === 0 ? (
            <EmptyState
              title="暂无安全规则"
              description="当前没有内容拦截规则，新增规则后后台会参与提示词和参考图安全判断。"
              actionLabel="刷新规则"
              onAction={onRefresh}
            />
          ) : null}
        </div>
      </Panel>

      <Panel>
        <h2 className="mb-4 text-xl font-semibold">安全事件</h2>
        <div className="space-y-3">
          {safetyEvents.map((event) => (
            <article key={event.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-medium">{formatStatusLabel(event.status)}</p>
                  <p className="mt-1 text-sm text-white/65">
                    {formatTargetType(event.targetType)} · {event.reasonMessage}
                  </p>
                  <p className="mt-2 font-mono text-xs text-white/45">
                    {event.provider} / {event.reasonCode} / {event.targetId}
                  </p>
                </div>
                {event.status === "REVIEW_REQUIRED" ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      className="focus-ring rounded-full border border-mint/50 px-3 py-2 text-xs font-semibold text-mint hover:bg-mint/10"
                      onClick={() => onRequestSafetyEventReview(event, "PASSED")}
                      type="button"
                    >
                      复核通过
                    </button>
                    <button
                      className="focus-ring rounded-full border border-red-300/40 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-400/10"
                      onClick={() => onRequestSafetyEventReview(event, "BLOCKED")}
                      type="button"
                    >
                      确认拦截
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {safetyEvents.length === 0 ? (
            <EmptyState
              title="暂无安全事件"
              description="命中拦截或人工复核规则后，事件会进入这里供管理员处理和审计。"
              actionLabel="刷新事件"
              onAction={onRefresh}
            />
          ) : null}
        </div>
      </Panel>

      <Panel>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-xl font-semibold">申诉处理</h2>
          <Field className="sm:w-40" label="申诉状态">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={safetyAppealStatusFilter}
              onChange={(event) =>
                setSafetyAppealStatusFilter(
                  event.target.value === "APPROVED" || event.target.value === "REJECTED"
                    ? event.target.value
                    : event.target.value === "PENDING"
                      ? "PENDING"
                      : "ALL"
                )
              }
            >
              <option value="ALL">全部</option>
              <option value="PENDING">待处理</option>
              <option value="APPROVED">已通过</option>
              <option value="REJECTED">已驳回</option>
            </select>
          </Field>
        </div>
        <div className="space-y-3">
          {safetyAppeals.map((appeal) => (
            <article key={appeal.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill>{formatStatusLabel(appeal.status)}</StatusPill>
                    <span className="font-mono text-xs text-white/42">safety-appeal / {appeal.id}</span>
                  </div>
                  <p className="mt-2 text-sm text-white/72">{appeal.reason}</p>
                  <p className="mt-2 break-all text-xs text-white/42">
                    用户 {appeal.userId} · 安全事件 {appeal.safetyEventId}
                  </p>
                  <p className="mt-1 text-xs text-white/42">
                    提交于 {new Date(appeal.createdAt).toLocaleString("zh-CN")}
                    {appeal.resolvedAt ? ` · 处理于 ${new Date(appeal.resolvedAt).toLocaleString("zh-CN")}` : ""}
                  </p>
                  {appeal.adminNote ? (
                    <p className="mt-2 text-xs text-white/52">处理备注：{appeal.adminNote}</p>
                  ) : null}
                </div>
                {appeal.status === "PENDING" ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      className="focus-ring rounded-full border border-mint/50 px-3 py-2 text-xs font-semibold text-mint hover:bg-mint/10"
                      onClick={() => onRequestSafetyAppealReview(appeal, "APPROVED")}
                      type="button"
                    >
                      批准申诉
                    </button>
                    <button
                      className="focus-ring rounded-full border border-red-300/40 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-400/10"
                      onClick={() => onRequestSafetyAppealReview(appeal, "REJECTED")}
                      type="button"
                    >
                      驳回申诉
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {safetyAppeals.length === 0 ? (
            <EmptyState
              title="暂无安全申诉"
              description="用户对安全拦截或人工复核结果发起申诉后，会进入这里等待管理员处理。"
              actionLabel="刷新申诉"
              onAction={onRefresh}
            />
          ) : null}
        </div>
      </Panel>
    </>
  );
}
