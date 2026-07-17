import type { Plan, SafetyAppeal, SafetyRule } from "@imagora/shared";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerAdminRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    AppError,
    adjustCreditSchema,
    adjustCredits,
    adminAuditQuerySchema,
    adminImageQuerySchema,
    adminOrderQuerySchema,
    adminPlanPatchSchema,
    adminPlanSchema,
    adminReasonSchema,
    adminStatusSchema,
    adminTaskQuerySchema,
    adminUserQuerySchema,
    adminVisibilitySchema,
    audit,
    descCreated,
    descUpdated,
    domainMetricsSnapshot,
    envelope,
    envNumber,
    featureFlags,
    generationMaintenanceOptions,
    httpMetricsSnapshot,
    idParamSchema,
    imageParamSchema,
    matchesCreatedRange,
    mustFindCreditAccount,
    mustFindImage,
    mustFindOrder,
    mustFindTask,
    mustFindUser,
    operationalAlertsSnapshot,
    orderParamSchema,
    planParamSchema,
    randomUUID,
    recordLocalAlertNotifications,
    refundOrderSchema,
    refundOrderWithProvider,
    routeLabel,
    requireAdmin,
    requireAuth,
    runGenerationMaintenance,
    runOrderMaintenance,
    safetyAppealAdminQuerySchema,
    safetyAppealCreateSchema,
    safetyAppealParamSchema,
    safetyAppealReviewSchema,
    safetyEventParamSchema,
    safetyEventQuerySchema,
    safetyEventReviewSchema,
    safetyRuleParamSchema,
    safetyRulePatchSchema,
    safetyRuleSchema,
    serviceStartedAt,
    stripAdminReason,
    store,
    userParamSchema,
    withoutPassword
  } = context;

  app.get("/api/admin/dashboard", async (request) => {
    await requireAdmin(request);
    return store.update((data) => {
      runOrderMaintenance(data);
      const paidRevenueCents = data.orders
        .filter((order) => order.status === "PAID")
        .reduce((sum, order) => sum + order.amountCents, 0);
      // AI 成本仅统计已成功产出的任务，避免把失败退款任务的名义成本算进毛利
      const aiCostCents = data.generationTasks
        .filter((task) => task.status === "SUCCEEDED")
        .reduce((sum, task) => sum + (task.providerCostCents ?? 0), 0);
      return envelope(request, {
        metrics: {
          users: data.users.length,
          tasks: data.generationTasks.length,
          images: data.generatedImages.length,
          paidOrders: data.orders.filter((order) => order.status === "PAID").length,
          paidRevenueCents,
          aiCostCents,
          grossProfitCents: paidRevenueCents - aiCostCents,
          blockedSafetyEvents: data.safetyEvents.filter((event) => event.status === "BLOCKED").length,
          reviewRequiredSafetyEvents: data.safetyEvents.filter((event) => event.status === "REVIEW_REQUIRED").length
        }
      });
    });
  });

  app.get("/api/admin/metrics", async (request) => {
    await requireAdmin(request);
    const http = await httpMetricsSnapshot();
    return store.update((data) => {
      const maintenance = runOrderMaintenance(data);
      const domain = domainMetricsSnapshot(data);
      const alerts = operationalAlertsSnapshot(data, http);
      recordLocalAlertNotifications(data, alerts);
      return envelope(request, {
        service: {
          uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1000),
          startedAt: new Date(serviceStartedAt).toISOString(),
          features: featureFlags()
        },
        http,
        domain,
        maintenance,
        alerts,
        recentIncidents: data.operationalIncidents.sort(descUpdated).slice(0, 12),
        alertNotifications: data.alertNotifications.sort(descCreated).slice(0, 12)
      });
    });
  });

  app.post("/api/admin/maintenance/reconcile", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const input = adminReasonSchema.parse(request.body ?? {});
    return store.update((data) => {
      const maintenance = runOrderMaintenance(data);
      audit(
        data,
        admin.id,
        "maintenance.reconcile",
        "SYSTEM",
        "platform",
        input.reason,
        null,
        { ...maintenance },
        request
      );
      return envelope(request, { maintenance });
    });
  });

  app.post("/api/admin/maintenance/reconcile-generation", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const input = adminReasonSchema.parse(request.body ?? {});
    return store.update((data) => {
      const maintenance = runGenerationMaintenance(data, generationMaintenanceOptions());
      audit(
        data,
        admin.id,
        "maintenance.generation.reconcile",
        "SYSTEM",
        "generation",
        input.reason,
        null,
        { ...maintenance },
        request
      );
      return envelope(request, { maintenance });
    });
  });

  app.get("/api/admin/users", async (request) => {
    const query = adminUserQuerySchema.parse(request.query);
    const { data } = await requireAdmin(request);
    const search = query.search?.toLowerCase();
    const users = data.users
      .filter((user) => !query.status || user.status === query.status)
      .filter((user) => !query.role || user.role === query.role)
      .filter((user) => {
        if (!search) {
          return true;
        }
        return user.email.toLowerCase().includes(search) || user.nickname.toLowerCase().includes(search);
      })
      .sort(descCreated)
      .slice(0, query.limit)
      .map(withoutPassword);
    return envelope(request, { users, total: data.users.length });
  });

  app.get("/api/admin/users/:userId", async (request) => {
    await requireAdmin(request);
    const { userId } = userParamSchema.parse(request.params);
    const data = await store.read();
    const user = mustFindUser(data, userId);
    const account = data.creditAccounts.find((a) => a.userId === userId);
    const orders = data.orders
      .filter((o) => o.userId === userId)
      .sort(descCreated)
      .slice(0, 10);
    const tasks = data.generationTasks
      .filter((t) => t.userId === userId)
      .sort(descCreated)
      .slice(0, 10);
    const images = data.generatedImages.filter((img) => img.userId === userId).length;

    return envelope(request, {
      user: withoutPassword(user),
      account,
      stats: {
        totalOrders: data.orders.filter((o) => o.userId === userId).length,
        paidOrders: data.orders.filter((o) => o.userId === userId && o.status === "PAID").length,
        totalTasks: data.generationTasks.filter((t) => t.userId === userId).length,
        succeededTasks: data.generationTasks.filter((t) => t.userId === userId && t.status === "SUCCEEDED").length,
        totalImages: images
      },
      recentOrders: orders,
      recentTasks: tasks
    });
  });

  app.patch("/api/admin/users/:userId/status", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { userId } = userParamSchema.parse(request.params);
    const input = adminStatusSchema.parse(request.body);
    return store.update((data) => {
      const target = mustFindUser(data, userId);
      if (target.id === admin.id) {
        throw new AppError("VALIDATION_ERROR", "Admin cannot change own status here", 400);
      }
      if (target.role === "ADMIN" && input.status !== "ACTIVE") {
        const otherActiveAdmins = data.users.filter(
          (user) => user.id !== target.id && user.role === "ADMIN" && user.status === "ACTIVE"
        );
        if (otherActiveAdmins.length === 0) {
          throw new AppError("VALIDATION_ERROR", "Cannot remove the last active administrator", 400);
        }
      }
      const before = { status: target.status };
      target.status = input.status;
      target.updatedAt = new Date().toISOString();
      audit(
        data,
        admin.id,
        "user.status.update",
        "USER",
        target.id,
        input.reason,
        before,
        { status: target.status },
        request
      );
      return envelope(request, { user: withoutPassword(target) });
    });
  });

  app.post("/api/admin/users/:userId/credits/adjust", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { userId } = userParamSchema.parse(request.params);
    const input = adjustCreditSchema.parse(request.body);
    // 大额人工调整必须显式二次确认，防止误触多敲一个零就发出去
    const largeAdjustThreshold = envNumber("ADMIN_CREDIT_ADJUST_THRESHOLD", 1000);
    if (Math.abs(input.amount) >= largeAdjustThreshold && !input.confirm) {
      throw new AppError("VALIDATION_ERROR", "大额积分调整需要二次确认", 400, {
        requiresConfirmation: true,
        threshold: largeAdjustThreshold,
        amount: input.amount
      });
    }
    return store.update((data) => {
      mustFindUser(data, userId);
      const account = mustFindCreditAccount(data, userId);
      const before = { balance: account.balance };
      // 幂等键随请求传入，重复提交只执行一次，也不重复写审计
      const applied = adjustCredits(
        data,
        userId,
        input.amount,
        admin.id,
        `admin-adjust:${input.clientRequestId}`,
        input.reason
      );
      if (applied) {
        audit(
          data,
          admin.id,
          "user.credits.adjust",
          "USER",
          userId,
          input.reason,
          before,
          { balance: account.balance },
          request
        );
      }
      return envelope(request, { account });
    });
  });

  app.get("/api/admin/generation/tasks", async (request) => {
    const query = adminTaskQuerySchema.parse(request.query);
    const { data } = await requireAdmin(request);
    const tasks = data.generationTasks
      .filter((task) => !query.status || task.status === query.status)
      .filter((task) => !query.userId || task.userId === query.userId)
      .filter((task) => matchesCreatedRange(task.createdAt, query))
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { tasks });
  });

  app.get("/api/admin/generation/tasks/:taskId", async (request) => {
    await requireAdmin(request);
    const { taskId } = idParamSchema.parse(request.params);
    const data = await store.read();
    const task = mustFindTask(data, taskId);
    const user = mustFindUser(data, task.userId);
    const images = data.generatedImages.filter((image) => image.taskId === task.id).sort(descCreated);
    return envelope(request, { task, user: withoutPassword(user), images });
  });

  app.get("/api/admin/images", async (request) => {
    const query = adminImageQuerySchema.parse(request.query);
    const { data } = await requireAdmin(request);
    const images = data.generatedImages
      .filter((image) => !query.visibility || image.visibility === query.visibility)
      .filter((image) => !query.userId || image.userId === query.userId)
      .filter((image) => matchesCreatedRange(image.createdAt, query))
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { images });
  });

  app.get("/api/admin/images/:imageId", async (request) => {
    await requireAdmin(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const data = await store.read();
    const image = mustFindImage(data, imageId);
    const user = mustFindUser(data, image.userId);
    const task = mustFindTask(data, image.taskId);
    return envelope(request, { image, user: withoutPassword(user), task });
  });

  app.patch("/api/admin/images/:imageId/visibility", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const input = adminVisibilitySchema.parse(request.body);
    return store.update((data) => {
      const image = data.generatedImages.find((item) => item.id === imageId);
      if (!image) {
        throw new AppError("NOT_FOUND", "Image was not found", 404);
      }
      const before = { visibility: image.visibility };
      image.visibility = input.visibility;
      audit(
        data,
        admin.id,
        "image.visibility.update",
        "IMAGE",
        image.id,
        input.reason,
        before,
        { visibility: image.visibility },
        request
      );
      return envelope(request, { image });
    });
  });

  app.get("/api/admin/orders", async (request) => {
    const query = adminOrderQuerySchema.parse(request.query);
    const { data } = await requireAdmin(request);
    const orders = data.orders
      .filter((order) => !query.status || order.status === query.status)
      .filter((order) => !query.userId || order.userId === query.userId)
      .filter((order) => !query.orderNo || order.orderNo.toLowerCase().includes(query.orderNo.toLowerCase()))
      .filter((order) => matchesCreatedRange(order.createdAt, query))
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { orders });
  });

  app.get("/api/admin/orders/:orderId", async (request) => {
    await requireAdmin(request);
    const { orderId } = orderParamSchema.parse(request.params);
    const data = await store.read();
    const order = mustFindOrder(data, orderId);
    const user = mustFindUser(data, order.userId);
    const plan = data.plans.find((item) => item.id === order.planId);
    if (!plan) {
      throw new AppError("NOT_FOUND", "Plan was not found", 404);
    }
    const paymentEvents = data.paymentEvents.filter((event) => event.orderId === order.id).sort(descCreated);
    return envelope(request, { order, user: withoutPassword(user), plan, paymentEvents });
  });

  // 管理员发起退款：先在事务外调支付方真退款，成功后才落 REFUNDED + 回收积分。
  // 大额（>= 阈值）退款需 confirm 二次确认，避免误点把整笔退出去。
  app.post("/api/admin/orders/:orderId/refund", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { orderId } = orderParamSchema.parse(request.params);
    const input = refundOrderSchema.parse(request.body);

    // 退款金额相对固定（全额退当初订单金额），但仍给大额退款加二次确认闸门。
    const snapshot = await store.read();
    const targetOrder = mustFindOrder(snapshot, orderId);
    const largeRefundThreshold = envNumber("ADMIN_REFUND_CONFIRM_THRESHOLD_CENTS", 50000);
    if (targetOrder.amountCents >= largeRefundThreshold && !input.confirm) {
      throw new AppError("VALIDATION_ERROR", "大额退款需要二次确认", 400, {
        requiresConfirmation: true,
        thresholdCents: largeRefundThreshold,
        amountCents: targetOrder.amountCents
      });
    }

    const result = await refundOrderWithProvider({
      orderId,
      adminUserId: admin.id,
      reason: input.reason,
      requestId: request.requestId ?? null,
      route: routeLabel(request)
    });
    if (!result.ok) {
      // 退款失败：REFUND_FAILED / PAYMENT_PROVIDER_MISMATCH 归 502（支付方问题），
      // 其余（NOT_FOUND / ORDER_NOT_REFUNDABLE / ORDER_ALREADY_REFUNDED）归 4xx。
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "REFUND_FAILED" || result.code === "PAYMENT_PROVIDER_MISMATCH"
            ? 502
            : 400;
      throw new AppError(result.code, result.message, status);
    }

    // 退款成功后写审计（在事务外，退款已落库；审计单独入库不影响退款结果）。
    await store.update((data) => {
      audit(
        data,
        admin.id,
        "order.refund",
        "ORDER",
        result.order.id,
        input.reason,
        { status: "PAID" },
        { status: result.order.status, refundId: result.refundId, refundedAmountCents: result.refundedAmountCents },
        request
      );
      return null;
    });

    return envelope(request, {
      order: result.order,
      balanceAfter: result.balanceAfter,
      refundId: result.refundId,
      refundedAmountCents: result.refundedAmountCents
    });
  });

  app.get("/api/admin/plans", async (request) => {
    const { data } = await requireAdmin(request);
    return envelope(request, { plans: data.plans.sort((a, b) => a.sortOrder - b.sortOrder) });
  });

  app.post("/api/admin/plans", async (request, reply) => {
    const { user: admin } = await requireAdmin(request);
    const input = adminPlanSchema.parse(request.body);
    return store.update((data) => {
      const now = new Date().toISOString();
      const plan: Plan = { id: randomUUID(), ...stripAdminReason(input), createdAt: now, updatedAt: now };
      data.plans.push(plan);
      audit(
        data,
        admin.id,
        "plan.create",
        "PLAN",
        plan.id,
        input.reason,
        null,
        plan as unknown as Record<string, unknown>,
        request
      );
      reply.status(201);
      return envelope(request, { plan });
    });
  });

  app.patch("/api/admin/plans/:planId", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { planId } = planParamSchema.parse(request.params);
    const input = adminPlanPatchSchema.parse(request.body);
    return store.update((data) => {
      const plan = data.plans.find((item) => item.id === planId);
      if (!plan) {
        throw new AppError("NOT_FOUND", "Plan was not found", 404);
      }
      const before = { ...plan };
      Object.assign(plan, stripAdminReason(input), { updatedAt: new Date().toISOString() });
      audit(
        data,
        admin.id,
        "plan.update",
        "PLAN",
        plan.id,
        input.reason,
        before,
        plan as unknown as Record<string, unknown>,
        request
      );
      return envelope(request, { plan });
    });
  });

  app.get("/api/admin/audit-logs", async (request) => {
    const query = adminAuditQuerySchema.parse(request.query);
    const { data } = await requireAdmin(request);
    const logs = data.adminAuditLogs
      .filter((log) => !query.adminUserId || log.adminUserId === query.adminUserId)
      .filter((log) => !query.action || log.action === query.action)
      .filter((log) => !query.targetType || log.targetType === query.targetType)
      .filter((log) => !query.targetId || log.targetId === query.targetId)
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { logs });
  });

  app.get("/api/admin/safety-rules", async (request) => {
    const { data } = await requireAdmin(request);
    return envelope(request, { rules: data.safetyRules.sort(descCreated) });
  });

  app.post("/api/admin/safety-rules", async (request, reply) => {
    const { user: admin } = await requireAdmin(request);
    const input = safetyRuleSchema.parse(request.body);
    return store.update((data) => {
      const now = new Date().toISOString();
      const rule: SafetyRule = {
        id: randomUUID(),
        ...input,
        createdAt: now,
        updatedAt: now
      };
      data.safetyRules.push(rule);
      audit(data, admin.id, "safety-rule.create", "SAFETY_RULE", rule.id, null, null, { ...rule }, request);
      reply.status(201);
      return envelope(request, { rule });
    });
  });

  app.patch("/api/admin/safety-rules/:ruleId", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { ruleId } = safetyRuleParamSchema.parse(request.params);
    const input = safetyRulePatchSchema.parse(request.body);
    return store.update((data) => {
      const rule = data.safetyRules.find((item) => item.id === ruleId);
      if (!rule) {
        throw new AppError("NOT_FOUND", "Safety rule was not found", 404);
      }
      const before = { ...rule };
      Object.assign(rule, input, { updatedAt: new Date().toISOString() });
      audit(data, admin.id, "safety-rule.update", "SAFETY_RULE", rule.id, null, before, { ...rule }, request);
      return envelope(request, { rule });
    });
  });

  app.get("/api/admin/safety-events", async (request) => {
    const query = safetyEventQuerySchema.parse(request.query);
    const { data } = await requireAdmin(request);
    const events = data.safetyEvents
      .filter((event) => !query.status || event.status === query.status)
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { events });
  });

  app.patch("/api/admin/safety-events/:eventId", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { eventId } = safetyEventParamSchema.parse(request.params);
    const input = safetyEventReviewSchema.parse(request.body);
    return store.update((data) => {
      const event = data.safetyEvents.find((item) => item.id === eventId);
      if (!event) {
        throw new AppError("NOT_FOUND", "Safety event was not found", 404);
      }
      if (event.status !== "REVIEW_REQUIRED") {
        throw new AppError("VALIDATION_ERROR", "Only pending safety reviews can be handled", 400);
      }
      const before = { ...event };
      event.status = input.status;
      event.reasonMessage = `${event.reasonMessage}；人工复核：${input.reason}`;
      audit(
        data,
        admin.id,
        "safety-event.review",
        "SAFETY_EVENT",
        event.id,
        input.reason,
        before,
        { ...event },
        request
      );
      return envelope(request, { event });
    });
  });

  // ---- 用户申诉接口 ----

  app.post("/api/safety-appeals", async (request) => {
    const { user } = await requireAuth(request);
    const input = safetyAppealCreateSchema.parse(request.body);
    return store.update((data) => {
      const event = data.safetyEvents.find((item) => item.id === input.safetyEventId && item.userId === user.id);
      if (!event) {
        throw new AppError("NOT_FOUND", "Safety event was not found", 404);
      }
      const existing = data.safetyAppeals.find(
        (appeal) => appeal.safetyEventId === input.safetyEventId && appeal.status === "PENDING"
      );
      if (existing) {
        throw new AppError("CONFLICT", "已有待处理的申诉，请等待结果后再提交", 409);
      }
      const now = new Date().toISOString();
      const appeal: SafetyAppeal = {
        id: randomUUID(),
        userId: user.id,
        safetyEventId: input.safetyEventId,
        reason: input.reason,
        status: "PENDING",
        adminNote: null,
        createdAt: now,
        resolvedAt: null
      };
      data.safetyAppeals.push(appeal);
      return envelope(request, { appeal });
    });
  });

  app.get("/api/safety-appeals", async (request) => {
    const { user } = await requireAuth(request);
    const data = await store.read();
    const appeals = data.safetyAppeals.filter((appeal) => appeal.userId === user.id).sort(descCreated);
    return envelope(request, { appeals });
  });

  app.get("/api/admin/safety-appeals", async (request) => {
    const query = safetyAppealAdminQuerySchema.parse(request.query);
    await requireAdmin(request);
    const data = await store.read();
    const appeals = data.safetyAppeals
      .filter((appeal) => !query.status || appeal.status === query.status)
      .sort(descCreated)
      .slice(0, query.limit);
    return envelope(request, { appeals });
  });

  app.patch("/api/admin/safety-appeals/:appealId", async (request) => {
    const { user: admin } = await requireAdmin(request);
    const { appealId } = safetyAppealParamSchema.parse(request.params);
    const input = safetyAppealReviewSchema.parse(request.body);
    return store.update((data) => {
      const appeal = data.safetyAppeals.find((item) => item.id === appealId);
      if (!appeal) {
        throw new AppError("NOT_FOUND", "Appeal was not found", 404);
      }
      if (appeal.status !== "PENDING") {
        throw new AppError("VALIDATION_ERROR", "Only pending appeals can be reviewed", 400);
      }
      const before = { ...appeal };
      const now = new Date().toISOString();
      appeal.status = input.status;
      appeal.adminNote = input.adminNote ?? null;
      appeal.resolvedAt = now;
      audit(
        data,
        admin.id,
        "safety-appeal.review",
        "SAFETY_APPEAL",
        appeal.id,
        input.adminNote ?? null,
        before,
        { ...appeal },
        request
      );
      return envelope(request, { appeal });
    });
  });
}
