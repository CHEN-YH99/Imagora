"use client";

import { useEffect, useState } from "react";
import { Check, Coins } from "lucide-react";
import { AppFrame, Panel } from "../../components/AppFrame";
import { apiFetch, formatMoney, getStoredToken, type Plan } from "../../lib/api";

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiFetch<{ plans: Plan[] }>("/api/plans")
      .then((result) => setPlans(result.plans))
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load plans"));
  }, []);

  async function buy(planId: string) {
    const token = getStoredToken();
    if (!token) {
      setMessage("Sign in before buying credits.");
      return;
    }
    try {
      const order = await apiFetch<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        token,
        body: { planId, paymentProvider: "mock" }
      });
      const paid = await apiFetch<{ order: { status: string }; balanceAfter: number }>(`/api/orders/${order.order.id}/pay`, {
        method: "POST",
        token,
        body: {}
      });
      setMessage(`Order ${paid.order.status}. Balance after payment: ${paid.balanceAfter} credits.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payment failed");
    }
  }

  return (
    <AppFrame title="Pricing" subtitle="价格页必须讲清积分和权益，前端价格只展示，真实金额以服务端套餐为准。">
      {message ? <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p> : null}
      <div className="grid gap-5 lg:grid-cols-3">
        {plans.map((plan, index) => (
          <Panel key={plan.id} className={index === 1 ? "border-mint bg-mint/10" : ""}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold">{plan.name}</h2>
                <p className="mt-2 text-sm leading-6 text-white/60">{plan.description}</p>
              </div>
              {index === 1 ? <span className="rounded-full bg-mint px-3 py-1 text-sm font-semibold text-ink">Popular</span> : null}
            </div>
            <p className="mt-8 text-5xl font-semibold">{formatMoney(plan.priceCents, plan.currency)}</p>
            <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-volt">
              <Coins className="size-4" aria-hidden="true" />
              {plan.credits.toLocaleString()} credits
            </p>
            <ul className="mt-8 space-y-3 text-sm text-white/70">
              <li className="flex gap-2">
                <Check className="size-4 text-mint" aria-hidden="true" />
                Mock payment credits arrive immediately
              </li>
              <li className="flex gap-2">
                <Check className="size-4 text-mint" aria-hidden="true" />
                Failed generation tasks are refunded
              </li>
              <li className="flex gap-2">
                <Check className="size-4 text-mint" aria-hidden="true" />
                Valid days: {plan.validDays ?? "no expiry"}
              </li>
            </ul>
            <button
              className="focus-ring mt-8 w-full rounded-full bg-white px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-mint"
              type="button"
              onClick={() => buy(plan.id)}
            >
              Buy credits
            </button>
          </Panel>
        ))}
      </div>
    </AppFrame>
  );
}
