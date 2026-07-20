"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AppFrame, ConfirmDialog, InlineNotice, Panel, ToastContainer } from "../../components/AppFrame";
import { toast } from "sonner";
import {
  apiFetch,
  ApiRequestError,
  formatCredits,
  formatMoney,
  formatPlanName,
  formatStatusLabel,
  type AuditLog,
  type AdminMetrics,
  type AdminOperationalMetrics,
  type GeneratedImage,
  type Order,
  type OrderMaintenance,
  type Plan,
  type SafetyAppeal,
  type SafetyEvent,
  type SafetyRule,
  type Task,
  type User
} from "../../lib/api";
import {
  LARGE_CREDIT_ADJUST_THRESHOLD,
  emptyPlanForm,
  type AdminOrderQuery,
  type ConfirmState,
  type CreditAdjustmentDraft,
  type ImageDetail,
  type Notice,
  type OrderDetail,
  type PlanFormState,
  type PlanPayload,
  type SelectedDetail,
  type TaskDetail,
  type UserDetail
} from "./admin-types";
import {
  buildOrderQueryKey,
  filterValue,
  mergeOrderCache,
  orderMatchesQuery,
  toApiDateTime,
  withQuery
} from "./admin-utils";
import { AdminAuditPanel } from "./components/AdminAuditPanel";
import { AdminDetailDrawer } from "./components/AdminDetailDrawer";
import { AdminFiltersPanel } from "./components/AdminFiltersPanel";
import { AdminGenerationPanels } from "./components/AdminGenerationPanels";
import { AdminModerationPanel } from "./components/AdminModerationPanel";
import { AdminObservability } from "./components/AdminObservability";
import { AdminOrdersPanel } from "./components/AdminOrdersPanel";
import { AdminPlansPanel } from "./components/AdminPlansPanel";
import { AdminUsersPanel } from "./components/AdminUsersPanel";
import { useAdminAccess } from "./hooks/useAdminAccess";
import { useAdminFilters } from "./hooks/useAdminFilters";

export default function AdminPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [operationalMetrics, setOperationalMetrics] = useState<AdminOperationalMetrics | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderCache, setOrderCache] = useState<Order[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [rules, setRules] = useState<SafetyRule[]>([]);
  const [safetyEvents, setSafetyEvents] = useState<SafetyEvent[]>([]);
  const [safetyAppeals, setSafetyAppeals] = useState<SafetyAppeal[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [newRule, setNewRule] = useState("");
  const [newRuleAction, setNewRuleAction] = useState<"BLOCK" | "REVIEW">("BLOCK");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [maintenanceRunning, setMaintenanceRunning] = useState(false);
  const {
    taskStatusFilter,
    setTaskStatusFilter,
    orderStatusFilter,
    setOrderStatusFilter,
    imageVisibilityFilter,
    setImageVisibilityFilter,
    safetyAppealStatusFilter,
    setSafetyAppealStatusFilter,
    createdFrom,
    setCreatedFrom,
    createdTo,
    setCreatedTo,
    userIdFilter,
    setUserIdFilter,
    orderNoFilter,
    setOrderNoFilter,
    userSearch,
    setUserSearch,
    userStatusFilter,
    setUserStatusFilter,
    adminUserIdFilter,
    setAdminUserIdFilter,
    auditActionFilter,
    setAuditActionFilter,
    auditTargetTypeFilter,
    setAuditTargetTypeFilter,
    auditTargetIdFilter,
    setAuditTargetIdFilter,
    resetEnterpriseFilters
  } = useAdminFilters();
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
  const accessState = useAdminAccess(router, setNotice);
  const [highlightedOrderId, setHighlightedOrderId] = useState<string | null>(null);
  const [settledOrderQueryKey, setSettledOrderQueryKey] = useState<string | null>(null);
  const [orderQueryLoading, setOrderQueryLoading] = useState(false);
  const pageLoadSeqRef = useRef(0);
  const imageLoadSeqRef = useRef(0);
  const orderLoadSeqRef = useRef(0);
  const refreshSeqRef = useRef(0);
  const imageFilterEffectReadyRef = useRef(false);
  const orderFilterEffectReadyRef = useRef(false);

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
    if (accessState !== "granted" || pathname !== "/admin") {
      return;
    }
    void load();
  }, [
    accessState,
    pathname,
    taskStatusFilter,
    safetyAppealStatusFilter,
    createdFrom,
    createdTo,
    userIdFilter,
    adminUserIdFilter,
    auditActionFilter,
    auditTargetTypeFilter,
    auditTargetIdFilter
  ]);

  useEffect(() => {
    if (accessState !== "granted") {
      return;
    }
    if (!imageFilterEffectReadyRef.current) {
      imageFilterEffectReadyRef.current = true;
      return;
    }
    void loadImages();
  }, [accessState, imageVisibilityFilter]);

  useEffect(() => {
    if (accessState !== "granted") {
      return;
    }
    if (!orderFilterEffectReadyRef.current) {
      orderFilterEffectReadyRef.current = true;
      return;
    }
    void loadOrders();
  }, [accessState, orderNoFilter, orderStatusFilter]);

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

  const orderQuery = useMemo<AdminOrderQuery>(
    () => ({
      status: orderStatusFilter === "ALL" ? undefined : orderStatusFilter,
      userId: filterValue(userIdFilter),
      orderNo: filterValue(orderNoFilter),
      createdFrom: toApiDateTime(createdFrom),
      createdTo: toApiDateTime(createdTo)
    }),
    [createdFrom, createdTo, orderNoFilter, orderStatusFilter, userIdFilter]
  );
  const orderQueryKey = useMemo(() => buildOrderQueryKey(orderQuery), [orderQuery]);
  const locallyMatchedOrders = useMemo(
    () => orderCache.filter((order) => orderMatchesQuery(order, orderQuery)).slice(0, 12),
    [orderCache, orderQuery]
  );
  const orderQuerySettled = settledOrderQueryKey === orderQueryKey;
  const orderQueryPending = accessState === "granted" && (orderQueryLoading || !orderQuerySettled);
  const hasActiveOrderFilter = Boolean(
    orderQuery.status || orderQuery.userId || orderQuery.orderNo || orderQuery.createdFrom || orderQuery.createdTo
  );
  const visibleOrders = useMemo(
    () => (orderQuerySettled ? orders.slice(0, 12) : locallyMatchedOrders),
    [locallyMatchedOrders, orderQuerySettled, orders]
  );

  const visibleSafetyEvents = useMemo(() => safetyEvents.slice(0, 8), [safetyEvents]);
  const visibleSafetyAppeals = useMemo(() => safetyAppeals.slice(0, 8), [safetyAppeals]);

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

  function commitOrderResult(nextOrders: Order[], queryKey: string) {
    setOrders(nextOrders);
    setOrderCache((current) => mergeOrderCache(current, nextOrders));
    setSettledOrderQueryKey(queryKey);
    setOrderQueryLoading(false);
  }

  async function load(preserveNotice = false) {
    const pageLoadSeq = ++pageLoadSeqRef.current;
    const imageLoadSeq = ++imageLoadSeqRef.current;
    const orderLoadSeq = ++orderLoadSeqRef.current;
    const refreshSeq = ++refreshSeqRef.current;
    const createdFromFilter = toApiDateTime(createdFrom);
    const createdToFilter = toApiDateTime(createdTo);
    const selectedUserId = filterValue(userIdFilter);
    const requestOrderQuery: AdminOrderQuery = {
      status: orderStatusFilter === "ALL" ? undefined : orderStatusFilter,
      userId: selectedUserId,
      orderNo: filterValue(orderNoFilter),
      createdFrom: createdFromFilter,
      createdTo: createdToFilter
    };
    const requestOrderQueryKey = buildOrderQueryKey(requestOrderQuery);
    try {
      setOrderQueryLoading(true);
      const [
        dashboardResult,
        operationsResult,
        usersResult,
        tasksResult,
        imagesResult,
        ordersResult,
        plansResult,
        rulesResult,
        safetyEventsResult,
        safetyAppealsResult,
        logsResult
      ] = await Promise.allSettled([
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
            ...requestOrderQuery
          })
        ),
        apiFetch<{ plans: Plan[] }>("/api/admin/plans"),
        apiFetch<{ rules: SafetyRule[] }>("/api/admin/safety-rules"),
        apiFetch<{ events: SafetyEvent[] }>("/api/admin/safety-events?limit=12"),
        apiFetch<{ appeals: SafetyAppeal[] }>(
          withQuery("/api/admin/safety-appeals", {
            limit: 12,
            status: safetyAppealStatusFilter === "ALL" ? undefined : safetyAppealStatusFilter
          })
        ),
        apiFetch<{ logs: AuditLog[] }>(
          withQuery("/api/admin/audit-logs", {
            limit: 30,
            adminUserId: filterValue(adminUserIdFilter),
            action: filterValue(auditActionFilter),
            targetType: filterValue(auditTargetTypeFilter),
            targetId: filterValue(auditTargetIdFilter)
          })
        )
      ] as const);
      if (pageLoadSeq !== pageLoadSeqRef.current) {
        return;
      }

      const failedSections: string[] = [];
      function fulfilledValue<T>(result: PromiseSettledResult<T>, label: string): T | null {
        if (result.status === "fulfilled") {
          return result.value;
        }
        failedSections.push(label);
        return null;
      }

      const dashboard = fulfilledValue(dashboardResult, "业务概览");
      const operations = fulfilledValue(operationsResult, "运行指标");
      const userResult = fulfilledValue(usersResult, "用户列表");
      const taskResult = fulfilledValue(tasksResult, "任务列表");
      const imageResult = fulfilledValue(imagesResult, "图片资产");
      const orderResult = fulfilledValue(ordersResult, "订单列表");
      const planResult = fulfilledValue(plansResult, "套餐配置");
      const ruleResult = fulfilledValue(rulesResult, "安全规则");
      const safetyEventResult = fulfilledValue(safetyEventsResult, "安全事件");
      const safetyAppealResult = fulfilledValue(safetyAppealsResult, "申诉队列");
      const logResult = fulfilledValue(logsResult, "审计日志");

      if (dashboard) {
        setMetrics(dashboard.metrics);
      }
      if (operations) {
        setOperationalMetrics(operations);
      }
      if (userResult) {
        setUsers(userResult.users);
      }
      if (taskResult) {
        setTasks(taskResult.tasks);
      }
      if (imageResult && imageLoadSeq === imageLoadSeqRef.current) {
        setImages(imageResult.images);
      }
      if (orderResult && orderLoadSeq === orderLoadSeqRef.current) {
        commitOrderResult(orderResult.orders, requestOrderQueryKey);
      } else if (!orderResult && orderLoadSeq === orderLoadSeqRef.current) {
        setSettledOrderQueryKey(requestOrderQueryKey);
        setOrderQueryLoading(false);
      }
      if (planResult) {
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
      }
      if (ruleResult) {
        setRules(ruleResult.rules.slice(0, 12));
      }
      if (safetyEventResult) {
        setSafetyEvents(safetyEventResult.events.slice(0, 12));
      }
      if (safetyAppealResult) {
        setSafetyAppeals(safetyAppealResult.appeals.slice(0, 12));
      }
      if (logResult) {
        setLogs(logResult.logs.slice(0, 12));
      }

      if (failedSections.length > 0 && refreshSeq === refreshSeqRef.current) {
        setNotice({
          tone: "danger",
          text: `部分后台数据加载失败：${failedSections.join("、")}。其他模块已正常显示，可稍后刷新重试。`
        });
      } else if (!preserveNotice && refreshSeq === refreshSeqRef.current) {
        setNotice(null);
      }
    } catch (error) {
      if (orderLoadSeq === orderLoadSeqRef.current) {
        setSettledOrderQueryKey(requestOrderQueryKey);
        setOrderQueryLoading(false);
      }
      if (pageLoadSeq === pageLoadSeqRef.current && refreshSeq === refreshSeqRef.current) {
        setNotice({ tone: "danger", text: error instanceof Error ? error.message : "后台数据加载失败，请稍后重试。" });
      }
    }
  }

  async function loadImages(preserveNotice = false) {
    const imageLoadSeq = ++imageLoadSeqRef.current;
    const refreshSeq = ++refreshSeqRef.current;
    const createdFromFilter = toApiDateTime(createdFrom);
    const createdToFilter = toApiDateTime(createdTo);
    const selectedUserId = filterValue(userIdFilter);
    try {
      const imageResult = await apiFetch<{ images: GeneratedImage[] }>(
        withQuery("/api/admin/images", {
          limit: 24,
          visibility: imageVisibilityFilter === "ALL" ? undefined : imageVisibilityFilter,
          userId: selectedUserId,
          createdFrom: createdFromFilter,
          createdTo: createdToFilter
        })
      );
      if (imageLoadSeq !== imageLoadSeqRef.current) {
        return;
      }
      setImages(imageResult.images);
      if (!preserveNotice && refreshSeq === refreshSeqRef.current) {
        setNotice(null);
      }
    } catch (error) {
      if (imageLoadSeq === imageLoadSeqRef.current && refreshSeq === refreshSeqRef.current) {
        setNotice({ tone: "danger", text: error instanceof Error ? error.message : "图片列表加载失败，请稍后重试。" });
      }
    }
  }

  async function loadOrders(preserveNotice = false) {
    const orderLoadSeq = ++orderLoadSeqRef.current;
    const refreshSeq = ++refreshSeqRef.current;
    const createdFromFilter = toApiDateTime(createdFrom);
    const createdToFilter = toApiDateTime(createdTo);
    const selectedUserId = filterValue(userIdFilter);
    const requestOrderQuery: AdminOrderQuery = {
      status: orderStatusFilter === "ALL" ? undefined : orderStatusFilter,
      userId: selectedUserId,
      orderNo: filterValue(orderNoFilter),
      createdFrom: createdFromFilter,
      createdTo: createdToFilter
    };
    const requestOrderQueryKey = buildOrderQueryKey(requestOrderQuery);
    try {
      setOrderQueryLoading(true);
      const orderResult = await apiFetch<{ orders: Order[] }>(
        withQuery("/api/admin/orders", {
          limit: 30,
          ...requestOrderQuery
        })
      );
      if (orderLoadSeq !== orderLoadSeqRef.current) {
        return;
      }
      commitOrderResult(orderResult.orders, requestOrderQueryKey);
      if (!preserveNotice && refreshSeq === refreshSeqRef.current) {
        setNotice(null);
      }
    } catch (error) {
      if (orderLoadSeq === orderLoadSeqRef.current && refreshSeq === refreshSeqRef.current) {
        setSettledOrderQueryKey(requestOrderQueryKey);
        setOrderQueryLoading(false);
        setNotice({ tone: "danger", text: error instanceof Error ? error.message : "订单列表加载失败，请稍后重试。" });
      }
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

  function requestOrderRefund(order: Order) {
    openConfirm({
      kind: "order-refund",
      orderId: order.id,
      orderNo: order.orderNo,
      amountCents: order.amountCents,
      currency: order.currency,
      clientRequestId: crypto.randomUUID()
    });
  }

  function requestSafetyEventReview(event: SafetyEvent, nextStatus: Exclude<SafetyEvent["status"], "REVIEW_REQUIRED">) {
    openConfirm({ kind: "safety-event", eventId: event.id, nextStatus });
  }

  function requestSafetyAppealReview(appeal: SafetyAppeal, nextStatus: Exclude<SafetyAppeal["status"], "PENDING">) {
    openConfirm({ kind: "safety-appeal", appealId: appeal.id, nextStatus });
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
          await loadImages(true);
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
        case "safety-appeal": {
          await apiFetch<{ appeal: SafetyAppeal }>(`/api/admin/safety-appeals/${confirmState.appealId}`, {
            method: "PATCH",
            body: { status: confirmState.nextStatus, adminNote: reason }
          });
          await load(true);
          setNotice({
            tone: "success",
            text: `安全申诉已${confirmState.nextStatus === "APPROVED" ? "批准" : "驳回"}。`
          });
          break;
        }
        case "order-refund": {
          const result = await apiFetch<{ order: Order; balanceAfter: number; refundId: string | null }>(
            `/api/admin/orders/${confirmState.orderId}/refund`,
            {
              method: "POST",
              body: { reason, confirm: true, clientRequestId: confirmState.clientRequestId }
            }
          );
          let refreshedDetail: OrderDetail | null = null;
          try {
            refreshedDetail = await apiFetch<OrderDetail>(`/api/admin/orders/${result.order.id}`);
          } catch {
            refreshedDetail = null;
          }
          await load(true);
          // 详情面板正开着这笔订单时同步刷新订单和支付事件，避免用户看到过期的 PAID。
          setSelectedDetail((current) =>
            current && current.kind === "order" && current.data.order.id === result.order.id
              ? { ...current, data: refreshedDetail ?? { ...current.data, order: result.order } }
              : current
          );

          // 高亮订单行 3 秒
          setHighlightedOrderId(result.order.id);
          setTimeout(() => setHighlightedOrderId(null), 3000);

          // Sonner toast 成功提示
          const refundIdHint = result.refundId ? `（支付方单号：${result.refundId.slice(0, 12)}...）` : "";
          toast.success("订单退款成功", {
            description: `订单 ${confirmState.orderNo} 已退款 ${formatMoney(confirmState.amountCents, confirmState.currency)}${refundIdHint}，用户余额回收后为 ${formatCredits(result.balanceAfter)}。`,
            duration: 5000
          });

          setNotice({
            tone: "success",
            text: `订单 ${confirmState.orderNo} 已退款 ${formatMoney(confirmState.amountCents, confirmState.currency)}${refundIdHint}，用户余额回收后为 ${formatCredits(result.balanceAfter)}。`
          });
          break;
        }
        default:
          break;
      }
      resetConfirm();
    } catch (error) {
      // 精细化错误提示
      let errorTitle = "操作失败";
      let errorDescription = "管理员操作失败，请稍后重试。";

      if (error instanceof ApiRequestError) {
        switch (error.code) {
          case "PROVIDER_REFUND_FAILED":
            errorTitle = "支付方退款失败";
            errorDescription = `${error.apiMessage ?? "未知原因"}。请登录支付平台后台核实，或联系支付渠道客服处理。`;
            break;
          case "INSUFFICIENT_BALANCE":
            errorTitle = "用户积分余额不足";
            errorDescription = "无法回收积分。请先在用户管理中调整积分为正，或在审计日志中标记此异常订单。";
            break;
          case "ORDER_NOT_REFUNDABLE":
            errorTitle = "订单不可退款";
            errorDescription = "订单当前状态不允许退款（可能已退款或已关闭），请刷新订单列表后重试。";
            break;
          case "ORDER_ALREADY_REFUNDED":
            errorTitle = "订单已退款";
            errorDescription = "该订单的退款已在处理中或已完成，请勿重复提交。刷新列表查看最新状态。";
            break;
          case "REFUND_FAILED":
            errorTitle = "退款失败";
            errorDescription = error.apiMessage ?? "退款请求被拒绝，请检查订单状态和支付平台后台。";
            break;
          default:
            errorTitle = error.code ?? "未知错误";
            errorDescription = error.apiMessage ?? error.message;
        }
      } else if (error instanceof Error) {
        if (error.message.includes("网络") || error.message.includes("超时")) {
          errorTitle = "网络异常";
          errorDescription = "请求超时或网络连接失败。退款可能已提交，请勿重复操作，刷新列表确认状态。";
        } else {
          errorDescription = error.message;
        }
      }

      toast.error(errorTitle, {
        description: errorDescription,
        duration: 8000
      });

      setNotice({ tone: "danger", text: `${errorTitle}：${errorDescription}` });
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
      case "safety-appeal":
        return {
          title: "确认处理安全申诉？",
          description: `该申诉将被${confirmState.nextStatus === "APPROVED" ? "批准" : "驳回"}，处理备注会进入审计链路。`,
          confirmLabel: confirmState.nextStatus === "APPROVED" ? "批准申诉" : "驳回申诉",
          tone: confirmState.nextStatus === "REJECTED" ? ("danger" as const) : ("default" as const)
        };
      case "order-refund":
        return {
          title: "确认退款？",
          description: `将对订单 ${confirmState.orderNo}（${formatMoney(confirmState.amountCents, confirmState.currency)}）发起全额退款：先向支付方真实退款，成功后订单转 REFUNDED 并回收当初发放的积分（余额可被扣为负）。此操作不可撤销，请填写退款原因。`,
          confirmLabel: "确认退款",
          tone: "danger" as const
        };
      default:
        return null;
    }
  }, [confirmState]);

  if (accessState !== "granted") {
    return (
      <AppFrame
        title="管理控制台"
        subtitle="集中管理用户、生成任务、图片资产、订单、套餐、安全规则和审计记录，重点防止误操作并保留可追踪上下文。"
      >
        <Panel className="flex min-h-48 flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm text-white/64">正在校验管理员权限...</p>
          {notice ? (
            <div className="w-full max-w-xl">
              <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
            </div>
          ) : null}
        </Panel>
      </AppFrame>
    );
  }

  return (
    <AppFrame
      title="管理控制台"
      subtitle="集中管理用户、生成任务、图片资产、订单、套餐、安全规则和审计记录，重点防止误操作并保留可追踪上下文。"
    >
      <div className="mb-5 flex flex-wrap items-center gap-3">
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

      <AdminObservability
        metrics={metrics}
        operationalMetrics={operationalMetrics}
        onRefresh={() => void load()}
      />

      <AdminFiltersPanel
        users={users}
        createdFrom={createdFrom}
        setCreatedFrom={setCreatedFrom}
        createdTo={createdTo}
        setCreatedTo={setCreatedTo}
        userIdFilter={userIdFilter}
        setUserIdFilter={setUserIdFilter}
        orderNoFilter={orderNoFilter}
        setOrderNoFilter={setOrderNoFilter}
        onReset={resetEnterpriseFilters}
      />

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <AdminUsersPanel
          users={visibleUsers}
          userSearch={userSearch}
          setUserSearch={setUserSearch}
          userStatusFilter={userStatusFilter}
          setUserStatusFilter={setUserStatusFilter}
          creditAdjustments={creditAdjustments}
          onUpdateCreditDraft={updateCreditDraft}
          onOpenDetail={(userId) => void openUserDetail(userId)}
          onRequestStatusChange={requestUserStatusChange}
          onRequestCreditAdjustment={requestCreditAdjustment}
          onRefresh={() => void load()}
        />
        <AdminGenerationPanels
          tasks={visibleTasks}
          taskStatusFilter={taskStatusFilter}
          setTaskStatusFilter={setTaskStatusFilter}
          images={visibleImages}
          imageVisibilityFilter={imageVisibilityFilter}
          setImageVisibilityFilter={setImageVisibilityFilter}
          onOpenTaskDetail={(taskId) => void openTaskDetail(taskId)}
          onOpenImageDetail={(imageId) => void openImageDetail(imageId)}
          onRequestImageVisibilityChange={requestImageVisibilityChange}
          onRefresh={() => void load()}
          onRefreshImages={() => void loadImages()}
        />
        <AdminOrdersPanel
          orders={visibleOrders}
          orderNoFilter={orderNoFilter}
          setOrderNoFilter={setOrderNoFilter}
          orderStatusFilter={orderStatusFilter}
          setOrderStatusFilter={setOrderStatusFilter}
          orderQueryPending={orderQueryPending}
          hasActiveOrderFilter={hasActiveOrderFilter}
          highlightedOrderId={highlightedOrderId}
          onOpenDetail={(orderId) => void openOrderDetail(orderId)}
          onRefresh={() => void loadOrders()}
        />
        <AdminPlansPanel
          plans={plans}
          planDraft={planDraft}
          planEdits={planEdits}
          onUpdatePlanDraft={updatePlanDraft}
          onUpdatePlanEdit={updatePlanEdit}
          onRequestCreate={requestPlanCreate}
          onRequestSave={requestPlanSave}
          onRequestStatusChange={requestPlanStatusChange}
          onRefresh={() => void load()}
        />
        <AdminModerationPanel
          rules={rules}
          newRule={newRule}
          setNewRule={setNewRule}
          newRuleAction={newRuleAction}
          setNewRuleAction={setNewRuleAction}
          safetyEvents={visibleSafetyEvents}
          safetyAppeals={visibleSafetyAppeals}
          safetyAppealStatusFilter={safetyAppealStatusFilter}
          setSafetyAppealStatusFilter={setSafetyAppealStatusFilter}
          onAddRule={() => void addRule()}
          onRequestSafetyEventReview={requestSafetyEventReview}
          onRequestSafetyAppealReview={requestSafetyAppealReview}
          onRefresh={() => void load()}
        />
        <AdminAuditPanel
          logs={logs}
          adminUserIdFilter={adminUserIdFilter}
          setAdminUserIdFilter={setAdminUserIdFilter}
          auditActionFilter={auditActionFilter}
          setAuditActionFilter={setAuditActionFilter}
          auditTargetTypeFilter={auditTargetTypeFilter}
          setAuditTargetTypeFilter={setAuditTargetTypeFilter}
          auditTargetIdFilter={auditTargetIdFilter}
          setAuditTargetIdFilter={setAuditTargetIdFilter}
          onRefresh={() => void load()}
        />
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

      <AdminDetailDrawer
        confirmLoading={confirmLoading}
        detail={selectedDetail}
        loading={detailLoading}
        onClose={() => setSelectedDetail(null)}
        onRequestRefund={requestOrderRefund}
      />

      <ToastContainer />
    </AppFrame>
  );
}
