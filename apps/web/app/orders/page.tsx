"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppFrame, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { apiFetch, formatMoney, formatPaymentProvider, type Order } from "../../lib/api";

const ORDER_SYNC_INTERVAL_MS = 5000;

export default function OrdersPage() {
  return (
    <Suspense
      fallback={
        <AppFrame title="订单记录" subtitle="查看积分订单的状态、金额、支付渠道和创建时间，便于核对充值结果。">
          <Panel>
            <p className="text-sm text-white/60">订单加载中...</p>
          </Panel>
        </AppFrame>
      }
    >
      <OrdersView />
    </Suspense>
  );
}

function OrdersView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [returnNotice, setReturnNotice] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);

  const loadOrders = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) {
      setMessage("");
    }
    try {
      const result = await apiFetch<{ orders: Order[] }>("/api/orders");
      setOrders(result.orders);
    } catch (error) {
      if (!background) {
        setMessage(error instanceof Error ? error.message : "订单加载失败，请稍后重试。");
      }
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    const paid = searchParams.get("paid");
    const canceled = searchParams.get("canceled");
    if (paid === "1") {
      setReturnNotice({
        tone: "info",
        text: "支付完成回跳成功。我们正在等待支付平台回调，积分到账后会在订单列表显示已支付。"
      });
      clearPaymentReturnParams();
    } else if (canceled === "1") {
      setReturnNotice({
        tone: "danger",
        text: "你在支付页面取消了支付，订单保持待支付状态。如果是网络异常，可以点击订单上的继续支付重新尝试。"
      });
      clearPaymentReturnParams();
    }
  }, [router, searchParams]);

  useEffect(() => {
    function syncVisibleOrders() {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadOrders({ background: true });
    }

    const intervalId = window.setInterval(syncVisibleOrders, ORDER_SYNC_INTERVAL_MS);
    window.addEventListener("focus", syncVisibleOrders);
    document.addEventListener("visibilitychange", syncVisibleOrders);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncVisibleOrders);
      document.removeEventListener("visibilitychange", syncVisibleOrders);
    };
  }, [loadOrders]);

  function clearPaymentReturnParams() {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("paid");
    url.searchParams.delete("canceled");
    router.replace(`${url.pathname}${url.search}`);
  }

  async function continuePay(order: Order) {
    setPayingOrderId(order.id);
    setMessage("");
    try {
      const result = await apiFetch<{ order: Order; balanceAfter?: number; checkoutUrl?: string | null }>(
        `/api/orders/${order.id}/pay`,
        {
          method: "POST",
          body: {}
        }
      );
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }
      setOrders((current) => current.map((item) => (item.id === order.id ? { ...item, ...result.order } : item)));
      const successText =
        typeof result.balanceAfter === "number" ? "订单已支付成功，当前余额已同步到账。" : "订单状态已同步。";
      await loadOrders();
      // loadOrders 内部会清空 message，成功提示必须在其之后设置，否则一闪而过
      setMessage(successText);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单支付失败，请稍后重试。");
    } finally {
      setPayingOrderId(null);
    }
  }

  return (
    <AppFrame title="订单记录" subtitle="查看积分订单的状态、金额、支付渠道和创建时间，便于核对充值结果。">
      <Panel>
        {returnNotice ? (
          <div className="mb-4">
            <InlineNotice tone={returnNotice.tone === "info" ? "info" : returnNotice.tone}>
              {returnNotice.text}
              {returnNotice.tone === "danger" ? (
                <>
                  {" "}
                  <Link className="underline underline-offset-4" href="/pricing">
                    返回套餐页
                  </Link>
                </>
              ) : (
                <>
                  {" "}
                  <button className="underline underline-offset-4" onClick={() => void loadOrders()} type="button">
                    立即刷新订单
                  </button>
                </>
              )}
            </InlineNotice>
          </div>
        ) : null}
        {message ? (
          <div className="mb-4">
            <InlineNotice tone={message.includes("成功") ? "success" : "danger"}>
              {message}
              {!message.includes("成功") ? (
                <>
                  {" "}
                  <button className="underline underline-offset-4" onClick={() => void loadOrders()} type="button">
                    重新加载订单
                  </button>
                </>
              ) : null}
            </InlineNotice>
          </div>
        ) : null}
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
                {order.status === "PENDING" ? (
                  <p className="mt-2 text-sm text-white/60">订单待支付，继续完成支付后积分会自动到账。</p>
                ) : null}
                {order.status === "CLOSED" ? (
                  <p className="mt-2 text-sm text-ember">订单已关闭，通常是超时未支付。请重新创建新订单。</p>
                ) : null}
                {order.status === "CANCELED" ? (
                  <p className="mt-2 text-sm text-ember">订单已取消，请返回套餐页重新下单。</p>
                ) : null}
                {order.status === "REFUNDED" ? (
                  <p className="mt-2 text-sm text-ember">
                    订单退款成功，请核对账户余额和订单状态，如需继续购买请重新下单。
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col items-start gap-3 md:items-end">
                <div className="flex items-center gap-4">
                  <StatusPill>{order.status}</StatusPill>
                  <p className="font-semibold">{formatMoney(order.amountCents, order.currency)}</p>
                </div>
                {order.status === "PENDING" ? (
                  <button
                    className="focus-ring rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt disabled:opacity-60"
                    disabled={payingOrderId === order.id}
                    onClick={() => void continuePay(order)}
                    type="button"
                  >
                    {payingOrderId === order.id ? "支付中..." : "继续支付"}
                  </button>
                ) : null}
                {order.status === "CLOSED" || order.status === "CANCELED" || order.status === "REFUNDED" ? (
                  <Link
                    className="focus-ring rounded-full border border-white/12 px-4 py-2 text-sm text-white/72 transition-colors hover:bg-white/10 hover:text-white"
                    href="/pricing"
                  >
                    重新购买
                  </Link>
                ) : null}
              </div>
            </article>
          ))}
          {orders.length === 0 ? (
            <EmptyState
              title="暂无订单记录"
              description="购买积分或完成支付后，订单状态、金额、支付渠道和创建时间会显示在这里。"
              actionLabel={message ? "重新加载订单" : "查看积分套餐"}
              actionHref={message ? undefined : "/pricing"}
              onAction={message ? () => void loadOrders() : undefined}
            />
          ) : null}
        </div>
      </Panel>
    </AppFrame>
  );
}
