"use client";

import { useEffect, useState } from "react";
import { Check, Coins } from "lucide-react";
import { AppFrame, Panel } from "../../components/AppFrame";
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
  const [plans, setPlans] = useState<Plan[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiFetch<{ plans: Plan[] }>("/api/plans")
      .then((result) => setPlans(result.plans))
      .catch((error) => setMessage(error instanceof Error ? error.message : "套餐加载失败，请稍后重试。"));
  }, []);

  async function buy(planId: string) {
    try {
      const order = await apiFetch<{ order: { id: string }; checkoutUrl: string | null }>("/api/orders", {
        method: "POST",
        body: { planId, paymentProvider }
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
    }
  }

  return (
    <AppFrame title="积分套餐" subtitle="按创作规模选择积分包，套餐价格、积分额度和有效期以服务端配置为准。">
      {message ? (
        <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-3">
        {plans.map((plan, index) => (
          <Panel key={plan.id} className={index === 1 ? "border-mint bg-mint/10" : ""}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold">{formatPlanName(plan.name)}</h2>
                <p className="mt-2 text-sm leading-6 text-white/60">{formatPlanDescription(plan.description)}</p>
              </div>
              {index === 1 ? (
                <span className="rounded-full bg-mint px-3 py-1 text-sm font-semibold text-ink">推荐</span>
              ) : null}
            </div>
            <p className="mt-8 text-5xl font-semibold">{formatMoney(plan.priceCents, plan.currency)}</p>
            <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-volt">
              <Coins className="size-4" aria-hidden="true" />
              {formatCredits(plan.credits)}
            </p>
            <ul className="mt-8 space-y-3 text-sm text-white/70">
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
            <button
              className="focus-ring mt-8 w-full rounded-full bg-white px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-mint"
              type="button"
              onClick={() => buy(plan.id)}
            >
              购买积分
            </button>
          </Panel>
        ))}
      </div>
    </AppFrame>
  );
}
