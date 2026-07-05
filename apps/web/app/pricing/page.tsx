"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Check, Coins } from "lucide-react";
import { AppFrame, EmptyState, InlineNotice, Panel } from "../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  formatMoney,
  formatPlanDescription,
  formatPlanName,
  formatStatusLabel,
  type Plan
} from "../../lib/api";

const paymentProvider = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER ?? "mock";

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <AppFrame title="积分套餐" subtitle="按创作规模选择积分包，套餐价格、积分额度和有效期以服务端配置为准。">
          <Panel>
            <p className="text-sm text-white/60">套餐加载中...</p>
          </Panel>
        </AppFrame>
      }
    >
      <PricingView />
    </Suspense>
  );
}

function PricingView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [message, setMessage] = useState("");
  const [returnNotice, setReturnNotice] = useState<{ tone: "danger" | "info"; text: string } | null>(null);
  const [buyingPlanId, setBuyingPlanId] = useState<string | null>(null);

  useEffect(() => {
    const canceled = searchParams.get("canceled");
    if (canceled === "1") {
      setReturnNotice({
        tone: "danger",
        text: "你在支付页面取消了支付，订单仍保留为待支付，可在订单页继续完成支付或重新选择套餐。"
      });
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("canceled");
        router.replace(`${url.pathname}${url.search}`);
      }
    }
    void loadPlans();
  }, []);

  async function loadPlans() {
    setMessage("");
    apiFetch<{ plans: Plan[] }>("/api/plans")
      .then((result) => setPlans(result.plans))
      .catch((error) => setMessage(error instanceof Error ? error.message : "套餐加载失败，请稍后重试。"));
  }

  async function buy(planId: string) {
    if (buyingPlanId) {
      return;
    }

    setBuyingPlanId(planId);
    setMessage("");
    try {
      const order = await apiFetch<{ order: { id: string }; checkoutUrl: string | null }>("/api/orders", {
        method: "POST",
        body: { planId, paymentProvider, clientRequestId: crypto.randomUUID() }
      });
      if (order.checkoutUrl) {
        window.location.href = order.checkoutUrl;
        return;
      }
      const paid = await apiFetch<{ order: { status: string }; balanceAfter: number }>(
        `/api/orders/${order.order.id}/pay`,
        {
          method: "POST",
          body: {}
        }
      );
      setMessage(`订单${formatStatusLabel(paid.order.status)}，支付后余额为 ${formatCredits(paid.balanceAfter)}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "支付失败，请稍后重试。");
    } finally {
      setBuyingPlanId(null);
    }
  }

  return (
    <AppFrame title="积分套餐" subtitle="按创作规模选择积分包，套餐价格、积分额度和有效期以服务端配置为准。">
      {returnNotice ? (
        <div className="mb-5">
          <InlineNotice tone={returnNotice.tone}>{returnNotice.text}</InlineNotice>
        </div>
      ) : null}
      {message ? (
        <div className="mb-5">
          <InlineNotice tone={message.includes("失败") ? "danger" : "success"}>{message}</InlineNotice>
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-3">
        {plans.map((plan, index) => (
          <Panel key={plan.id} className={`flex h-full flex-col ${index === 1 ? "border-mint bg-mint/10" : ""}`}>
            <div className="flex items-start justify-between gap-4 lg:min-h-[7rem]">
              <div>
                <h2 className="text-2xl font-semibold">{formatPlanName(plan.name)}</h2>
                <p className="mt-2 text-sm leading-6 text-white/60">{formatPlanDescription(plan.description)}</p>
              </div>
              {index === 1 ? (
                <span className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-mint px-4 py-1 text-sm font-semibold text-ink">
                  推荐
                </span>
              ) : null}
            </div>
            <div className="pt-8 lg:min-h-[9.5rem]">
              <p className="text-5xl font-semibold">{formatMoney(plan.priceCents, plan.currency)}</p>
              <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-volt">
                <Coins className="size-4" aria-hidden="true" />
                {formatCredits(plan.credits)}
              </p>
            </div>
            <ul className="flex-1 pt-8 space-y-3 text-sm text-white/70">
              <li className="flex gap-2">
                <Check className="size-4 text-mint" aria-hidden="true" />
                支付确认后积分即时到账
              </li>
              <li className="flex gap-2">
                <Check className="size-4 text-mint" aria-hidden="true" />
                系统失败的生成任务自动退回积分
              </li>
              <li className="flex gap-2">
                <Check className="size-4 text-mint" aria-hidden="true" />
                有效期：{plan.validDays ? `${plan.validDays} 天` : "长期有效"}
              </li>
            </ul>
            <div className="mt-auto pt-8">
              {(() => {
                const isBuying = buyingPlanId === plan.id;
                return (
              <button
                className="focus-ring w-full rounded-full bg-white px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-mint disabled:cursor-not-allowed disabled:bg-white/70 disabled:text-ink/70"
                disabled={Boolean(buyingPlanId)}
                type="button"
                onClick={() => buy(plan.id)}
              >
                {isBuying ? "处理中..." : "购买积分"}
              </button>
                );
              })()}
            </div>
          </Panel>
        ))}
        {plans.length === 0 ? (
          <div className="lg:col-span-3">
            <EmptyState
              title="暂无可购买套餐"
              description="当前没有启用的积分套餐，请稍后重试或联系管理员确认套餐配置。"
              actionLabel="重新加载套餐"
              onAction={() => void loadPlans()}
            />
          </div>
        ) : null}
      </div>
    </AppFrame>
  );
}
