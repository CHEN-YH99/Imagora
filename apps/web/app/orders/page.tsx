"use client";

import { useEffect, useState } from "react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import { apiFetch, formatMoney, formatPaymentProvider, type Order } from "../../lib/api";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiFetch<{ orders: Order[] }>("/api/orders")
      .then((result) => setOrders(result.orders))
      .catch((error) => setMessage(error instanceof Error ? error.message : "订单加载失败，请稍后重试。"));
  }, []);

  return (
    <AppFrame title="订单记录" subtitle="查看积分订单的状态、金额、支付渠道和创建时间，便于核对充值结果。">
      <Panel>
        {message ? <p className="mb-4 text-sm text-white/60">{message}</p> : null}
        <div className="space-y-3">
          {orders.map((order) => (
            <article
              key={order.id}
              className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 md:flex-row md:items-center md:justify-between"
            >
              <div>
                <p className="font-semibold">{order.orderNo}</p>
                <p className="mt-1 text-sm text-white/52">
                  {formatPaymentProvider(order.paymentProvider)} · {new Date(order.createdAt).toLocaleString("zh-CN")}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <StatusPill>{order.status}</StatusPill>
                <p className="font-semibold">{formatMoney(order.amountCents, order.currency)}</p>
              </div>
            </article>
          ))}
          {orders.length === 0 ? <p className="text-sm text-white/50">暂无订单记录。</p> : null}
        </div>
      </Panel>
    </AppFrame>
  );
}
