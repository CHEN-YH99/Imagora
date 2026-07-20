import type { Dispatch, SetStateAction } from "react";
import { Eye, RefreshCw } from "lucide-react";
import { EmptyState, InlineNotice, Panel, StatusPill } from "../../../components/AppFrame";
import { formatMoney, formatPaymentProvider, formatStatusLabel, type Order } from "../../../lib/api";
import { orderStatusOptions } from "../admin-types";
import { Field } from "./AdminPrimitives";

type AdminOrdersPanelProps = {
  orders: Order[];
  orderNoFilter: string;
  setOrderNoFilter: Dispatch<SetStateAction<string>>;
  orderStatusFilter: "ALL" | Order["status"];
  setOrderStatusFilter: Dispatch<SetStateAction<"ALL" | Order["status"]>>;
  orderQueryPending: boolean;
  hasActiveOrderFilter: boolean;
  highlightedOrderId: string | null;
  onOpenDetail(orderId: string): void;
  onRefresh(): void;
};

export function AdminOrdersPanel({
  orders,
  orderNoFilter,
  setOrderNoFilter,
  orderStatusFilter,
  setOrderStatusFilter,
  orderQueryPending,
  hasActiveOrderFilter,
  highlightedOrderId,
  onOpenDetail,
  onRefresh
}: AdminOrdersPanelProps) {
  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-xl font-semibold">订单管理</h2>
        <div className="grid min-w-[260px] gap-2 sm:grid-cols-2">
          <Field label="订单号筛选">
            <input
              autoComplete="off"
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              placeholder="输入订单号"
              type="search"
              value={orderNoFilter}
              onChange={(event) => setOrderNoFilter(event.target.value)}
            />
          </Field>
          <Field label="订单状态">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={orderStatusFilter}
              onChange={(event) => setOrderStatusFilter(event.target.value as "ALL" | Order["status"])}
            >
              <option value="ALL">全部状态</option>
              {orderStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {formatStatusLabel(status)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <div className="space-y-3">
        {orderQueryPending && orders.length > 0 ? (
          <InlineNotice tone="info">
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
              正在同步订单结果...
            </span>
          </InlineNotice>
        ) : null}
        {orders.map((order) => (
          <article
            key={order.id}
            className={`rounded-2xl border border-white/10 bg-black/20 p-4 transition-all duration-300 ${
              highlightedOrderId === order.id ? "bg-mint/5 ring-2 ring-mint/50 shadow-lg shadow-mint/20" : ""
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{order.orderNo}</p>
                <p className="mt-1 text-sm text-white/50">
                  {formatMoney(order.amountCents, order.currency)} · {formatPaymentProvider(order.paymentProvider)}
                </p>
                <p className="mt-1 break-all text-xs text-white/36">{order.userId}</p>
                <p className="mt-1 text-xs text-white/40">{new Date(order.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusPill>{order.status}</StatusPill>
                <button
                  className="focus-ring inline-flex items-center gap-1 rounded-full border border-white/12 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                  onClick={() => onOpenDetail(order.id)}
                  type="button"
                >
                  <Eye className="size-3" aria-hidden="true" />
                  详情
                </button>
              </div>
            </div>
          </article>
        ))}
        {orders.length === 0 ? (
          orderQueryPending ? (
            <EmptyState title="正在查询订单" description="筛选条件已生效，结果返回前不会先下没有订单的结论。" />
          ) : (
            <EmptyState
              title={hasActiveOrderFilter ? "未找到匹配订单" : "暂无订单记录"}
              description={
                hasActiveOrderFilter ? "当前订单号、状态、用户或时间条件下没有记录。" : "当前没有可展示的订单记录。"
              }
              actionLabel="刷新订单"
              onAction={onRefresh}
            />
          )
        ) : null}
      </div>
    </Panel>
  );
}
