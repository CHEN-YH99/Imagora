"use client";

import { useEffect, useState } from "react";
import { BarChart3, Shield } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatMoney,
  getStoredToken,
  login,
  setStoredToken,
  type AdminMetrics,
  type GeneratedImage,
  type Order,
  type Plan,
  type SafetyRule,
  type Task,
  type User
} from "../../lib/api";

type AuditLog = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
};

export default function AdminPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [rules, setRules] = useState<SafetyRule[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [newRule, setNewRule] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      load(token);
    } else {
      setMessage("Admin token not found. Use the admin sign-in button.");
    }
  }, []);

  async function loginAdmin() {
    setLoading(true);
    setMessage("");
    try {
      const result = await login("admin@imagora.local", "Admin123!");
      setStoredToken(result.token);
      await load(result.token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Admin login failed");
    } finally {
      setLoading(false);
    }
  }

  async function load(token: string) {
    try {
      const [dashboard, userResult, taskResult, imageResult, orderResult, planResult, ruleResult, logResult] = await Promise.all([
        apiFetch<{ metrics: AdminMetrics }>("/api/admin/dashboard", { token }),
        apiFetch<{ users: User[] }>("/api/admin/users", { token }),
        apiFetch<{ tasks: Task[] }>("/api/admin/generation/tasks", { token }),
        apiFetch<{ images: GeneratedImage[] }>("/api/admin/images", { token }),
        apiFetch<{ orders: Order[] }>("/api/admin/orders", { token }),
        apiFetch<{ plans: Plan[] }>("/api/admin/plans", { token }),
        apiFetch<{ rules: SafetyRule[] }>("/api/admin/safety-rules", { token }),
        apiFetch<{ logs: AuditLog[] }>("/api/admin/audit-logs", { token })
      ]);
      setMetrics(dashboard.metrics);
      setUsers(userResult.users);
      setTasks(taskResult.tasks.slice(0, 12));
      setImages(imageResult.images.slice(0, 8));
      setOrders(orderResult.orders.slice(0, 12));
      setPlans(planResult.plans);
      setRules(ruleResult.rules.slice(0, 12));
      setLogs(logResult.logs.slice(0, 12));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load admin data");
    }
  }

  async function addRule() {
    const token = getStoredToken();
    if (!token || !newRule.trim()) {
      return;
    }
    try {
      await apiFetch<{ rule: SafetyRule }>("/api/admin/safety-rules", {
        method: "POST",
        token,
        body: { term: newRule.trim(), action: "BLOCK", status: "ACTIVE" }
      });
      setNewRule("");
      await load(token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to add rule");
    }
  }

  return (
    <AppFrame title="Admin Console" subtitle="MVP 后台先做可定位、可追踪、可运营，花里胡哨的数据大屏以后再说。">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
          type="button"
          disabled={loading}
          onClick={loginAdmin}
        >
          <Shield className="size-4" aria-hidden="true" />
          {loading ? "Signing in..." : "Sign in as admin"}
        </button>
        {message ? <p className="text-sm text-white/60">{message}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="Users" value={metrics?.users ?? 0} />
        <Metric label="Tasks" value={metrics?.tasks ?? 0} />
        <Metric label="Images" value={metrics?.images ?? 0} />
        <Metric label="Paid orders" value={metrics?.paidOrders ?? 0} />
        <Metric label="Revenue" value={formatMoney(metrics?.paidRevenueCents ?? 0, "USD")} />
        <Metric label="Blocked" value={metrics?.blockedSafetyEvents ?? 0} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
            <BarChart3 className="size-5 text-mint" aria-hidden="true" />
            Users
          </h2>
          <div className="space-y-3">
            {users.map((user) => (
              <article key={user.id} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                <div>
                  <p className="font-medium">{user.email}</p>
                  <p className="mt-1 text-sm text-white/50">{user.nickname}</p>
                </div>
                <StatusPill>
                  {user.role} · {user.status}
                </StatusPill>
              </article>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Tasks</h2>
          <div className="space-y-3">
            {tasks.map((task) => (
              <article key={task.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-1 text-sm text-white/70">{task.prompt}</p>
                  <StatusPill>{task.status}</StatusPill>
                </div>
                <p className="mt-2 text-xs text-white/42">{task.creditCost} credits · {task.style}</p>
              </article>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Images</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {images.map((image) => (
              <img key={image.id} className="aspect-square rounded-2xl border border-white/12 object-cover" src={image.publicUrl} alt="Admin image preview" />
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Orders</h2>
          <div className="space-y-3">
            {orders.map((order) => (
              <article key={order.id} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                <div>
                  <p className="font-medium">{order.orderNo}</p>
                  <p className="mt-1 text-sm text-white/50">{formatMoney(order.amountCents, order.currency)}</p>
                </div>
                <StatusPill>{order.status}</StatusPill>
              </article>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Plans</h2>
          <div className="space-y-3">
            {plans.map((plan) => (
              <article key={plan.id} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                <div>
                  <p className="font-medium">{plan.name}</p>
                  <p className="mt-1 text-sm text-white/50">{plan.credits} credits</p>
                </div>
                <StatusPill>{plan.status}</StatusPill>
              </article>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Safety rules</h2>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row">
            <input
              className="focus-ring min-w-0 flex-1 rounded-full border border-white/12 bg-black/28 px-4 py-3 text-sm text-white"
              value={newRule}
              onChange={(event) => setNewRule(event.target.value)}
              placeholder="Blocked term"
            />
            <button
              className="focus-ring rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
              type="button"
              onClick={addRule}
            >
              Add
            </button>
          </div>
          <div className="space-y-3">
            {rules.map((rule) => (
              <article key={rule.id} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="font-medium">{rule.term}</p>
                <StatusPill>
                  {rule.action} · {rule.status}
                </StatusPill>
              </article>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Audit logs</h2>
          <div className="space-y-3">
            {logs.map((log) => (
              <article key={log.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="font-medium">{log.action}</p>
                <p className="mt-1 text-sm text-white/50">
                  {log.targetType} · {new Date(log.createdAt).toLocaleString()}
                </p>
              </article>
            ))}
            {logs.length === 0 ? <p className="text-sm text-white/50">No audit logs yet.</p> : null}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <Panel>
      <p className="text-sm text-white/50">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </Panel>
  );
}
