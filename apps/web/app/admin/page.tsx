"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Coins, Eye, EyeOff, Plus, RefreshCw, Save, Shield, X } from "lucide-react";
import { AppFrame, ConfirmDialog, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatAuditAction,
  formatCredits,
  formatMetricLabel,
  formatMoney,
  formatNickname,
  formatOperationalAlertMessage,
  formatOperationalRunbook,
  formatPaymentProvider,
  formatPlanName,
  formatSafetyRuleTerm,
  formatStatusLabel,
  formatStyleLabel,
  formatTargetType,
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

type PlanPayload = {
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  credits: number;
  validDays: number | null;
  status: Plan["status"];
  sortOrder: number;
};

type Notice = {
  tone: "success" | "danger";
  text: string;
};

type ConfirmState =
  | { kind: "reconcile" }
  | { kind: "user-status"; userId: string; userEmail: string; nextStatus: User["status"] }
  | { kind: "credit-adjust"; userId: string; userEmail: string; amount: number }
  | {
      kind: "image-visibility";
      imageId: string;
      imageLabel: string;
      nextVisibility: GeneratedImage["visibility"];
    }
  | { kind: "plan-status"; planId: string; planName: string; nextStatus: Plan["status"] }
  | { kind: "plan-create"; plan: PlanPayload }
  | {
      kind: "plan-save";
      planId: string;
      planName: string;
      patch: Pick<PlanPayload, "priceCents" | "credits" | "sortOrder">;
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [maintenanceRunning, setMaintenanceRunning] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState<"ALL" | Task["status"]>("ALL");
  const [orderStatusFilter, setOrderStatusFilter] = useState<"ALL" | Order["status"]>("ALL");
  const [imageVisibilityFilter, setImageVisibilityFilter] = useState<"ALL" | GeneratedImage["visibility"]>("ALL");
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<"ALL" | User["status"]>("ALL");
  const [orderSearch, setOrderSearch] = useState("");
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [creditAdjustments, setCreditAdjustments] = useState<Record<string, CreditAdjustmentDraft>>({});
  const [planDraft, setPlanDraft] = useState<PlanFormState>(emptyPlanForm);
  const [planEdits, setPlanEdits] = useState<
    Record<string, Pick<PlanFormState, "priceCents" | "credits" | "sortOrder">>
  >({});
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmReason, setConfirmReason] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);

  useEffect(() => {
    void load();
  }, [taskStatusFilter, orderStatusFilter, imageVisibilityFilter]);

  const visibleUsers = useMemo(
    () =>
      users
        .filter((user) => userStatusFilter === "ALL" || user.status === userStatusFilter)
        .filter((user) => {
          const keyword = userSearch.trim().toLowerCase();
          if (!keyword) {
            return true;
          }
          return user.email.toLowerCase().includes(keyword) || user.nickname.toLowerCase().includes(keyword);
        }),
    [userSearch, userStatusFilter, users]
  );

  const visibleTasks = useMemo(() => tasks.slice(0, 12), [tasks]);

  const visibleImages = useMemo(() => images.slice(0, 8), [images]);

  const visibleOrders = useMemo(
    () =>
      orders
        .filter(
          (order) => !orderSearch.trim() || order.orderNo.toLowerCase().includes(orderSearch.trim().toLowerCase())
        )
        .slice(0, 12),
    [orderSearch, orders]
  );

  async function openUserDetail(userId: string) {
    setUserDetailLoading(true);
    setUserDetail(null);
    try {
      const result = await apiFetch<UserDetail>(`/api/admin/users/${userId}`);
      setUserDetail(result);
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "用户详情加载失败，请稍后重试。" });
    } finally {
      setUserDetailLoading(false);
    }
  }

  async function load(preserveNotice = false) {
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
      if (!preserveNotice) {
        setNotice(null);
      }
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "后台数据加载失败，请稍后重试。" });
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

  function resetConfirm() {
    setConfirmState(null);
    setConfirmReason("");
    setConfirmLoading(false);
  }

  function openConfirm(state: ConfirmState, presetReason = "") {
    setConfirmState(state);
    setConfirmReason(presetReason);
  }

  function parsePlanInput(input: PlanFormState): PlanPayload | null {
    const priceCents = Number(input.priceCents);
    const credits = Number(input.credits);
    const validDays = input.validDays.trim() ? Number(input.validDays) : null;
    const sortOrder = Number(input.sortOrder);
    if (
      !input.name.trim() ||
      !input.description.trim() ||
      !Number.isInteger(priceCents) ||
      priceCents < 0 ||
      !Number.isInteger(credits) ||
      credits < 1 ||
      !Number.isInteger(sortOrder) ||
      !(validDays === null || (Number.isInteger(validDays) && validDays >= 1))
    ) {
      setNotice({ tone: "danger", text: "套餐必须填写名称、描述、整数价格、积分数量、有效期和排序值。" });
      return null;
    }
    return {
      name: input.name.trim(),
      description: input.description.trim(),
      priceCents,
      currency: input.currency.trim().toUpperCase(),
      credits,
      validDays,
      status: input.status,
      sortOrder
    };
  }

  function parsePlanEdit(planId: string): Pick<PlanPayload, "priceCents" | "credits" | "sortOrder"> | null {
    const edit = planEdits[planId];
    if (!edit) {
      return null;
    }
    const priceCents = Number(edit.priceCents);
    const credits = Number(edit.credits);
    const sortOrder = Number(edit.sortOrder);
    if (
      !Number.isInteger(priceCents) ||
      priceCents < 0 ||
      !Number.isInteger(credits) ||
      credits < 1 ||
      !Number.isInteger(sortOrder)
    ) {
      setNotice({ tone: "danger", text: "套餐编辑项必须使用有效的整数价格、积分数量和排序值。" });
      return null;
    }
    return { priceCents, credits, sortOrder };
  }

  function requestUserStatusChange(user: User) {
    const nextStatus = user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    openConfirm({ kind: "user-status", userId: user.id, userEmail: user.email, nextStatus });
  }

  function requestCreditAdjustment(user: User) {
    const draft = creditAdjustments[user.id] ?? { amount: "10", reason: "人工调整积分" };
    const amount = Number(draft.amount);
    if (!Number.isInteger(amount) || amount === 0 || draft.reason.trim().length < 3) {
      setNotice({ tone: "danger", text: "积分调整必须填写非零整数金额和调整原因。" });
      return;
    }
    openConfirm({ kind: "credit-adjust", userId: user.id, userEmail: user.email, amount }, draft.reason.trim());
  }

  function requestImageVisibilityChange(image: GeneratedImage) {
    const nextVisibility = image.visibility === "HIDDEN" ? "PRIVATE" : "HIDDEN";
    openConfirm({
      kind: "image-visibility",
      imageId: image.id,
      imageLabel: image.id.slice(0, 8),
      nextVisibility
    });
  }

  function requestPlanCreate() {
    const parsed = parsePlanInput(planDraft);
    if (!parsed) {
      return;
    }
    openConfirm({ kind: "plan-create", plan: parsed });
  }

  function requestPlanSave(plan: Plan) {
    const patch = parsePlanEdit(plan.id);
    if (!patch) {
      return;
    }
    openConfirm({ kind: "plan-save", planId: plan.id, planName: formatPlanName(plan.name), patch });
  }

  function requestPlanStatusChange(plan: Plan) {
    const nextStatus = plan.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    openConfirm({ kind: "plan-status", planId: plan.id, planName: formatPlanName(plan.name), nextStatus });
  }

  function requestReconcile() {
    openConfirm({ kind: "reconcile" });
  }

  async function addRule() {
    if (newRule.trim().length < 2) {
      setNotice({ tone: "danger", text: "安全规则至少填写 2 个字符，别拿空气当规则。" });
      return;
    }
    try {
      await apiFetch<{ rule: SafetyRule }>("/api/admin/safety-rules", {
        method: "POST",
        body: { term: newRule.trim(), action: "BLOCK", status: "ACTIVE" }
      });
      setNewRule("");
      await load(true);
      setNotice({ tone: "success", text: "安全规则已新增，后续生成会按新规则执行。" });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "安全规则添加失败，请稍后重试。" });
    }
  }

  async function runConfirmedAction() {
    if (!confirmState) {
      return;
    }
    const reason = confirmReason.trim();
    if (reason.length < 3) {
      setNotice({ tone: "danger", text: "危险操作必须填写至少 3 个字符的处理原因。" });
      return;
    }
    setConfirmLoading(true);
    setNotice(null);
    try {
      switch (confirmState.kind) {
        case "reconcile": {
          setMaintenanceRunning(true);
          const result = await apiFetch<{ maintenance: OrderMaintenance }>("/api/admin/maintenance/reconcile", {
            method: "POST",
            body: { reason }
          });
          await load(true);
          setNotice({
            tone: "success",
            text: `对账完成：关闭过期订单 ${result.maintenance.closedExpiredOrders} 笔，补发已支付积分 ${result.maintenance.reconciledPaidOrders} 笔，补处理支付事件 ${result.maintenance.reconciledPaymentEvents} 条。`
          });
          break;
        }
        case "user-status": {
          await apiFetch<{ user: User }>(`/api/admin/users/${confirmState.userId}/status`, {
            method: "PATCH",
            body: { status: confirmState.nextStatus, reason }
          });
          await load(true);
          setNotice({
            tone: "success",
            text: `${confirmState.userEmail} 已更新为${formatStatusLabel(confirmState.nextStatus)}。`
          });
          break;
        }
        case "credit-adjust": {
          await apiFetch<{ account: { balance: number } }>(`/api/admin/users/${confirmState.userId}/credits/adjust`, {
            method: "POST",
            body: { amount: confirmState.amount, reason }
          });
          setCreditAdjustments((current) => ({
            ...current,
            [confirmState.userId]: { amount: "10", reason: "人工调整积分" }
          }));
          await load(true);
          setNotice({
            tone: "success",
            text: `${confirmState.userEmail} 的积分已调整 ${confirmState.amount > 0 ? `+${confirmState.amount}` : confirmState.amount}。`
          });
          break;
        }
        case "image-visibility": {
          await apiFetch<{ image: GeneratedImage }>(`/api/admin/images/${confirmState.imageId}/visibility`, {
            method: "PATCH",
            body: { visibility: confirmState.nextVisibility, reason }
          });
          await load(true);
          setNotice({
            tone: "success",
            text: `图片 ${confirmState.imageLabel} 已${confirmState.nextVisibility === "HIDDEN" ? "隐藏" : "恢复显示"}。`
          });
          break;
        }
        case "plan-status": {
          await apiFetch<{ plan: Plan }>(`/api/admin/plans/${confirmState.planId}`, {
            method: "PATCH",
            body: { status: confirmState.nextStatus, reason }
          });
          await load(true);
          setNotice({
            tone: "success",
            text: `${confirmState.planName} 已${confirmState.nextStatus === "ACTIVE" ? "启用" : "停用"}。`
          });
          break;
        }
        case "plan-create": {
          await apiFetch<{ plan: Plan }>("/api/admin/plans", {
            method: "POST",
            body: { ...confirmState.plan, reason }
          });
          setPlanDraft(emptyPlanForm);
          await load(true);
          setNotice({ tone: "success", text: `新套餐 ${formatPlanName(confirmState.plan.name)} 已创建。` });
          break;
        }
        case "plan-save": {
          await apiFetch<{ plan: Plan }>(`/api/admin/plans/${confirmState.planId}`, {
            method: "PATCH",
            body: { ...confirmState.patch, reason }
          });
          await load(true);
          setNotice({ tone: "success", text: `${confirmState.planName} 的价格、积分和排序已保存。` });
          break;
        }
        default:
          break;
      }
      resetConfirm();
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "管理员操作失败，请稍后重试。" });
    } finally {
      setConfirmLoading(false);
      setMaintenanceRunning(false);
    }
  }

  const confirmMeta = useMemo(() => {
    if (!confirmState) {
      return null;
    }
    switch (confirmState.kind) {
      case "reconcile":
        return {
          title: "确认执行订单对账？",
          description: "这会关闭过期订单并补发遗漏积分，操作完成后应立即复核审计日志。",
          confirmLabel: "执行对账",
          tone: "danger" as const
        };
      case "user-status":
        return {
          title: `确认${confirmState.nextStatus === "SUSPENDED" ? "停用" : "启用"}用户？`,
          description: `${confirmState.userEmail} 的账号状态会立即变化，请填写处理原因后再提交。`,
          confirmLabel: confirmState.nextStatus === "SUSPENDED" ? "确认停用" : "确认启用",
          tone: confirmState.nextStatus === "SUSPENDED" ? ("danger" as const) : ("default" as const)
        };
      case "credit-adjust":
        return {
          title: "确认调整用户积分？",
          description: `${confirmState.userEmail} 将被调整 ${confirmState.amount > 0 ? `+${confirmState.amount}` : confirmState.amount} 积分，账本会保留原因。`,
          confirmLabel: "确认调整",
          tone: "danger" as const
        };
      case "image-visibility":
        return {
          title: `确认${confirmState.nextVisibility === "HIDDEN" ? "隐藏" : "恢复"}图片？`,
          description: `图片 ${confirmState.imageLabel} 的可见性会立即切换，用户侧结果列表也会同步变化。`,
          confirmLabel: confirmState.nextVisibility === "HIDDEN" ? "确认隐藏" : "确认恢复",
          tone: confirmState.nextVisibility === "HIDDEN" ? ("danger" as const) : ("default" as const)
        };
      case "plan-status":
        return {
          title: `确认${confirmState.nextStatus === "ACTIVE" ? "启用" : "停用"}套餐？`,
          description: `${confirmState.planName} 的购买状态会立即变化，请填写处理原因。`,
          confirmLabel: confirmState.nextStatus === "ACTIVE" ? "确认启用" : "确认停用",
          tone: confirmState.nextStatus === "ACTIVE" ? ("default" as const) : ("danger" as const)
        };
      case "plan-create":
        return {
          title: "确认创建新套餐？",
          description: `将创建 ${formatPlanName(confirmState.plan.name)}，请确认价格、积分和有效期已经核对。`,
          confirmLabel: "确认创建",
          tone: "default" as const
        };
      case "plan-save":
        return {
          title: "确认保存套餐改动？",
          description: `${confirmState.planName} 的价格、积分和排序将被更新，请填写修改原因。`,
          confirmLabel: "确认保存",
          tone: "default" as const
        };
      default:
        return null;
    }
  }, [confirmState]);

  return (
    <AppFrame
      title="管理控制台"
      subtitle="集中管理用户、生成任务、图片资产、订单、套餐、安全规则和审计记录，重点防止误操作并保留可追踪上下文。"
    >
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link
          className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors hover:bg-volt"
          href="/login"
        >
          <Shield className="size-4" aria-hidden="true" />
          前往登录
        </Link>
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-5 py-3 font-semibold text-white transition-colors hover:border-mint/70 hover:bg-mint/12 disabled:opacity-60"
          disabled={maintenanceRunning}
          onClick={requestReconcile}
          type="button"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {maintenanceRunning ? "对账中..." : "订单对账"}
        </button>
      </div>

      {notice ? (
        <div className="mb-5">
          <InlineNotice tone={notice.tone}>
            {notice.text}
            {notice.tone === "danger" ? (
              <>
                {" "}
                <button className="underline underline-offset-4" onClick={() => void load()} type="button">
                  重新加载后台
                </button>
              </>
            ) : null}
          </InlineNotice>
        </div>
      ) : null}

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
          <EmptyState
            title="暂无运营告警"
            description="当前服务指标没有触发阈值告警，继续关注失败率、积压和支付异常即可。"
            actionLabel="刷新指标"
            onAction={() => void load()}
          />
        )}
      </Panel>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <BarChart3 className="size-5 text-mint" aria-hidden="true" />
              用户管理
            </h2>
            <div className="grid min-w-[240px] gap-2 sm:grid-cols-2">
              <Field label="用户搜索">
                <input
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                />
              </Field>
              <Field label="状态筛选">
                <select
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  value={userStatusFilter}
                  onChange={(event) => setUserStatusFilter(event.target.value as "ALL" | User["status"])}
                >
                  <option value="ALL">全部</option>
                  <option value="ACTIVE">启用</option>
                  <option value="SUSPENDED">停用</option>
                  <option value="DELETED">已删除</option>
                </select>
              </Field>
            </div>
          </div>
          <div className="space-y-3">
            {visibleUsers.map((user) => (
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
                      className="focus-ring rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                      onClick={() => void openUserDetail(user.id)}
                      type="button"
                    >
                      详情
                    </button>
                    {user.role !== "ADMIN" ? (
                      <button
                        className="focus-ring rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                        onClick={() => requestUserStatusChange(user)}
                        type="button"
                      >
                        {user.status === "ACTIVE" ? "停用" : "启用"}
                      </button>
                    ) : null}
                  </div>
                </div>
                {user.role !== "ADMIN" ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-[90px_1fr_auto]">
                    <Field label="调整数量">
                      <input
                        className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                        inputMode="numeric"
                        value={creditAdjustments[user.id]?.amount ?? "10"}
                        onChange={(event) => updateCreditDraft(user.id, { amount: event.target.value })}
                      />
                    </Field>
                    <Field label="调整原因">
                      <input
                        className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                        value={creditAdjustments[user.id]?.reason ?? "人工调整积分"}
                        onChange={(event) => updateCreditDraft(user.id, { reason: event.target.value })}
                      />
                    </Field>
                    <div className="flex items-end">
                      <button
                        className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                        onClick={() => requestCreditAdjustment(user)}
                        type="button"
                      >
                        <Coins className="size-4" aria-hidden="true" />
                        调整
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
            {visibleUsers.length === 0 ? (
              <EmptyState
                title="暂无符合条件的用户"
                description="调整搜索词或状态筛选后再试，必要时刷新后台数据。"
                actionLabel="刷新用户列表"
                onAction={() => void load()}
              />
            ) : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-xl font-semibold">生成任务</h2>
            <Field label="任务状态">
              <select
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={taskStatusFilter}
                onChange={(event) => setTaskStatusFilter(event.target.value as "ALL" | Task["status"])}
              >
                <option value="ALL">全部状态</option>
                <option value="PENDING">待处理</option>
                <option value="RUNNING">处理中</option>
                <option value="SUCCEEDED">已完成</option>
                <option value="FAILED">失败</option>
                <option value="BLOCKED">已拦截</option>
                <option value="CANCELED">已取消</option>
              </select>
            </Field>
          </div>
          <div className="space-y-3">
            {visibleTasks.map((task) => (
              <article key={task.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm text-white/70">{task.prompt}</p>
                  <StatusPill>{task.status}</StatusPill>
                </div>
                <p className="mt-2 text-xs text-white/42">
                  {formatCredits(task.creditCost)} · {formatStyleLabel(task.style)} · {task.aspectRatio}
                </p>
              </article>
            ))}
            {visibleTasks.length === 0 ? (
              <EmptyState
                title="暂无符合条件的生成任务"
                description="当前筛选条件下没有任务，调整状态筛选或刷新任务列表后再看。"
                actionLabel="刷新任务"
                onAction={() => void load()}
              />
            ) : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-xl font-semibold">图片资产</h2>
            <Field label="可见性筛选">
              <select
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={imageVisibilityFilter}
                onChange={(event) =>
                  setImageVisibilityFilter(event.target.value as "ALL" | GeneratedImage["visibility"])
                }
              >
                <option value="ALL">全部可见性</option>
                <option value="PRIVATE">私有</option>
                <option value="PUBLIC">公开</option>
                <option value="HIDDEN">已隐藏</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {visibleImages.map((image) => (
              <article key={image.id} className="overflow-hidden rounded-2xl border border-white/12 bg-black/20">
                <img className="aspect-square w-full object-cover" src={image.thumbnailUrl} alt="后台图片预览" />
                <div className="space-y-2 p-3">
                  <StatusPill>{image.visibility}</StatusPill>
                  <button
                    className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-2 py-2 text-xs text-white transition-colors hover:border-mint/70"
                    onClick={() => requestImageVisibilityChange(image)}
                    type="button"
                  >
                    {image.visibility === "HIDDEN" ? (
                      <Eye className="size-3" aria-hidden="true" />
                    ) : (
                      <EyeOff className="size-3" aria-hidden="true" />
                    )}
                    {image.visibility === "HIDDEN" ? "恢复显示" : "隐藏图片"}
                  </button>
                </div>
              </article>
            ))}
            {visibleImages.length === 0 ? (
              <div className="col-span-full">
                <EmptyState
                  title="暂无符合条件的图片资产"
                  description="当前筛选条件下没有可见图片，调整筛选后再看。"
                  actionLabel="刷新图片"
                  onAction={() => void load()}
                />
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-xl font-semibold">订单管理</h2>
            <div className="grid min-w-[260px] gap-2 sm:grid-cols-2">
              <Field label="订单号搜索">
                <input
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  value={orderSearch}
                  onChange={(event) => setOrderSearch(event.target.value)}
                />
              </Field>
              <Field label="订单状态">
                <select
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  value={orderStatusFilter}
                  onChange={(event) => setOrderStatusFilter(event.target.value as "ALL" | Order["status"])}
                >
                  <option value="ALL">全部状态</option>
                  <option value="PENDING">待处理</option>
                  <option value="PAID">已支付</option>
                  <option value="CLOSED">已关闭</option>
                  <option value="CANCELED">已取消</option>
                  <option value="REFUNDED">已退款</option>
                </select>
              </Field>
            </div>
          </div>
          <div className="space-y-3">
            {visibleOrders.map((order) => (
              <article key={order.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{order.orderNo}</p>
                    <p className="mt-1 text-sm text-white/50">
                      {formatMoney(order.amountCents, order.currency)} · {formatPaymentProvider(order.paymentProvider)}
                    </p>
                    <p className="mt-1 text-xs text-white/40">{new Date(order.createdAt).toLocaleString("zh-CN")}</p>
                  </div>
                  <StatusPill>{order.status}</StatusPill>
                </div>
              </article>
            ))}
            {visibleOrders.length === 0 ? (
              <EmptyState
                title="暂无符合条件的订单记录"
                description="修改搜索词或状态筛选后再试，必要时执行一次刷新。"
                actionLabel="刷新订单"
                onAction={() => void load()}
              />
            ) : null}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">套餐管理</h2>
          <div className="mb-4 grid gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 md:grid-cols-2">
            <Field label="套餐名称">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={planDraft.name}
                onChange={(event) => updatePlanDraft({ name: event.target.value })}
              />
            </Field>
            <Field label="套餐描述">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={planDraft.description}
                onChange={(event) => updatePlanDraft({ description: event.target.value })}
              />
            </Field>
            <Field label="价格（分）">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                inputMode="numeric"
                value={planDraft.priceCents}
                onChange={(event) => updatePlanDraft({ priceCents: event.target.value })}
              />
            </Field>
            <Field label="积分数量">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                inputMode="numeric"
                value={planDraft.credits}
                onChange={(event) => updatePlanDraft({ credits: event.target.value })}
              />
            </Field>
            <Field label="币种代码">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={planDraft.currency}
                onChange={(event) => updatePlanDraft({ currency: event.target.value })}
              />
            </Field>
            <Field label="有效天数">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                inputMode="numeric"
                value={planDraft.validDays}
                onChange={(event) => updatePlanDraft({ validDays: event.target.value })}
              />
            </Field>
            <Field label="套餐状态">
              <select
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={planDraft.status}
                onChange={(event) => updatePlanDraft({ status: event.target.value as Plan["status"] })}
              >
                <option value="ACTIVE">启用</option>
                <option value="INACTIVE">停用</option>
              </select>
            </Field>
            <Field label="排序值">
              <div className="flex gap-2">
                <input
                  className="focus-ring min-w-0 flex-1 rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                  inputMode="numeric"
                  value={planDraft.sortOrder}
                  onChange={(event) => updatePlanDraft({ sortOrder: event.target.value })}
                />
                <button
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-volt"
                  onClick={requestPlanCreate}
                  type="button"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  新增
                </button>
              </div>
            </Field>
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
                      className="focus-ring rounded-full border border-white/12 bg-white/8 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                      onClick={() => requestPlanStatusChange(plan)}
                      type="button"
                    >
                      {plan.status === "ACTIVE" ? "停用" : "启用"}
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <Field label="价格（分）">
                    <input
                      className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                      inputMode="numeric"
                      value={planEdits[plan.id]?.priceCents ?? String(plan.priceCents)}
                      onChange={(event) => updatePlanEdit(plan.id, { priceCents: event.target.value })}
                    />
                  </Field>
                  <Field label="积分数量">
                    <input
                      className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                      inputMode="numeric"
                      value={planEdits[plan.id]?.credits ?? String(plan.credits)}
                      onChange={(event) => updatePlanEdit(plan.id, { credits: event.target.value })}
                    />
                  </Field>
                  <Field label="排序值">
                    <input
                      className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                      inputMode="numeric"
                      value={planEdits[plan.id]?.sortOrder ?? String(plan.sortOrder)}
                      onChange={(event) => updatePlanEdit(plan.id, { sortOrder: event.target.value })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <button
                      className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-mint/70"
                      onClick={() => requestPlanSave(plan)}
                      type="button"
                    >
                      <Save className="size-4" aria-hidden="true" />
                      保存
                    </button>
                  </div>
                </div>
              </article>
            ))}
            {plans.length === 0 ? (
              <EmptyState
                title="暂无套餐配置"
                description="当前还没有套餐，先填写上面的表单并创建第一个积分套餐。"
                actionLabel="刷新套餐"
                onAction={() => void load()}
              />
            ) : null}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">安全规则</h2>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="flex-1" label="拦截词">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-4 py-3 text-sm text-white"
                value={newRule}
                onChange={(event) => setNewRule(event.target.value)}
              />
            </Field>
            <button
              className="focus-ring rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-volt"
              onClick={() => void addRule()}
              type="button"
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
            {rules.length === 0 ? (
              <EmptyState
                title="暂无安全规则"
                description="当前没有内容拦截规则，新增规则后后台会参与提示词和参考图安全判断。"
                actionLabel="刷新规则"
                onAction={() => void load()}
              />
            ) : null}
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
                <p className="mt-1 break-all text-xs text-white/36">{log.targetId}</p>
              </article>
            ))}
            {logs.length === 0 ? (
              <EmptyState
                title="暂无审计日志"
                description="管理员执行状态变更、积分调整、套餐操作后，会在这里保留痕迹。"
                actionLabel="刷新日志"
                onAction={() => void load()}
              />
            ) : null}
          </div>
        </Panel>
      </div>

      {confirmMeta ? (
        <ConfirmDialog
          open={Boolean(confirmState)}
          title={confirmMeta.title}
          description={confirmMeta.description}
          confirmLabel={confirmMeta.confirmLabel}
          confirmDisabled={confirmReason.trim().length < 3}
          loading={confirmLoading}
          onCancel={resetConfirm}
          onConfirm={() => void runConfirmedAction()}
          tone={confirmMeta.tone}
        >
          <label className="block text-sm text-white/70">
            处理原因
            <textarea
              className="focus-ring mt-2 min-h-28 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              maxLength={240}
              value={confirmReason}
              onChange={(event) => setConfirmReason(event.target.value)}
            />
          </label>
          <p className="mt-2 text-xs text-white/42">
            必填，至少 3 个字符。这个理由是拿来约束操作，不是拿来写“test”的。
          </p>
        </ConfirmDialog>
      ) : null}

      {userDetail ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-end bg-black/60 p-4"
          onClick={() => setUserDetail(null)}
          role="presentation"
        >
          <aside
            aria-label="用户详情"
            aria-modal="true"
            className="h-full w-full max-w-md overflow-y-auto rounded-[1.5rem] border border-white/12 bg-ink p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">用户详情</h2>
              <button
                className="focus-ring inline-flex size-8 items-center justify-center rounded-full border border-white/12 text-white/60 hover:bg-white/10"
                onClick={() => setUserDetail(null)}
                type="button"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-4 text-sm">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="font-medium">{userDetail.user.email}</p>
                <p className="mt-1 text-white/54">{formatNickname(userDetail.user.nickname)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <StatusPill>{userDetail.user.role}</StatusPill>
                  <StatusPill>{userDetail.user.status}</StatusPill>
                  <StatusPill>{userDetail.user.emailVerifiedAt ? "ACTIVE" : "PENDING"}</StatusPill>
                </div>
              </div>
              {userDetail.account ? (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-white/50">积分余额</p>
                  <p className="mt-1 text-2xl font-semibold text-volt">{formatCredits(userDetail.account.balance)}</p>
                  <p className="mt-1 text-xs text-white/40">
                    累计获得 {formatCredits(userDetail.account.totalEarned)} · 累计消耗{" "}
                    {formatCredits(userDetail.account.totalSpent)}
                  </p>
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-3">
                <MiniStat label="任务" value={userDetail.stats.totalTasks} />
                <MiniStat label="订单" value={userDetail.stats.paidOrders} />
                <MiniStat label="图片" value={userDetail.stats.totalImages} />
              </div>
              {userDetail.recentOrders.length > 0 ? (
                <div>
                  <p className="mb-2 text-white/50">最近订单</p>
                  <div className="space-y-2">
                    {userDetail.recentOrders.map((order) => (
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
          <p className="rounded-2xl border border-white/12 bg-ink px-6 py-4 text-sm text-white/70">
            正在加载用户详情...
          </p>
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

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center">
      <p className="text-lg font-semibold">{value}</p>
      <p className="mt-1 text-xs text-white/50">{label}</p>
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs text-white/52 ${className}`}>
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
