import { AlertTriangle } from "lucide-react";
import { EmptyState, Panel, StatusPill } from "../../../components/AppFrame";
import {
  formatMetricLabel,
  formatMoney,
  formatOperationalAlertMessage,
  formatOperationalRunbook,
  formatStatusLabel,
  type AdminMetrics,
  type AdminOperationalMetrics
} from "../../../lib/api";
import { formatMilliseconds } from "../admin-utils";
import { Metric } from "./AdminPrimitives";

type AdminObservabilityProps = {
  metrics: AdminMetrics | null;
  operationalMetrics: AdminOperationalMetrics | null;
  onRefresh(): void;
};

function percentage(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${Math.round(value * 100)}%`;
}

export function AdminObservability({ metrics, operationalMetrics, onRefresh }: AdminObservabilityProps) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="用户数" value={metrics?.users ?? 0} />
        <Metric label="任务数" value={metrics?.tasks ?? 0} />
        <Metric label="图片数" value={metrics?.images ?? 0} />
        <Metric label="已支付订单" value={metrics?.paidOrders ?? 0} />
        <Metric label="收入" value={formatMoney(metrics?.paidRevenueCents ?? 0, "CNY")} />
        <Metric label="安全拦截" value={metrics?.blockedSafetyEvents ?? 0} />
        <Metric label="待复核" value={metrics?.reviewRequiredSafetyEvents ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="请求总数" value={operationalMetrics?.http.requestsTotal ?? 0} />
        <Metric label="接口失败" value={operationalMetrics?.http.failuresTotal ?? 0} />
        <Metric label="生成成功率" value={percentage(operationalMetrics?.domain.generationSuccessRate)} />
        <Metric label="生成失败率" value={percentage(operationalMetrics?.domain.generationFailureRate)} />
        <Metric label="平均生成耗时" value={formatMilliseconds(operationalMetrics?.domain.averageGenerationDurationMs)} />
        <Metric label="平均排队等待" value={formatMilliseconds(operationalMetrics?.domain.averageQueueWaitMs)} />
        <Metric label="支付失败" value={operationalMetrics?.domain.paymentFailuresTotal ?? 0} />
        <Metric label="退回异常" value={operationalMetrics?.domain.refundFailuresTotal ?? 0} />
        <Metric label="参考图" value={operationalMetrics?.domain.referenceImagesTotal ?? 0} />
        <Metric label="支付事件" value={operationalMetrics?.domain.paymentEventsTotal ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Metric label="关闭过期订单" value={operationalMetrics?.maintenance.closedExpiredOrders ?? 0} />
        <Metric label="补发积分订单" value={operationalMetrics?.maintenance.reconciledPaidOrders ?? 0} />
        <Metric label="补处理事件" value={operationalMetrics?.maintenance.reconciledPaymentEvents ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Metric label="在途积分" value={operationalMetrics?.domain.creditsOutstanding ?? 0} />
        <Metric label="7天内到期积分" value={operationalMetrics?.domain.creditsExpiringSoon ?? 0} />
        <Metric label="累计已过期积分" value={operationalMetrics?.domain.creditsExpiredTotal ?? 0} />
        <Metric label="AI成本" value={formatMoney(operationalMetrics?.domain.aiCostCents ?? 0, "CNY")} />
        <Metric label="毛利" value={formatMoney(operationalMetrics?.domain.grossProfitCents ?? 0, "CNY")} />
      </div>

      <Panel className="mt-5">
        <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
          <AlertTriangle className="size-5 text-volt" aria-hidden="true" />
          运营告警
        </h2>
        {operationalMetrics?.alerts.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {operationalMetrics.alerts.map((alert) => (
              <article key={alert.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{formatOperationalAlertMessage(alert.message)}</p>
                    <p className="mt-1 text-sm text-white/50">
                      {formatMetricLabel(alert.metric)}：{alert.value} / {alert.threshold}
                    </p>
                  </div>
                  <StatusPill>{alert.severity}</StatusPill>
                </div>
                <p className="mt-3 text-sm text-white/60">{formatOperationalRunbook(alert.runbook)}</p>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="暂无运营告警"
            description="当前服务指标没有触发阈值告警，继续关注失败率、积压和支付异常即可。"
            actionLabel="刷新指标"
            onAction={onRefresh}
          />
        )}
      </Panel>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
            <AlertTriangle className="size-5 text-volt" aria-hidden="true" />
            最近异常
          </h2>
          {operationalMetrics?.recentIncidents.length ? (
            <div className="space-y-3">
              {operationalMetrics.recentIncidents.map((incident) => (
                <article key={incident.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{incident.message}</p>
                      <p className="mt-1 text-sm text-white/50">
                        {formatMetricLabel(incident.area)} · {incident.errorCode ?? "UNKNOWN"} ·{" "}
                        {new Date(incident.createdAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <StatusPill>{incident.severity}</StatusPill>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-white/50 sm:grid-cols-2">
                    <p>处理状态：{formatStatusLabel(incident.status)}</p>
                    <p className="break-all">requestId：{incident.requestId ?? "-"}</p>
                    <p className="break-all">taskId：{incident.taskId ?? "-"}</p>
                    <p className="break-all">orderId：{incident.orderId ?? "-"}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无最近异常"
              description="生成、支付和接口错误会在这里保留最近记录，便于按 requestId、taskId 或 orderId 追踪。"
              actionLabel="刷新异常"
              onAction={onRefresh}
            />
          )}
        </Panel>

        <Panel>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
            <AlertTriangle className="size-5 text-mint" aria-hidden="true" />
            告警通知
          </h2>
          {operationalMetrics?.alertNotifications.length ? (
            <div className="space-y-3">
              {operationalMetrics.alertNotifications.map((notification) => (
                <article key={notification.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{formatOperationalAlertMessage(notification.message)}</p>
                      <p className="mt-1 text-sm text-white/50">
                        本地通道 · {notification.alertId} · {new Date(notification.sentAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <StatusPill>{notification.status}</StatusPill>
                  </div>
                  <p className="mt-3 break-all text-xs text-white/42">dedupeKey：{notification.dedupeKey}</p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无告警通知"
              description="当运营告警触发时，本地通知通道会记录发送状态和去重键。"
              actionLabel="刷新通知"
              onAction={onRefresh}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
