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
  formatQualityLabel,
  formatSafetyRuleTerm,
  formatStatusLabel,
  formatStyleLabel,
  formatTargetType,
  type AuditLog,
  type AdminMetrics,
  type AdminOperationalMetrics,
  type GeneratedImage,
  type Order,
  type OrderMaintenance,
  type PaymentEvent,
  type Plan,
  type SafetyEvent,
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

type TaskDetail = {
  task: Task;
  user: User;
  images: GeneratedImage[];
};

type ImageDetail = {
  image: GeneratedImage;
  user: User;
  task: Task;
};

type OrderDetail = {
  order: Order;
  user: User;
  plan: Plan;
  paymentEvents: PaymentEvent[];
};

type SelectedDetail =
  | { kind: "user"; data: UserDetail }
  | { kind: "task"; data: TaskDetail }
  | { kind: "image"; data: ImageDetail }
  | { kind: "order"; data: OrderDetail };

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

// 与后端 ADMIN_CREDIT_ADJUST_THRESHOLD 默认值保持一致：
// 单次调整绝对值达到该阈值即视为大额，必须走强制二次确认（confirm=true）。
const LARGE_CREDIT_ADJUST_THRESHOLD = 1000;

type ConfirmState =
  | { kind: "reconcile" }
  | { kind: "user-status"; userId: string; userEmail: string; nextStatus: User["status"] }
  | { kind: "credit-adjust"; userId: string; userEmail: string; amount: number; clientRequestId: string }
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
    }
  | { kind: "safety-event"; eventId: string; nextStatus: Exclude<SafetyEvent["status"], "REVIEW_REQUIRED"> };

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

function filterValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toApiDateTime(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function detailDialogLabel(kind: SelectedDetail["kind"]): string {
  switch (kind) {
    case "user":
      return "用户";
    case "task":
      return "任务";
    case "image":
      return "图片";
    case "order":
      return "订单";
    default:
      return "详情";
  }
}

function formatMilliseconds(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} 秒`;
  }
  return `${value} ms`;
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
  const [safetyEvents, setSafetyEvents] = useState<SafetyEvent[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [newRule, setNewRule] = useState("");
  const [newRuleAction, setNewRuleAction] = useState<"BLOCK" | "REVIEW">("BLOCK");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [maintenanceRunning, setMaintenanceRunning] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState<"ALL" | Task["status"]>("ALL");
  const [orderStatusFilter, setOrderStatusFilter] = useState<"ALL" | Order["status"]>("ALL");
  const [imageVisibilityFilter, setImageVisibilityFilter] = useState<"ALL" | GeneratedImage["visibility"]>("ALL");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [orderNoFilter, setOrderNoFilter] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<"ALL" | User["status"]>("ALL");
  const [adminUserIdFilter, setAdminUserIdFilter] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [auditTargetTypeFilter, setAuditTargetTypeFilter] = useState("");
  const [auditTargetIdFilter, setAuditTargetIdFilter] = useState("");
  const [selectedDetail, setSelectedDetail] = useState<SelectedDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creditAdjustments, setCreditAdjustments] = useState<Record<string, CreditAdjustmentDraft>>({});
  const [planDraft, setPlanDraft] = useState<PlanFormState>(emptyPlanForm);
  const [planEdits, setPlanEdits] = useState<
    Record<string, Pick<PlanFormState, "priceCents" | "credits" | "sortOrder">>
  >({});
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmReason, setConfirmReason] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);

  // 详情抽屉支持 Escape 关闭：aria-modal 对话框的通用无障碍预期，也避免遮挡后续操作
  useEffect(() => {
    if (!selectedDetail) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedDetail(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedDetail]);

  useEffect(() => {
    void load();
  }, [
    taskStatusFilter,
    orderStatusFilter,
    imageVisibilityFilter,
    createdFrom,
    createdTo,
    userIdFilter,
    orderNoFilter,
    adminUserIdFilter,
    auditActionFilter,
    auditTargetTypeFilter,
    auditTargetIdFilter
  ]);

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

  const visibleOrders = useMemo(() => orders.slice(0, 12), [orders]);

  const visibleSafetyEvents = useMemo(() => safetyEvents.slice(0, 8), [safetyEvents]);

  async function openUserDetail(userId: string) {
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      const result = await apiFetch<UserDetail>(`/api/admin/users/${userId}`);
      setSelectedDetail({ kind: "user", data: result });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "用户详情加载失败，请稍后重试。" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function openTaskDetail(taskId: string) {
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      const result = await apiFetch<TaskDetail>(`/api/admin/generation/tasks/${taskId}`);
      setSelectedDetail({ kind: "task", data: result });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "任务详情加载失败，请稍后重试。" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function openImageDetail(imageId: string) {
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      const result = await apiFetch<ImageDetail>(`/api/admin/images/${imageId}`);
      setSelectedDetail({ kind: "image", data: result });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "图片详情加载失败，请稍后重试。" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function openOrderDetail(orderId: string) {
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      const result = await apiFetch<OrderDetail>(`/api/admin/orders/${orderId}`);
      setSelectedDetail({ kind: "order", data: result });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "订单详情加载失败，请稍后重试。" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function load(preserveNotice = false) {
    try {
      const createdFromFilter = toApiDateTime(createdFrom);
      const createdToFilter = toApiDateTime(createdTo);
      const selectedUserId = filterValue(userIdFilter);
      const [
        dashboard,
        operations,
        userResult,
        taskResult,
        imageResult,
        orderResult,
        planResult,
        ruleResult,
        safetyEventResult,
        logResult
      ] = await Promise.all([
        apiFetch<{ metrics: AdminMetrics }>("/api/admin/dashboard"),
        apiFetch<AdminOperationalMetrics>("/api/admin/metrics"),
        apiFetch<{ users: User[] }>(withQuery("/api/admin/users", { limit: 30 })),
        apiFetch<{ tasks: Task[] }>(
          withQuery("/api/admin/generation/tasks", {
            limit: 30,
            status: taskStatusFilter === "ALL" ? undefined : taskStatusFilter,
            userId: selectedUserId,
            createdFrom: createdFromFilter,
            createdTo: createdToFilter
          })
        ),
        apiFetch<{ images: GeneratedImage[] }>(
          withQuery("/api/admin/images", {
            limit: 24,
            visibility: imageVisibilityFilter === "ALL" ? undefined : imageVisibilityFilter,
            userId: selectedUserId,
            createdFrom: createdFromFilter,
            createdTo: createdToFilter
          })
        ),
        apiFetch<{ orders: Order[] }>(
          withQuery("/api/admin/orders", {
            limit: 30,
            status: orderStatusFilter === "ALL" ? undefined : orderStatusFilter,
            userId: selectedUserId,
            orderNo: filterValue(orderNoFilter),
            createdFrom: createdFromFilter,
            createdTo: createdToFilter
          })
        ),
        apiFetch<{ plans: Plan[] }>("/api/admin/plans"),
        apiFetch<{ rules: SafetyRule[] }>("/api/admin/safety-rules"),
        apiFetch<{ events: SafetyEvent[] }>("/api/admin/safety-events?limit=12"),
        apiFetch<{ logs: AuditLog[] }>(
          withQuery("/api/admin/audit-logs", {
            limit: 30,
            adminUserId: filterValue(adminUserIdFilter),
            action: filterValue(auditActionFilter),
            targetType: filterValue(auditTargetTypeFilter),
            targetId: filterValue(auditTargetIdFilter)
          })
        )
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
      setSafetyEvents(safetyEventResult.events.slice(0, 12));
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

  function resetEnterpriseFilters() {
    setCreatedFrom("");
    setCreatedTo("");
    setUserIdFilter("");
    setOrderNoFilter("");
  }

  function requestCreditAdjustment(user: User) {
    const draft = creditAdjustments[user.id] ?? { amount: "10", reason: "人工调整积分" };
    const amount = Number(draft.amount);
    if (!Number.isInteger(amount) || amount === 0 || draft.reason.trim().length < 3) {
      setNotice({ tone: "danger", text: "积分调整必须填写非零整数金额和调整原因。" });
      return;
    }
    // 幂等键在发起时生成一次并绑定到本次确认，重复点击确认不会叠加扣加积分
    openConfirm(
      { kind: "credit-adjust", userId: user.id, userEmail: user.email, amount, clientRequestId: crypto.randomUUID() },
      draft.reason.trim()
    );
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

  function requestSafetyEventReview(event: SafetyEvent, nextStatus: Exclude<SafetyEvent["status"], "REVIEW_REQUIRED">) {
    openConfirm({ kind: "safety-event", eventId: event.id, nextStatus });
  }

  async function addRule() {
    if (newRule.trim().length < 2) {
      setNotice({ tone: "danger", text: "安全规则至少填写 2 个字符，别拿空气当规则。" });
      return;
    }
    try {
      await apiFetch<{ rule: SafetyRule }>("/api/admin/safety-rules", {
        method: "POST",
        body: { term: newRule.trim(), action: newRuleAction, status: "ACTIVE" }
      });
      setNewRule("");
      setNewRuleAction("BLOCK");
      await load(true);
      setNotice({
        tone: "success",
        text:
          newRuleAction === "REVIEW"
            ? "复核规则已新增，命中后生成会转入人工复核队列。"
            : "安全规则已新增，后续生成会按新规则执行。"
      });
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
          // 执行到此处说明 ConfirmDialog 已被确认，将确认结果透传后端，放行大额调整的二次确认闸门
          await apiFetch<{ account: { balance: number } }>(`/api/admin/users/${confirmState.userId}/credits/adjust`, {
            method: "POST",
            body: { amount: confirmState.amount, reason, confirm: true, clientRequestId: confirmState.clientRequestId }
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
        case "safety-event": {
          await apiFetch<{ event: SafetyEvent }>(`/api/admin/safety-events/${confirmState.eventId}`, {
            method: "PATCH",
            body: { status: confirmState.nextStatus, reason }
          });
          await load(true);
          setNotice({
            tone: "success",
            text: `安全事件已标记为${formatStatusLabel(confirmState.nextStatus)}。`
          });
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
      case "credit-adjust": {
        const isLarge = Math.abs(confirmState.amount) >= LARGE_CREDIT_ADJUST_THRESHOLD;
        return {
          title: isLarge ? "确认大额积分调整？" : "确认调整用户积分？",
          description: isLarge
            ? `⚠️ 本次将调整 ${confirmState.amount > 0 ? `+${confirmState.amount}` : confirmState.amount} 积分，已达到大额阈值（${LARGE_CREDIT_ADJUST_THRESHOLD}）。请再次核对金额与 ${confirmState.userEmail}，确认无误后提交，账本会保留原因。`
            : `${confirmState.userEmail} 将被调整 ${confirmState.amount > 0 ? `+${confirmState.amount}` : confirmState.amount} 积分，账本会保留原因。`,
          confirmLabel: isLarge ? "确认大额调整" : "确认调整",
          tone: "danger" as const
        };
      }
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
      case "safety-event":
        return {
          title: "确认处理安全事件？",
          description: `该安全事件将被标记为${formatStatusLabel(confirmState.nextStatus)}，请填写人工复核原因。`,
          confirmLabel: confirmState.nextStatus === "PASSED" ? "复核通过" : "确认拦截",
          tone: confirmState.nextStatus === "BLOCKED" ? ("danger" as const) : ("default" as const)
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
        <Metric label="待复核" value={metrics?.reviewRequiredSafetyEvents ?? 0} />
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
        <Metric
          label="生成失败率"
          value={
            operationalMetrics?.domain.generationFailureRate === null ||
            operationalMetrics?.domain.generationFailureRate === undefined
              ? "-"
              : `${Math.round(operationalMetrics.domain.generationFailureRate * 100)}%`
          }
        />
        <Metric
          label="平均生成耗时"
          value={formatMilliseconds(operationalMetrics?.domain.averageGenerationDurationMs)}
        />
        <Metric label="平均排队等待" value={formatMilliseconds(operationalMetrics?.domain.averageQueueWaitMs)} />
        <Metric label="支付失败" value={operationalMetrics?.domain.paymentFailuresTotal ?? 0} />
        <Metric label="退回异常" value={operationalMetrics?.domain.refundFailuresTotal ?? 0} />
        <Metric label="参考图" value={operationalMetrics?.domain.referenceImagesTotal ?? 0} />
        <Metric label="支付事件" value={operationalMetrics?.domain.paymentEventsTotal ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Metric label="关闭过期订单" value={operationalMetrics?.maintenance.closedExpiredOrders ?? 0} />
        <Metric label="补发积分订单" value={operationalMetrics?.maintenance.reconciledPaidOrders ?? 0} />
        <Metric label="补处理事件" value={operationalMetrics?.maintenance.reconciledPaymentEvents ?? 0} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Metric label="在途积分" value={operationalMetrics?.domain.creditsOutstanding ?? 0} />
        <Metric label="7天内到期积分" value={operationalMetrics?.domain.creditsExpiringSoon ?? 0} />
        <Metric label="累计已过期积分" value={operationalMetrics?.domain.creditsExpiredTotal ?? 0} />
        <Metric label="AI成本" value={formatMoney(operationalMetrics?.domain.aiCostCents ?? 0, "USD")} />
        <Metric label="毛利" value={formatMoney(operationalMetrics?.domain.grossProfitCents ?? 0, "USD")} />
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
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
            <AlertTriangle className="size-5 text-volt" aria-hidden="true" />
            最近异常
          </h2>
          {operationalMetrics?.recentIncidents.length ? (
            <div className="space-y-3">
              {operationalMetrics.recentIncidents.map((incident) => (
                <article key={incident.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{incident.message}</p>
                      <p className="mt-1 text-sm text-white/50">
                        {formatMetricLabel(incident.area)} · {incident.errorCode ?? "UNKNOWN"} ·{" "}
                        {new Date(incident.createdAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <StatusPill>{incident.severity}</StatusPill>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-white/50 sm:grid-cols-2">
                    <p>处理状态：{formatStatusLabel(incident.status)}</p>
                    <p className="break-all">requestId：{incident.requestId ?? "-"}</p>
                    <p className="break-all">taskId：{incident.taskId ?? "-"}</p>
                    <p className="break-all">orderId：{incident.orderId ?? "-"}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无最近异常"
              description="生成、支付和接口错误会在这里保留最近记录，便于按 requestId、taskId 或 orderId 追踪。"
              actionLabel="刷新异常"
              onAction={() => void load()}
            />
          )}
        </Panel>

        <Panel>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
            <AlertTriangle className="size-5 text-mint" aria-hidden="true" />
            告警通知
          </h2>
          {operationalMetrics?.alertNotifications.length ? (
            <div className="space-y-3">
              {operationalMetrics.alertNotifications.map((notification) => (
                <article key={notification.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{formatOperationalAlertMessage(notification.message)}</p>
                      <p className="mt-1 text-sm text-white/50">
                        本地通道 · {notification.alertId} · {new Date(notification.sentAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <StatusPill>{notification.status}</StatusPill>
                  </div>
                  <p className="mt-3 break-all text-xs text-white/42">dedupeKey：{notification.dedupeKey}</p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无告警通知"
              description="当运营告警触发时，本地通知通道会记录发送状态和去重键。"
              actionLabel="刷新通知"
              onAction={() => void load()}
            />
          )}
        </Panel>
      </div>

      <Panel className="mt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">组合筛选</h2>
          <button
            className="focus-ring rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-mint/70"
            onClick={resetEnterpriseFilters}
            type="button"
          >
            清空筛选
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="时间范围">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                type="datetime-local"
                value={createdFrom}
                onChange={(event) => setCreatedFrom(event.target.value)}
              />
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                type="datetime-local"
                value={createdTo}
                onChange={(event) => setCreatedTo(event.target.value)}
              />
            </div>
          </Field>
          <Field label="用户筛选">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={userIdFilter}
              onChange={(event) => setUserIdFilter(event.target.value)}
            >
              <option value="">全部用户</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.email}
                </option>
              ))}
            </select>
          </Field>
          <Field label="订单号筛选">
            <input
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              placeholder="输入订单号"
              value={orderNoFilter}
              onChange={(event) => setOrderNoFilter(event.target.value)}
            />
          </Field>
          <Field label="筛选说明">
            <p className="rounded-2xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-white/60">
              时间、用户和订单号会同步作用于任务、图片和订单列表。
            </p>
          </Field>
        </div>
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
                  <div>
                    <p className="line-clamp-2 text-sm text-white/70">{task.prompt}</p>
                    <p className="mt-1 break-all text-xs text-white/36">{task.userId}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <StatusPill>{task.status}</StatusPill>
                    <button
                      className="focus-ring inline-flex items-center gap-1 rounded-full border border-white/12 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                      onClick={() => void openTaskDetail(task.id)}
                      type="button"
                    >
                      <Eye className="size-3" aria-hidden="true" />
                      详情
                    </button>
                  </div>
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
                <img
                  className="aspect-square w-full object-cover"
                  src={image.thumbnailUrl}
                  alt="后台图片预览"
                  loading="lazy"
                  decoding="async"
                  width={image.width}
                  height={image.height}
                />
                <div className="space-y-2 p-3">
                  <StatusPill>{image.visibility}</StatusPill>
                  <button
                    className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-2 py-2 text-xs text-white transition-colors hover:border-mint/70"
                    onClick={() => void openImageDetail(image.id)}
                    type="button"
                  >
                    <Eye className="size-3" aria-hidden="true" />
                    详情
                  </button>
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
              <Field label="订单号筛选">
                <input
                  className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
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
                    <p className="mt-1 break-all text-xs text-white/36">{order.userId}</p>
                    <p className="mt-1 text-xs text-white/40">{new Date(order.createdAt).toLocaleString("zh-CN")}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <StatusPill>{order.status}</StatusPill>
                    <button
                      className="focus-ring inline-flex items-center gap-1 rounded-full border border-white/12 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                      onClick={() => void openOrderDetail(order.id)}
                      type="button"
                    >
                      <Eye className="size-3" aria-hidden="true" />
                      详情
                    </button>
                  </div>
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
            <Field label="处理动作">
              <select
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-4 py-3 text-sm text-white sm:w-36"
                value={newRuleAction}
                onChange={(event) => setNewRuleAction(event.target.value === "REVIEW" ? "REVIEW" : "BLOCK")}
              >
                <option value="BLOCK">直接拦截</option>
                <option value="REVIEW">人工复核</option>
              </select>
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
          <h2 className="mb-4 text-xl font-semibold">安全事件</h2>
          <div className="space-y-3">
            {visibleSafetyEvents.map((event) => (
              <article key={event.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-medium">{formatStatusLabel(event.status)}</p>
                    <p className="mt-1 text-sm text-white/65">
                      {formatTargetType(event.targetType)} · {event.reasonMessage}
                    </p>
                    <p className="mt-2 font-mono text-xs text-white/45">
                      {event.provider} / {event.reasonCode} / {event.targetId}
                    </p>
                  </div>
                  {event.status === "REVIEW_REQUIRED" ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button
                        className="focus-ring rounded-full border border-mint/50 px-3 py-2 text-xs font-semibold text-mint hover:bg-mint/10"
                        onClick={() => requestSafetyEventReview(event, "PASSED")}
                        type="button"
                      >
                        复核通过
                      </button>
                      <button
                        className="focus-ring rounded-full border border-red-300/40 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-400/10"
                        onClick={() => requestSafetyEventReview(event, "BLOCKED")}
                        type="button"
                      >
                        确认拦截
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
            {visibleSafetyEvents.length === 0 ? (
              <EmptyState
                title="暂无安全事件"
                description="命中拦截或人工复核规则后，事件会进入这里供管理员处理和审计。"
                actionLabel="刷新事件"
                onAction={() => void load()}
              />
            ) : null}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-semibold">审计日志</h2>
          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <Field label="管理员 ID">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={adminUserIdFilter}
                onChange={(event) => setAdminUserIdFilter(event.target.value)}
              />
            </Field>
            <Field label="操作">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={auditActionFilter}
                onChange={(event) => setAuditActionFilter(event.target.value)}
              />
            </Field>
            <Field label="目标类型">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={auditTargetTypeFilter}
                onChange={(event) => setAuditTargetTypeFilter(event.target.value)}
              />
            </Field>
            <Field label="目标 ID">
              <input
                className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={auditTargetIdFilter}
                onChange={(event) => setAuditTargetIdFilter(event.target.value)}
              />
            </Field>
          </div>
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

      {selectedDetail ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-end bg-black/60 p-4"
          onClick={() => setSelectedDetail(null)}
          role="presentation"
        >
          <aside
            aria-label={`${detailDialogLabel(selectedDetail.kind)}详情`}
            aria-modal="true"
            className="h-full w-full max-w-md overflow-y-auto rounded-[1.5rem] border border-white/12 bg-ink p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">{detailDialogLabel(selectedDetail.kind)}详情</h2>
              <button
                className="focus-ring inline-flex size-8 items-center justify-center rounded-full border border-white/12 text-white/60 hover:bg-white/10"
                onClick={() => setSelectedDetail(null)}
                type="button"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            {selectedDetail.kind === "user" ? (
              <div className="space-y-4 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{selectedDetail.data.user.email}</p>
                  <p className="mt-1 text-white/54">{formatNickname(selectedDetail.data.user.nickname)}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{selectedDetail.data.user.role}</StatusPill>
                    <StatusPill>{selectedDetail.data.user.status}</StatusPill>
                    <StatusPill>{selectedDetail.data.user.emailVerifiedAt ? "ACTIVE" : "PENDING"}</StatusPill>
                  </div>
                </div>
                {selectedDetail.data.account ? (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-white/50">积分余额</p>
                    <p className="mt-1 text-2xl font-semibold text-volt">
                      {formatCredits(selectedDetail.data.account.balance)}
                    </p>
                    <p className="mt-1 text-xs text-white/40">
                      累计获得 {formatCredits(selectedDetail.data.account.totalEarned)} · 累计消耗{" "}
                      {formatCredits(selectedDetail.data.account.totalSpent)}
                    </p>
                  </div>
                ) : null}
                <div className="grid grid-cols-3 gap-3">
                  <MiniStat label="任务" value={selectedDetail.data.stats.totalTasks} />
                  <MiniStat label="订单" value={selectedDetail.data.stats.paidOrders} />
                  <MiniStat label="图片" value={selectedDetail.data.stats.totalImages} />
                </div>
                {selectedDetail.data.recentOrders.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">最近订单</p>
                    <div className="space-y-2">
                      {selectedDetail.data.recentOrders.map((order) => (
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
                {selectedDetail.data.recentTasks.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">最近任务</p>
                    <div className="space-y-2">
                      {selectedDetail.data.recentTasks.map((task) => (
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
            ) : selectedDetail.kind === "task" ? (
              <div className="space-y-4 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{selectedDetail.data.task.prompt}</p>
                  <p className="mt-1 text-xs text-white/40">{selectedDetail.data.user.email}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{selectedDetail.data.task.status}</StatusPill>
                    <StatusPill>{formatStyleLabel(selectedDetail.data.task.style)}</StatusPill>
                    <StatusPill>{formatQualityLabel(selectedDetail.data.task.quality)}</StatusPill>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MiniStat
                    label="尺寸"
                    value={`${selectedDetail.data.task.width}×${selectedDetail.data.task.height}`}
                  />
                  <MiniStat label="数量" value={selectedDetail.data.task.quantity} />
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/70">
                  <p>客户端请求：{selectedDetail.data.task.clientRequestId}</p>
                  <p className="mt-1">
                    模型：{selectedDetail.data.task.modelProvider} / {selectedDetail.data.task.modelName}
                  </p>
                  <p className="mt-1">
                    创建时间：{new Date(selectedDetail.data.task.createdAt).toLocaleString("zh-CN")}
                  </p>
                  <p className="mt-1">
                    更新时间：{new Date(selectedDetail.data.task.updatedAt).toLocaleString("zh-CN")}
                  </p>
                  <p className="mt-1">
                    开始时间：
                    {selectedDetail.data.task.startedAt
                      ? new Date(selectedDetail.data.task.startedAt).toLocaleString("zh-CN")
                      : "-"}
                  </p>
                  <p className="mt-1">
                    完成时间：
                    {selectedDetail.data.task.completedAt
                      ? new Date(selectedDetail.data.task.completedAt).toLocaleString("zh-CN")
                      : "-"}
                  </p>
                  <p className="mt-1">失败码：{selectedDetail.data.task.failureCode ?? "-"}</p>
                  <p className="mt-1">失败原因：{selectedDetail.data.task.failureMessage ?? "-"}</p>
                </div>
                {selectedDetail.data.images.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">关联图片</p>
                    <div className="grid grid-cols-2 gap-3">
                      {selectedDetail.data.images.map((image) => (
                        <article
                          key={image.id}
                          className="overflow-hidden rounded-xl border border-white/10 bg-white/5"
                        >
                          <img
                            src={image.thumbnailUrl}
                            alt="任务图片"
                            className="aspect-square w-full object-cover"
                            loading="lazy"
                            decoding="async"
                            width={image.width}
                            height={image.height}
                          />
                          <div className="space-y-1 p-3 text-xs text-white/60">
                            <p>{image.visibility}</p>
                            <p>
                              {image.width}×{image.height}
                            </p>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : selectedDetail.kind === "image" ? (
              <div className="space-y-4 text-sm">
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                  <img
                    src={selectedDetail.data.image.thumbnailUrl}
                    alt="图片详情预览"
                    className="w-full object-cover"
                    loading="lazy"
                    decoding="async"
                    width={selectedDetail.data.image.width}
                    height={selectedDetail.data.image.height}
                  />
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{selectedDetail.data.user.email}</p>
                  <p className="mt-1 text-xs text-white/40">任务：{selectedDetail.data.task.id}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{selectedDetail.data.image.visibility}</StatusPill>
                    <StatusPill>{selectedDetail.data.image.safetyStatus ?? "UNKNOWN"}</StatusPill>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/70">
                  <p>图片编号：{selectedDetail.data.image.id}</p>
                  <p className="mt-1">任务编号：{selectedDetail.data.image.taskId}</p>
                  <p className="mt-1">用户编号：{selectedDetail.data.image.userId}</p>
                  <p className="mt-1">
                    尺寸：{selectedDetail.data.image.width}×{selectedDetail.data.image.height}
                  </p>
                  <p className="mt-1">
                    创建时间：{new Date(selectedDetail.data.image.createdAt).toLocaleString("zh-CN")}
                  </p>
                  <p className="mt-1">删除时间：{selectedDetail.data.image.deletedAt ?? "-"}</p>
                  <p className="mt-1">原图：{selectedDetail.data.image.publicUrl}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="font-medium">{selectedDetail.data.order.orderNo}</p>
                  <p className="mt-1 text-white/50">
                    {formatMoney(selectedDetail.data.order.amountCents, selectedDetail.data.order.currency)} ·{" "}
                    {formatPaymentProvider(selectedDetail.data.order.paymentProvider)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusPill>{selectedDetail.data.order.status}</StatusPill>
                    <StatusPill>{selectedDetail.data.plan.name}</StatusPill>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/70">
                  <p>用户：{selectedDetail.data.user.email}</p>
                  <p className="mt-1">支付单号：{selectedDetail.data.order.paymentIntentId ?? "-"}</p>
                  <p className="mt-1">套餐：{selectedDetail.data.plan.id}</p>
                  <p className="mt-1">
                    创建时间：{new Date(selectedDetail.data.order.createdAt).toLocaleString("zh-CN")}
                  </p>
                  <p className="mt-1">
                    更新时间：
                    {selectedDetail.data.order.updatedAt
                      ? new Date(selectedDetail.data.order.updatedAt).toLocaleString("zh-CN")
                      : "-"}
                  </p>
                  <p className="mt-1">
                    支付时间：
                    {selectedDetail.data.order.paidAt
                      ? new Date(selectedDetail.data.order.paidAt).toLocaleString("zh-CN")
                      : "-"}
                  </p>
                </div>
                {selectedDetail.data.paymentEvents.length > 0 ? (
                  <div>
                    <p className="mb-2 text-white/50">支付事件</p>
                    <div className="space-y-2">
                      {selectedDetail.data.paymentEvents.map((event) => (
                        <article key={event.id} className="rounded-xl border border-white/10 bg-white/5 p-3">
                          <p className="text-xs font-medium">{event.eventType}</p>
                          <p className="mt-1 text-xs text-white/40">{event.providerEventId}</p>
                          <p className="mt-1 text-xs text-white/40">
                            {new Date(event.createdAt).toLocaleString("zh-CN")} · 处理于{" "}
                            {new Date(event.processedAt).toLocaleString("zh-CN")}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </aside>
        </div>
      ) : null}

      {detailLoading ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <p className="rounded-2xl border border-white/12 bg-ink px-6 py-4 text-sm text-white/70">正在加载详情...</p>
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

function MiniStat({ label, value }: { label: string; value: number | string }) {
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
