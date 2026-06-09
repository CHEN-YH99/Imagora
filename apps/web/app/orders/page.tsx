"use client";

import { useEffect, useState } from "react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import { apiFetch, formatMoney, getStoredToken, type Order } from "../../lib/api";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setMessage("Sign in first.");
      return;
    }
    apiFetch<{ orders: Order[] }>("/api/orders", { token })
      .then((result) => setOrders(result.orders))
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load orders"));
  }, []);

  return (
    <AppFrame title="Orders" subtitle="订单状态、金额和支付渠道集中展示，支付幂等别藏在黑箱里。">
      <Panel>
        {message ? <p className="mb-4 text-sm text-white/60">{message}</p> : null}
        <div className="space-y-3">
          {orders.map((order) => (
            <article key={order.id} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-semibold">{order.orderNo}</p>
                <p className="mt-1 text-sm text-white/52">
                  {order.paymentProvider} · {new Date(order.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <StatusPill>{order.status}</StatusPill>
                <p className="font-semibold">{formatMoney(order.amountCents, order.currency)}</p>
              </div>
            </article>
          ))}
          {orders.length === 0 ? <p className="text-sm text-white/50">No orders yet.</p> : null}
        </div>
      </Panel>
    </AppFrame>
  );
}
