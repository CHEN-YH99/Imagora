"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, BarChart3, Coins, Eye, EyeOff, Plus, RefreshCw, Save, Shield, X } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatAuditAction,
  formatCredits,
  formatMetricLabel,
  formatMoney,
  formatNickname,
  formatPaymentProvider,
  formatOperationalAlertMessage,
  formatOperationalRunbook,
  formatPlanName,
  formatSafetyRuleTerm,
  formatStatusLabel,
  formatStyleLabel,
  formatTargetType,
  login,
  type AdminMetrics,
  type AdminOperationalMetrics,
  type GeneratedImage,
  type Order,
  type OrderMaintenance,
  type Plan,
  type SafetyRule,
  type Task,
  type User
} from "../../lib/api";

type UserDetail = {
  user: User;
  account: { balance: number; totalEarned: number; totalSpent: number } | undefined;
  stats: {
    totalOrders: number;
    paidOrders: number;
    totalTasks: number;
    succeededTasks: number;
    totalImages: number;
  };
  recentOrders: Order[];
  recentTasks: Task[];
};

type AuditLog = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
};

type CreditAdjustmentDraft = {
  amount: string;
  reason: string;
};

type PlanFormState = {
  name: string;
  description: string;
  priceCents: string;
  currency: string;
  credits: string;
  validDays: string;
  status: Plan["status"];
  sortOrder: string;
};

const emptyPlanForm: PlanFormState = {
  name: "",
  description: "",
  priceCents: "900",
  currency: "CNY",
  credits: "220",
  validDays: "30",
  status: "ACTIVE",
  sortOrder: "40"
};

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export default function AdminPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [operationalMetrics, setOperationalMetrics] = useState<AdminOperationalMetrics | null>(null);
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
  const [maintenanceRunning, setMaintenanceRunning] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState<"ALL" | Task["status"]>("ALL");
  const [orderStatusFilter, setOrderStatusFilter] = useState<"ALL" | Order["status"]>("ALL");
  const [imageVisibilityFilter, setImageVisibilityFilter] = useState<"ALL" | GeneratedImage["visibility"]>("ALL");
  const [orderSearch, setOrderSearch] = useState("");
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [creditAdjustments, setCreditAdjustments] = useState<Record<string, CreditAdjustmentDraft>>({});
  const [planDraft, setPlanDraft] = useState<PlanFormState>(emptyPlanForm);
  const [planEdits, setPlanEdits] = useState<
    Record<string, Pick<PlanFormState, "priceCents" | "credits" | "sortOrder">>
  >({});

  useEffect(() => {
    load();
  }, [taskStatusFilter, orderStatusFilter, imageVisibilityFilter]);

  async function openUserDetail(userId: string) {
    setUserDetailLoading(true);
    setUserDetail(null);
    try {
      const result = await apiFetch<UserDetail>(`/api/admin/users/${userId}`);
      setUserDetail(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "用户详情加载失败。");
    } finally {
      setUserDetailLoading(false);
    }
  }

  async function loginAdmin() {
    setLoading(true);
    setMessage("");
    try {
      await login("admin@imagora.local", "Admin123!");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "管理员登录失败，请检查账号权限。");
    } finally {
      setLoading(false);
    }
  }

  async function load() {
    try {
      const [
        dashboard,
        operations,
        userResult,
        taskResult,
        imageResult,
        orderResult,
        planResult,
        ruleResult,
        logResult
      ] = await Promise.all([
        apiFetch<{ metrics: AdminMetrics }>("/api/admin/dashboard"),
        apiFetch<AdminOperationalMetrics>("/api/admin/metrics"),
        apiFetch<{ users: User[] }>(withQuery("/api/admin/users", { limit: 30 })),
        apiFetch<{ tasks: Task[] }>(
          withQuery("/api/admin/generation/tasks", {
            limit: 30,
            status: taskStatusFilter === "ALL" ? undefined : taskStatusFilter
          })
        ),
        apiFetch<{ images: GeneratedImage[] }>(
          withQuery("/api/admin/images", {
            limit: 24,
            visibility: imageVisibilityFilter === "ALL" ? undefined : imageVisibilityFilter
          })
        ),
        apiFetch<{ orders: Order[] }>(
          withQuery("/api/admin/orders", {
            limit: 30,
            status: orderStatusFilter === "ALL" ? undefined : orderStatusFilter
          })
        ),
        apiFetch<{ plans: Plan[] }>("/api/admin/plans"),
        apiFetch<{ rules: SafetyRule[] }>("/api/admin/safety-rules"),
        apiFetch<{ logs: AuditLog[] }>("/api/admin/audit-logs")
      ]);
      setMetrics(dashboard.metrics);
      setOperationalMetrics(operations);
      setUsers(userResult.users);
      setTasks(taskResult.tasks);
      setImages(imageResult.images);
      setOrders(orderResult.orders);
      setPlans(planResult.plans);
      setPlanEdits(
        Object.fromEntries(
          planResult.plans.map((plan) => [
            plan.id,
            {
              priceCents: String(plan.priceCents),
              credits: String(plan.credits),
              sortOrder: String(plan.sortOrder)
            }
          ])
        )
      );
      setRules(ruleResult.rules.slice(0, 12));
      setLogs(logResult.logs.slice(0, 12));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "后台数据加载失败，请稍后重试。");
    }
  }

  async function updateUserStatus(userId: string, status: User["status"]) {
    try {
      await apiFetch<{ user: User }>(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        body: { status }
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "用户状态更新失败，请稍后重试。");
    }
  }

  function updateCreditDraft(userId: string, patch: Partial<CreditAdjustmentDraft>) {
    setCreditAdjustments((current) => ({
      ...current,
      [userId]: {
        ...(current[userId] ?? { amount: "10", reason: "人工调整积分" }),
        ...patch
      }
    }));
  }

  async function adjustUserCredits(userId: string) {
    const draft = creditAdjustments[userId] ?? { amount: "10", reason: "人工调整积分" };
    const amount = Number(draft.amount);
    if (!Number.isInteger(amount) || amount === 0 || draft.reason.trim().length < 3) {
      setMessage("积分调整必须填写非零整数金额和调整原因。");
      return;
    }
    try {
      await apiFetch<{ account: { balance: number } }>(`/api/admin/users/${userId}/credits/adjust`, {
        method: "POST",
        body: { amount, reason: draft.reason.trim() }
      });
      setCreditAdjustments((current) => ({ ...current, [userId]: { amount: "10", reason: "人工调整积分" } }));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "积分调整失败，请稍后重试。");
    }
  }

  async function updateImageVisibility(imageId: string, visibility: GeneratedImage["visibility"]) {
    try {
      await apiFetch<{ image: GeneratedImage }>(`/api/admin/images/${imageId}/visibility`, {
        method: "PATCH",
        body: { visibility }
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片可见性更新失败，请稍后重试。");
    }
  }

  function updatePlanDraft(patch: Partial<PlanFormState>) {
    setPlanDraft((current) => ({ ...current, ...patch }));
  }

  function updatePlanEdit(planId: string, patch: Partial<Pick<PlanFormState, "priceCents" | "credits" | "sortOrder">>) {
    setPlanEdits((current) => ({
      ...current,
      [planId]: {
        priceCents: current[planId]?.priceCents ?? "0",
        credits: current[planId]?.credits ?? "1",
        sortOrder: current[planId]?.sortOrder ?? "0",
        ...patch
      }
    }));
  }

  async function createPlan() {
    const priceCents = Number(planDraft.priceCents);
    const credits = Number(planDraft.credits);
    const validDays = planDraft.validDays.trim() ? Number(planDraft.validDays) : null;
    const sortOrder = Number(planDraft.sortOrder);
    if (
      !planDraft.name.trim() ||
      !planDraft.description.trim() ||
      !Number.isInteger(priceCents) ||
      !Number.isInteger(credits) ||
      !Number.isInteger(sortOrder) ||
      !(validDays === null || Number.isInteger(validDays))
    ) {
      setMessage("套餐必须填写名称、描述、整数价格、积分数量、有效期和排序值。");
      return;
    }
    try {
      await apiFetch<{ plan: Plan }>("/api/admin/plans", {
        method: "POST",
        body: {
          name: planDraft.name.trim(),
          description: planDraft.description.trim(),
          priceCents,
          currency: planDraft.currency.trim().toUpperCase(),
          credits,
          validDays,
          status: planDraft.status,
          sortOrder
        }
      });
      setPlanDraft(emptyPlanForm);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "套餐创建失败，请稍后重试。");
    }
  }

  async function savePlan(planId: string) {
    const edit = planEdits[planId];
    if (!edit) {
      return;
    }
    const priceCents = Number(edit.priceCents);
    const credits = Number(edit.credits);
    const sortOrder = Number(edit.sortOrder);
    if (!Number.isInteger(priceCents) || !Number.isInteger(credits) || !Number.isInteger(sortOrder)) {
      setMessage("套餐编辑项必须使用整数价格、积分数量和排序值。");
      return;
    }
    try {
      await apiFetch<{ plan: Plan }>(`/api/admin/plans/${planId}`, {
        method: "PATCH",
        body: { priceCents, credits, sortOrder }
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "套餐保存失败，请稍后重试。");
    }
  }

  async function updatePlanStatus(planId: string, status: Plan["status"]) {
    try {
      await apiFetch<{ plan: Plan }>(`/api/admin/plans/${planId}`, {
        method: "PATCH",
        body: { status }
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "套餐状态更新失败，请稍后重试。");
    }
  }

  const visibleTasks = tasks
    .filter((task) => taskStatusFilter === "ALL" || task.status === taskStatusFilter)
    .slice(0, 12);
  const visibleOrders = orders
    .filter((order) => orderStatusFilter === "ALL" || order.status === orderStatusFilter)
    .filter((order) => !orderSearch.trim() || order.orderNo.toLowerCase().includes(orderSearch.trim().toLowerCase()))
    .slice(0, 12);
  const visibleImages = images
    .filter((image) => imageVisibilityFilter === "ALL" || image.visibility === imageVisibilityFilter)
    .slice(0, 8);

  async function addRule() {
    if (!newRule.trim()) {
      return;
    }
    try {
      await apiFetch<{ rule: SafetyRule }>("/api/admin/safety-rules", {
        method: "POST",
        body: { term: newRule.trim(), action: "BLOCK", status: "ACTIVE" }
      });
      setNewRule("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "安全规则添加失败，请稍后重试。");
    }
  }

  async function reconcileOrders() {
    setMaintenanceRunning(true);
    try {
      const result = await apiFetch<{ maintenance: OrderMaintenance }>("/api/admin/maintenance/reconcile", {
        method: "POST",
        body: {}
      });
      await load();
      setMessage(
        `对账完成：关闭过期订单 ${result.maintenance.closedExpiredOrders} 笔，补发已支付积分 ${result.maintenance.reconciledPaidOrders} 笔，补处理支付事件 ${result.maintenance.reconciledPaymentEvents} 条。`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单对账失败，请稍后重试。");
    } finally {
      setMaintenanceRunning(false);
    }
  }

  return (
    <AppFrame
      title="管理控制台"
      subtitle="集中管理用户、生成任务、图片资产、订单、套餐、安全规则和审计记录，保障平台运营可追踪。"
    >
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
          type="button"
          disabled={loading}
          onClick={loginAdmin}
        >
          <Shield className="size-4" aria-hidden="true" />
          {loading ? "登录中..." : "管理员登录"}
        </button>
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-5 py-3 font-semibold text-white transition-colors duration-200 hover:border-mint/70 hover:bg-mint/12 disabled:opacity-60"
          type="button"
          disabled={maintenanceRunning}
          onClick={reconcileOrders}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {maintenanceRunning ? "对账中..." : "订单对账"}
        </button>
        {message ? <p className="text-sm text-white/60">{message}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="用户数" value={metrics?.users ?? 0} />
        <Metric label="任务数" value={metrics?.tasks ?? 0} />
        <Metric label="图片数" value={metrics?.images ?? 0} />
        <Metric label="已支付订单" value={metrics?.paidOrders ?? 0} />
        <Metric label="收入" value={formatMoney(metrics?.paidRevenueCents ?? 0, "USD")} />
        <Metric label="安全拦截" value={metrics?.blockedSafetyEvents ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="请求总数" value={operationalMetrics?.http.requestsTotal ?? 0} />
        <Metric label="接口失败" value={operationalMetrics?.http.failuresTotal ?? 0} />
        <Metric
          label="生成成功率"
          value={
            operationalMetrics?.domain.generationSuccessRate === null ||
            operationalMetrics?.domain.generationSuccessRate === undefined
              ? "-"
              : `${Math.round(operationalMetrics.domain.generationSuccessRate * 100)}%`
          }
        />
        <Metric label="平均生成耗时" value={operationalMetrics?.domain.averageGenerationDurationMs ?? "-"} />
        <Metric label="参考图" value={operationalMetrics?.domain.referenceImagesTotal ?? 0} />
        <Metric label="支付事件" value={operationalMetrics?.domain.paymentEventsTotal ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Metric label="关闭过期订单" value={operationalMetrics?.maintenance.closedExpiredOrders ?? 0} />
        <Metric label="补发积分订单" value={operationalMetrics?.maintenance.reconciledPaidOrders ?? 0} />
        <Metric label="补处理事件" value={operationalMetrics?.maintenance.reconciledPaymentEvents ?? 0} />
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
          <p className="text-sm text-white/50">暂无运营告警。</p>
        )}
      </Panel>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
            <BarChart3 className="size-5 text-mint" aria-hidden="true" />
            用户管理
          </h2>
          <div className="space-y-3">
            {users.map((user) => (
              <article key={user.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{user.email}</p>
                    <p className="mt-1 text-sm text-white/50">{formatNickname(user.nickname)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill>
                      {formatStatusLabel(user.role)} · {formatStatusLabel(user.status)}
                    </StatusPill>
                    <button
                      className="focus-ring cursor-pointer rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                      type="button"
                      onClick={() => void openUserDetail(user.id)}
                    >
                      详情
                    </button>
                    {user.role !== "ADMIN" ? (
                      <button
                        className="focus-ring cursor-pointer rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                        type="button"
                        onClick={() =>
                          void updateUserStatus(user.id, user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")
                        }
                      >
                        {user.status === "ACTIVE" ? "停用" : "启用"}
                      </button>
                    ) : null}
                  </div>
                </div>
                {user.role !== "ADMIN" ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-[90px_1fr_auto]">
                    <input
                      className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                      inputMode="numeric"
                      value={creditAdjustments[user.id]?.amount ?? "10"}
                      onChange={(event) => updateCreditDraft(user.id, { amount: event.target.value })}
                      aria-label={`${user.email} 的积分调整数量`}
                    />
                    <input
                      className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                      value={creditAdjustments[user.id]?.reason ?? "人工调整积分"}
                      onChange={(event) => updateCreditDraft(user.id, { reason: event.target.value })}
                      aria-label={`${user.email} 的积分调整原因`}
                    />
                    <button
                      className="focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                      type="button"
                      onClick={() => void adjustUserCredits(user.id)}
                    >
                      <Coins className="size-4" aria-hidden="true" />
                      调整
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
            {users.length === 0 ? <p className="text-sm text-white/50">暂无用户记录。</p> : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">生成任务</h2>
            <select
              className="focus-ring rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={taskStatusFilter}
              onChange={(event) => setTaskStatusFilter(event.target.value as "ALL" | Task["status"])}
              aria-label="按任务状态筛选"
            >
              <option value="ALL">全部状态</option>
              <option value="PENDING">待处理</option>
              <option value="RUNNING">处理中</option>
              <option value="SUCCEEDED">已完成</option>
              <option value="FAILED">失败</option>
              <option value="BLOCKED">已拦截</option>
              <option value="CANCELED">已取消</option>
            </select>
          </div>
          <div className="space-y-3">
            {visibleTasks.map((task) => (
              <article key={task.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-1 text-sm text-white/70">{task.prompt}</p>
                  <StatusPill>{task.status}</StatusPill>
                </div>
                <p className="mt-2 text-xs text-white/42">
                  {formatCredits(task.creditCost)} · {formatStyleLabel(task.style)}
                </p>
              </article>
            ))}
            {visibleTasks.length === 0 ? <p className="text-sm text-white/50">暂无符合条件的生成任务。</p> : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">图片资产</h2>
            <select
              className="focus-ring rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={imageVisibilityFilter}
              onChange={(event) => setImageVisibilityFilter(event.target.value as "ALL" | GeneratedImage["visibility"])}
              aria-label="按图片可见性筛选"
            >
              <option value="ALL">全部可见性</option>
              <option value="PRIVATE">私有</option>
              <option value="PUBLIC">公开</option>
              <option value="HIDDEN">已隐藏</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {visibleImages.map((image) => (
              <article key={image.id} className="overflow-hidden rounded-2xl border border-white/12 bg-black/20">
                <img className="aspect-square w-full object-cover" src={image.publicUrl} alt="后台图片预览" />
                <div className="space-y-2 p-3">
                  <StatusPill>{image.visibility}</StatusPill>
                  <div className="flex gap-2">
                    <button
                      className="focus-ring inline-flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-full border border-white/12 px-2 py-2 text-xs text-white transition-colors hover:border-mint/70"
                      type="button"
                      onClick={() =>
                        void updateImageVisibility(image.id, image.visibility === "HIDDEN" ? "PRIVATE" : "HIDDEN")
                      }
                    >
                      {image.visibility === "HIDDEN" ? (
                        <Eye className="size-3" aria-hidden="true" />
                      ) : (
                        <EyeOff className="size-3" aria-hidden="true" />
                      )}
                      {image.visibility === "HIDDEN" ? "显示" : "隐藏"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
            {visibleImages.length === 0 ? (
              <p className="col-span-full text-sm text-white/50">暂无符合条件的图片资产。</p>
            ) : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">订单管理</h2>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="focus-ring rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={orderSearch}
                onChange={(event) => setOrderSearch(event.target.value)}
                placeholder="搜索订单号"
                aria-label="搜索订单号"
              />
              <select
                className="focus-ring rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={orderStatusFilter}
                onChange={(event) => setOrderStatusFilter(event.target.value as "ALL" | Order["status"])}
                aria-label="按订单状态筛选"
              >
                <option value="ALL">全部状态</option>
                <option value="PENDING">待处理</option>
                <option value="PAID">已支付</option>
                <option value="CLOSED">已关闭</option>
                <option value="CANCELED">已取消</option>
                <option value="REFUNDED">已退款</option>
              </select>
            </div>
          </div>
          <div className="space-y-3">
            {visibleOrders.map((order) => (
              <article
                key={order.id}
                className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4"
              >
                <div>
                  <p className="font-medium">{order.orderNo}</p>
                  <p className="mt-1 text-sm text-white/50">
                    {formatMoney(order.amountCents, order.currency)} · {formatPaymentProvider(order.paymentProvider)}
                  </p>
                </div>
                <StatusPill>{order.status}</StatusPill>
              </article>
            ))}
            {visibleOrders.length === 0 ? <p className="text-sm text-white/50">暂无符合条件的订单记录。</p> : null}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">套餐管理</h2>
          <div className="mb-4 grid gap-2 rounded-2xl border border-white/10 bg-black/20 p-4 md:grid-cols-2">
            <input
              className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={planDraft.name}
              onChange={(event) => updatePlanDraft({ name: event.target.value })}
              placeholder="套餐名称"
            />
            <input
              className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={planDraft.description}
              onChange={(event) => updatePlanDraft({ description: event.target.value })}
              placeholder="套餐描述"
            />
            <input
              className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              inputMode="numeric"
              value={planDraft.priceCents}
              onChange={(event) => updatePlanDraft({ priceCents: event.target.value })}
              placeholder="价格（分）"
            />
            <input
              className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              inputMode="numeric"
              value={planDraft.credits}
              onChange={(event) => updatePlanDraft({ credits: event.target.value })}
              placeholder="积分数量"
            />
            <input
              className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={planDraft.currency}
              onChange={(event) => updatePlanDraft({ currency: event.target.value })}
              placeholder="币种代码"
            />
            <input
              className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              inputMode="numeric"
              value={planDraft.validDays}
              onChange={(event) => updatePlanDraft({ validDays: event.target.value })}
              placeholder="有效天数"
            />
            <select
              className="focus-ring rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={planDraft.status}
              onChange={(event) => updatePlanDraft({ status: event.target.value as Plan["status"] })}
              aria-label="新套餐状态"
            >
              <option value="ACTIVE">启用</option>
              <option value="INACTIVE">停用</option>
            </select>
            <div className="flex gap-2">
              <input
                className="focus-ring min-w-0 flex-1 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                inputMode="numeric"
                value={planDraft.sortOrder}
                onChange={(event) => updatePlanDraft({ sortOrder: event.target.value })}
                placeholder="排序"
              />
              <button
                className="focus-ring inline-flex cursor-pointer items-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                type="button"
                onClick={() => void createPlan()}
              >
                <Plus className="size-4" aria-hidden="true" />
                新增
              </button>
            </div>
          </div>
          <div className="space-y-3">
            {plans.map((plan) => (
              <article key={plan.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{formatPlanName(plan.name)}</p>
                    <p className="mt-1 text-sm text-white/50">
                      {formatMoney(plan.priceCents, plan.currency)} · {formatCredits(plan.credits)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill>{plan.status}</StatusPill>
                    <button
                      className="focus-ring cursor-pointer rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                      type="button"
                      onClick={() => void updatePlanStatus(plan.id, plan.status === "ACTIVE" ? "INACTIVE" : "ACTIVE")}
                    >
                      {plan.status === "ACTIVE" ? "停用" : "启用"}
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <input
                    className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                    inputMode="numeric"
                    value={planEdits[plan.id]?.priceCents ?? String(plan.priceCents)}
                    onChange={(event) => updatePlanEdit(plan.id, { priceCents: event.target.value })}
                    aria-label={`${formatPlanName(plan.name)} 的价格（分）`}
                  />
                  <input
                    className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                    inputMode="numeric"
                    value={planEdits[plan.id]?.credits ?? String(plan.credits)}
                    onChange={(event) => updatePlanEdit(plan.id, { credits: event.target.value })}
                    aria-label={`${formatPlanName(plan.name)} 的积分数量`}
                  />
                  <input
                    className="focus-ring min-w-0 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                    inputMode="numeric"
                    value={planEdits[plan.id]?.sortOrder ?? String(plan.sortOrder)}
                    onChange={(event) => updatePlanEdit(plan.id, { sortOrder: event.target.value })}
                    aria-label={`${formatPlanName(plan.name)} 的排序值`}
                  />
                  <button
                    className="focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-mint/70"
                    type="button"
                    onClick={() => void savePlan(plan.id)}
                  >
                    <Save className="size-4" aria-hidden="true" />
                    保存
                  </button>
                </div>
              </article>
            ))}
            {plans.length === 0 ? <p className="text-sm text-white/50">暂无套餐配置。</p> : null}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">安全规则</h2>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row">
            <input
              className="focus-ring min-w-0 flex-1 rounded-full border border-white/12 bg-black/28 px-4 py-3 text-sm text-white"
              value={newRule}
              onChange={(event) => setNewRule(event.target.value)}
              placeholder="拦截词"
            />
            <button
              className="focus-ring rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
              type="button"
              onClick={addRule}
            >
              新增
            </button>
          </div>
          <div className="space-y-3">
            {rules.map((rule) => (
              <article
                key={rule.id}
                className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4"
              >
                <p className="font-medium">{formatSafetyRuleTerm(rule.term)}</p>
                <StatusPill>
                  {formatStatusLabel(rule.action)} · {formatStatusLabel(rule.status)}
                </StatusPill>
              </article>
            ))}
            {rules.length === 0 ? <p className="text-sm text-white/50">暂无安全规则。</p> : null}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">审计日志</h2>
          <div className="space-y-3">
            {logs.map((log) => (
              <article key={log.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="font-medium">{formatAuditAction(log.action)}</p>
                <p className="mt-1 text-sm text-white/50">
                  {formatTargetType(log.targetType)} · {new Date(log.createdAt).toLocaleString("zh-CN")}
                </p>
              </article>
            ))}
            {logs.length === 0 ? <p className="text-sm text-white/50">暂无审计日志。</p> : null}
          </div>
        </Panel>
      </div>
      {userDetail ? (
        <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/60 p-4" onClick={() => setUserDetail(null)}>
          <aside
            className="h-full w-full max-w-md overflow-y-auto rounded-[1.5rem] border border-white/12 bg-ink p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">用户详情</h2>
              <button
                className="focus-ring inline-flex size-8 items-center justify-center rounded-full border border-white/12 text-white/60 hover:bg-white/10"
                type="button"
                onClick={() => setUserDetail(null)}
                aria-label="关闭"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-4 text-sm">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="font-medium">{userDetail.user.email}</p>
                <p className="mt-1 text-white/54">{formatNickname(userDetail.user.nickname)}</p>
                <div className="mt-2 flex gap-2">
                  <StatusPill>{userDetail.user.role}</StatusPill>
                  <StatusPill>{userDetail.user.status}</StatusPill>
                </div>
              </div>
              {userDetail.account ? (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-white/50">积分余额</p>
                  <p className="mt-1 text-2xl font-semibold text-volt">{formatCredits(userDetail.account.balance)}</p>
                  <p className="mt-1 text-xs text-white/40">
                    累计获得 {formatCredits(userDetail.account.totalEarned)} · 累计消耗 {formatCredits(userDetail.account.totalSpent)}
                  </p>
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center">
                  <p className="text-lg font-semibold">{userDetail.stats.totalTasks}</p>
                  <p className="mt-1 text-xs text-white/50">任务</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center">
                  <p className="text-lg font-semibold">{userDetail.stats.paidOrders}</p>
                  <p className="mt-1 text-xs text-white/50">订单</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center">
                  <p className="text-lg font-semibold">{userDetail.stats.totalImages}</p>
                  <p className="mt-1 text-xs text-white/50">图片</p>
                </div>
              </div>
              {userDetail.recentOrders.length > 0 ? (
                <div>
                  <p className="mb-2 text-white/50">最近订单</p>
                  <div className="space-y-2">
                    {userDetail.recentOrders.map((order) => (
                      <div key={order.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-3">
                        <div>
                          <p className="text-xs font-medium">{order.orderNo}</p>
                          <p className="mt-0.5 text-xs text-white/40">{formatMoney(order.amountCents, order.currency)}</p>
                        </div>
                        <StatusPill>{order.status}</StatusPill>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {userDetail.recentTasks.length > 0 ? (
                <div>
                  <p className="mb-2 text-white/50">最近任务</p>
                  <div className="space-y-2">
                    {userDetail.recentTasks.map((task) => (
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
          </aside>
        </div>
      ) : null}
      {userDetailLoading ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <p className="rounded-2xl border border-white/12 bg-ink px-6 py-4 text-sm text-white/70">正在加载用户详情...</p>
        </div>
      ) : null}
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
