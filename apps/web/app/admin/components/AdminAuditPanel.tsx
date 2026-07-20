import type { Dispatch, SetStateAction } from "react";
import { EmptyState, Panel } from "../../../components/AppFrame";
import { formatAuditAction, formatTargetType, type AuditLog } from "../../../lib/api";
import { Field } from "./AdminPrimitives";

type AdminAuditPanelProps = {
  logs: AuditLog[];
  adminUserIdFilter: string;
  setAdminUserIdFilter: Dispatch<SetStateAction<string>>;
  auditActionFilter: string;
  setAuditActionFilter: Dispatch<SetStateAction<string>>;
  auditTargetTypeFilter: string;
  setAuditTargetTypeFilter: Dispatch<SetStateAction<string>>;
  auditTargetIdFilter: string;
  setAuditTargetIdFilter: Dispatch<SetStateAction<string>>;
  onRefresh(): void;
};

export function AdminAuditPanel({
  logs,
  adminUserIdFilter,
  setAdminUserIdFilter,
  auditActionFilter,
  setAuditActionFilter,
  auditTargetTypeFilter,
  setAuditTargetTypeFilter,
  auditTargetIdFilter,
  setAuditTargetIdFilter,
  onRefresh
}: AdminAuditPanelProps) {
  return (
    <Panel>
      <h2 className="mb-4 text-xl font-semibold">审计日志</h2>
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <Field label="管理员 ID">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={adminUserIdFilter}
            onChange={(event) => setAdminUserIdFilter(event.target.value)}
          />
        </Field>
        <Field label="操作">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={auditActionFilter}
            onChange={(event) => setAuditActionFilter(event.target.value)}
          />
        </Field>
        <Field label="目标类型">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={auditTargetTypeFilter}
            onChange={(event) => setAuditTargetTypeFilter(event.target.value)}
          />
        </Field>
        <Field label="目标 ID">
          <input
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={auditTargetIdFilter}
            onChange={(event) => setAuditTargetIdFilter(event.target.value)}
          />
        </Field>
      </div>
      <div className="space-y-3">
        {logs.map((log) => (
          <article key={log.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="font-medium">{formatAuditAction(log.action)}</p>
            <p className="mt-1 text-sm text-white/50">
              {formatTargetType(log.targetType)} · {new Date(log.createdAt).toLocaleString("zh-CN")}
            </p>
            <p className="mt-1 break-all text-xs text-white/36">{log.targetId}</p>
          </article>
        ))}
        {logs.length === 0 ? (
          <EmptyState
            title="暂无审计日志"
            description="管理员执行状态变更、积分调整、套餐操作后，会在这里保留痕迹。"
            actionLabel="刷新日志"
            onAction={onRefresh}
          />
        ) : null}
      </div>
    </Panel>
  );
}
