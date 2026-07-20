import { X } from "lucide-react";
import { StatusPill } from "../../../components/AppFrame";
import {
  formatCredits,
  formatMoney,
  formatNickname,
  formatPaymentProvider,
  formatQualityLabel,
  formatStyleLabel,
  type Order
} from "../../../lib/api";
import type { SelectedDetail } from "../admin-types";
import { detailDialogLabel } from "../admin-utils";
import { AdminImagePreview, MiniStat } from "./AdminPrimitives";

type AdminDetailDrawerProps = {
  detail: SelectedDetail | null;
  loading: boolean;
  confirmLoading: boolean;
  onClose(): void;
  onRequestRefund(order: Order): void;
};

export function AdminDetailDrawer({
  detail,
  loading,
  confirmLoading,
  onClose,
  onRequestRefund
}: AdminDetailDrawerProps) {
  return (
    <>
      {detail ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-end bg-black/60 p-4"
          onClick={onClose}
          role="presentation"
        >
          <aside
            aria-label={`${detailDialogLabel(detail.kind)}详情`}
            aria-modal="true"
            className="h-full w-full max-w-md overflow-y-auto rounded-[1.5rem] border border-white/12 bg-ink p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">{detailDialogLabel(detail.kind)}详情</h2>
              <button
                className="focus-ring inline-flex size-8 items-center justify-center rounded-full border border-white/12 text-white/60 hover:bg-white/10"
                onClick={onClose}
                type="button"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            {detail.kind === "user" ? (
              <div className="space-y-4 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{detail.data.user.email}</p>
                  <p className="mt-1 text-white/54">{formatNickname(detail.data.user.nickname)}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{detail.data.user.role}</StatusPill>
                    <StatusPill>{detail.data.user.status}</StatusPill>
                    <StatusPill>{detail.data.user.emailVerifiedAt ? "ACTIVE" : "PENDING"}</StatusPill>
                  </div>
                </div>
                {detail.data.account ? (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-white/50">积分余额</p>
                    <p className="mt-1 text-2xl font-semibold text-volt">
                      {formatCredits(detail.data.account.balance)}
                    </p>
                    <p className="mt-1 text-xs text-white/40">
                      累计获得 {formatCredits(detail.data.account.totalEarned)} · 累计消耗{" "}
                      {formatCredits(detail.data.account.totalSpent)}
                    </p>
                  </div>
                ) : null}
                <div className="grid grid-cols-3 gap-3">
                  <MiniStat label="任务" value={detail.data.stats.totalTasks} />
                  <MiniStat label="订单" value={detail.data.stats.paidOrders} />
                  <MiniStat label="图片" value={detail.data.stats.totalImages} />
                </div>
                {detail.data.recentOrders.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">最近订单</p>
                    <div className="space-y-2">
                      {detail.data.recentOrders.map((order) => (
                        <div
                          key={order.id}
                          className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-3"
                        >
                          <div>
                            <p className="text-xs font-medium">{order.orderNo}</p>
                            <p className="mt-0.5 text-xs text-white/40">
                              {formatMoney(order.amountCents, order.currency)}
                            </p>
                          </div>
                          <StatusPill>{order.status}</StatusPill>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.data.recentTasks.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">最近任务</p>
                    <div className="space-y-2">
                      {detail.data.recentTasks.map((task) => (
                        <div key={task.id} className="rounded-xl border border-white/10 bg-white/5 p-3">
                          <p className="line-clamp-1 text-xs text-white/70">{task.prompt}</p>
                          <div className="mt-1 flex items-center gap-2">
                            <StatusPill>{task.status}</StatusPill>
                            <span className="text-xs text-white/40">{formatCredits(task.creditCost)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : detail.kind === "task" ? (
              <div className="space-y-4 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{detail.data.task.prompt}</p>
                  <p className="mt-1 text-xs text-white/40">{detail.data.user.email}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{detail.data.task.status}</StatusPill>
                    <StatusPill>{formatStyleLabel(detail.data.task.style)}</StatusPill>
                    <StatusPill>{formatQualityLabel(detail.data.task.quality)}</StatusPill>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MiniStat label="尺寸" value={`${detail.data.task.width}×${detail.data.task.height}`} />
                  <MiniStat label="数量" value={detail.data.task.quantity} />
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/70">
                  <p>客户端请求：{detail.data.task.clientRequestId}</p>
                  <p className="mt-1">
                    模型：{detail.data.task.modelProvider} / {detail.data.task.modelName}
                  </p>
                  <p className="mt-1">创建时间：{new Date(detail.data.task.createdAt).toLocaleString("zh-CN")}</p>
                  <p className="mt-1">更新时间：{new Date(detail.data.task.updatedAt).toLocaleString("zh-CN")}</p>
                  <p className="mt-1">
                    开始时间：{detail.data.task.startedAt ? new Date(detail.data.task.startedAt).toLocaleString("zh-CN") : "-"}
                  </p>
                  <p className="mt-1">
                    完成时间：
                    {detail.data.task.completedAt ? new Date(detail.data.task.completedAt).toLocaleString("zh-CN") : "-"}
                  </p>
                  <p className="mt-1">失败码：{detail.data.task.failureCode ?? "-"}</p>
                  <p className="mt-1">失败原因：{detail.data.task.failureMessage ?? "-"}</p>
                </div>
                {detail.data.images.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">关联图片</p>
                    <div className="grid grid-cols-2 gap-3">
                      {detail.data.images.map((image) => (
                        <article key={image.id} className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
                          <AdminImagePreview image={image} alt="任务图片" className="aspect-square w-full object-cover" />
                          <div className="space-y-1 p-3 text-xs text-white/60">
                            <p>{image.visibility}</p>
                            <p>
                              {image.width}×{image.height}
                            </p>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : detail.kind === "image" ? (
              <div className="space-y-4 text-sm">
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                  <AdminImagePreview image={detail.data.image} alt="图片详情预览" className="w-full object-cover" />
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{detail.data.user.email}</p>
                  <p className="mt-1 text-xs text-white/40">任务：{detail.data.task.id}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{detail.data.image.visibility}</StatusPill>
                    <StatusPill>{detail.data.image.safetyStatus ?? "UNKNOWN"}</StatusPill>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/70">
                  <p>图片编号：{detail.data.image.id}</p>
                  <p className="mt-1">任务编号：{detail.data.image.taskId}</p>
                  <p className="mt-1">用户编号：{detail.data.image.userId}</p>
                  <p className="mt-1">
                    尺寸：{detail.data.image.width}×{detail.data.image.height}
                  </p>
                  <p className="mt-1">创建时间：{new Date(detail.data.image.createdAt).toLocaleString("zh-CN")}</p>
                  <p className="mt-1">删除时间：{detail.data.image.deletedAt ?? "-"}</p>
                  <p className="mt-1">原图：{detail.data.image.publicUrl}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{detail.data.order.orderNo}</p>
                  <p className="mt-1 text-white/50">
                    {formatMoney(detail.data.order.amountCents, detail.data.order.currency)} ·{" "}
                    {formatPaymentProvider(detail.data.order.paymentProvider)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{detail.data.order.status}</StatusPill>
                    <StatusPill>{detail.data.plan.name}</StatusPill>
                  </div>
                  {detail.data.order.status === "PAID" ? (
                    <button
                      className="focus-ring mt-3 inline-flex items-center gap-2 rounded-full border border-ember/50 bg-ember/12 px-4 py-2 text-xs font-semibold text-ember transition-colors hover:bg-ember/20 disabled:opacity-60"
                      disabled={confirmLoading}
                      onClick={() => onRequestRefund(detail.data.order)}
                      type="button"
                    >
                      发起退款
                    </button>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/70">
                  <p>用户：{detail.data.user.email}</p>
                  <p className="mt-1">支付单号：{detail.data.order.paymentIntentId ?? "-"}</p>
                  <p className="mt-1">套餐：{detail.data.plan.id}</p>
                  <p className="mt-1">创建时间：{new Date(detail.data.order.createdAt).toLocaleString("zh-CN")}</p>
                  <p className="mt-1">
                    更新时间：{detail.data.order.updatedAt ? new Date(detail.data.order.updatedAt).toLocaleString("zh-CN") : "-"}
                  </p>
                  <p className="mt-1">
                    支付时间：{detail.data.order.paidAt ? new Date(detail.data.order.paidAt).toLocaleString("zh-CN") : "-"}
                  </p>
                </div>
                {detail.data.paymentEvents.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">支付事件</p>
                    <div className="space-y-2">
                      {detail.data.paymentEvents.map((event) => (
                        <article key={event.id} className="rounded-xl border border-white/10 bg-white/5 p-3">
                          <p className="text-xs font-medium">{event.eventType}</p>
                          <p className="mt-1 text-xs text-white/40">{event.providerEventId}</p>
                          <p className="mt-1 text-xs text-white/40">
                            {new Date(event.createdAt).toLocaleString("zh-CN")} · 处理于{" "}
                            {new Date(event.processedAt).toLocaleString("zh-CN")}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </aside>
        </div>
      ) : null}

      {loading ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <p className="rounded-2xl border border-white/12 bg-ink px-6 py-4 text-sm text-white/70">正在加载详情...</p>
        </div>
      ) : null}
    </>
  );
}
