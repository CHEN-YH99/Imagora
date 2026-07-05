import { expect, type Page, type Route, test } from "@playwright/test";

const now = "2026-07-01T08:00:00.000Z";
const thumbnailUrl = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0b1215"/><circle cx="32" cy="28" r="16" fill="#8df8d2"/><text x="32" y="52" fill="#fff" font-size="8" text-anchor="middle">THUMB</text></svg>'
)}`;
const fullSizeImageUrl = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#0b1215"/><circle cx="512" cy="448" r="256" fill="#8df8d2"/><text x="512" y="824" fill="#fff" font-size="96" text-anchor="middle">FULL SIZE</text></svg>'
)}`;
const captchaSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="130"><rect width="180" height="130" fill="#f8fafc"/><rect x="66" y="42" width="48" height="48" rx="8" fill="#10b981"/></svg>';

type GenerationOutcome = "success" | "failed";

type MockOptions = {
  generationOutcome?: GenerationOutcome;
};

type MockState = {
  downloadRequests: number;
  generationTaskPolls: number;
  images: GeneratedImage[];
  orders: Order[];
  rules: SafetyRule[];
  safetyEvents: SafetyEvent[];
  tasks: Task[];
};

type User = {
  id: string;
  email: string;
  nickname: string;
  avatarUrl: string | null;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

type Task = {
  id: string;
  userId: string;
  clientRequestId: string;
  referenceImageId: string | null;
  prompt: string;
  negativePrompt: string | null;
  style: string;
  aspectRatio: string;
  width: number;
  height: number;
  quantity: number;
  quality: string;
  modelProvider: string;
  modelName: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "BLOCKED";
  creditCost: number;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type GeneratedImage = {
  id: string;
  taskId: string;
  userId: string;
  thumbnailUrl: string;
  publicUrl: string;
  width: number;
  height: number;
  visibility: "PRIVATE" | "PUBLIC" | "HIDDEN";
  favorite: boolean;
  deletedAt: string | null;
  createdAt: string;
};

type Plan = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  credits: number;
  validDays: number | null;
  status: "ACTIVE" | "INACTIVE";
  sortOrder: number;
};

type Order = {
  id: string;
  userId: string;
  orderNo: string;
  planId: string;
  amountCents: number;
  currency: string;
  paymentProvider: string;
  paymentIntentId: string | null;
  status: "PENDING" | "PAID" | "CANCELED" | "REFUNDED" | "CLOSED";
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SafetyRule = {
  id: string;
  term: string;
  action: "BLOCK" | "REVIEW";
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
};

type SafetyEvent = {
  id: string;
  userId: string;
  targetType: "PROMPT" | "UPLOAD_IMAGE" | "GENERATED_IMAGE";
  targetId: string;
  status: "PASSED" | "BLOCKED" | "REVIEW_REQUIRED";
  reasonCode: string;
  reasonMessage: string;
  provider: string;
  createdAt: string;
};

const adminUser: User = {
  id: "user-admin",
  email: "admin@imagora.test",
  nickname: "Imagora Admin",
  avatarUrl: null,
  role: "ADMIN",
  status: "ACTIVE",
  emailVerifiedAt: now,
  createdAt: now,
  lastLoginAt: now
};

const creatorUser: User = {
  id: "user-creator",
  email: "creator@imagora.test",
  nickname: "Demo Creator",
  avatarUrl: null,
  role: "USER",
  status: "ACTIVE",
  emailVerifiedAt: now,
  createdAt: now,
  lastLoginAt: now
};

const plans: Plan[] = [
  {
    id: "plan-starter",
    name: "Starter",
    description: "220 credits for prompt exploration",
    priceCents: 900,
    currency: "CNY",
    credits: 220,
    validDays: 30,
    status: "ACTIVE",
    sortOrder: 10
  },
  {
    id: "plan-creator",
    name: "Creator",
    description: "620 credits with HD downloads",
    priceCents: 2900,
    currency: "CNY",
    credits: 620,
    validDays: 90,
    status: "ACTIVE",
    sortOrder: 20
  }
];

test("认证流程覆盖注册、双轮图片验证登录、退出、找回和重置", async ({ page }) => {
  await setupApiMocks(page);

  await page.goto("/register");
  await page.getByLabel("邮箱").fill("new-user@imagora.test");
  await page.getByLabel("密码", { exact: true }).fill("SecurePass123");
  await page.getByLabel("确认密码").fill("SecurePass123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page).toHaveURL(/\/generate$/);
  await expect(page.getByRole("heading", { name: "图片生成" })).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("邮箱").fill("creator@imagora.test");
  await page.getByLabel("密码", { exact: true }).fill("SecurePass123");
  await page.getByLabel(/登录安全准则/).check();
  await page.getByRole("button", { name: "点击文字进行图片验证" }).click();
  await page.getByRole("button", { name: /亮色方块/ }).click({ position: { x: 80, y: 60 } });
  await page.getByRole("button", { name: "检查" }).click();
  await expect(page.getByText("第 2/2 次")).toBeVisible();
  await page.getByRole("button", { name: /亮色方块/ }).click({ position: { x: 80, y: 60 } });
  await page.getByRole("button", { name: "检查" }).click();
  await expect(page.getByRole("button", { name: "图片验证已完成" })).toBeVisible();
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/generate$/);

  await page.getByRole("button", { name: "退出" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认退出" }).click();
  await expect(page.getByRole("link", { name: "登录" })).toBeVisible();

  await page.goto("/forgot-password");
  await page.getByLabel("邮箱").fill("creator@imagora.test");
  await page.getByRole("button", { name: "发送重置链接" }).click();
  await expect(page.getByText("如果该邮箱已注册，您将收到密码重置链接。")).toBeVisible();

  await page.goto("/reset-password?token=reset-token-e2e");
  await page.getByLabel("新密码").fill("NewSecurePass123");
  await page.getByLabel("确认密码").fill("NewSecurePass123");
  await page.getByRole("button", { name: "重置密码" }).click();
  await expect(page.getByText("密码重置成功，请使用新密码登录。")).toBeVisible();
});

test("生成任务覆盖创建、轮询、成功和失败状态", async ({ page }) => {
  const successState = await setupApiMocks(page, { generationOutcome: "success" });

  await page.goto("/generate");
  await page.getByRole("textbox", { name: "提示词", exact: true }).fill("电影感茶杯广告图，薄荷色轮廓光");
  await page.getByRole("button", { name: "提交生成" }).first().click();
  await expect(page.getByText("生成完成，可进入详情继续下载、收藏或再次生成。")).toBeVisible({
    timeout: 8_000
  });
  await expect(page.getByAltText("生成图片结果")).toHaveCount(1);
  expect(successState.generationTaskPolls).toBeGreaterThanOrEqual(2);

  const failedPage = await page.context().newPage();
  await setupApiMocks(failedPage, { generationOutcome: "failed" });
  await failedPage.goto("/generate");
  await failedPage.getByRole("textbox", { name: "提示词", exact: true }).fill("触发失败场景的广告图");
  await failedPage.getByRole("button", { name: "提交生成" }).first().click();
  await expect(failedPage.getByRole("alert").filter({ hasText: "模型服务暂时不可用，请稍后重试。" })).toBeVisible({
    timeout: 8_000
  });
  await failedPage.close();
});

test("历史、收藏、下载、删除和再次生成链路可回归", async ({ page }) => {
  const state = await setupApiMocks(page);

  await page.goto("/history");
  await page.getByRole("link", { name: "再次生成" }).click();
  await expect(page).toHaveURL(/\/generate\?.*prompt=/);
  await expect(page.getByRole("textbox", { name: "提示词", exact: true })).toHaveValue(/半透明智能相机/);

  await page.goto("/history");
  await page.getByRole("button", { name: "切换收藏" }).click();
  await page.goto("/favorites");
  await expect(page.getByText("已收藏")).toBeVisible();
  await page.getByRole("button", { name: "取消收藏" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取消收藏" }).click();
  await expect(page.getByText("已取消收藏。")).toBeVisible();

  await page.goto("/history");
  await page.getByRole("button", { name: "下载图片" }).click();
  await expect.poll(() => state.downloadRequests).toBe(1);
  await page.getByRole("button", { name: "删除图片" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除图片" }).click();
  await expect(page.getByText("图片已删除。")).toBeVisible();
  expect(state.images).toHaveLength(0);
});

test("历史页图片支持 hover 预览大图并显示实际比例", async ({ page }) => {
  await setupApiMocks(page);

  await page.goto("/history");
  const previewButton = page.getByRole("button", { name: "预览历史第 1 张生成图片" });
  await previewButton.hover();
  await expect(page.getByText("查看原图")).toBeVisible();

  await previewButton.click();
  const dialog = page.getByRole("dialog", { name: "生成图片大图预览" });
  await expect(dialog).toBeVisible();
  const dialogImage = dialog.getByRole("img", { name: "生成图片大图预览" });
  await expect(dialogImage).toBeVisible();
  await expect.poll(() => dialogImage.evaluate((image) => (image as HTMLImageElement).src)).toBe(fullSizeImageUrl);
  await expect.poll(() => dialogImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1024);
  await expect(dialogImage).toHaveCSS("object-fit", "contain");
  await expect(dialog.getByText("1024 × 1024")).toBeVisible();
  await expect(dialog.getByText("比例 1:1")).toBeVisible();
  await expect(page.getByRole("link", { name: "详情" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("套餐、订单和支付沙箱链路可回归", async ({ page }) => {
  await setupApiMocks(page);

  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "积分套餐" })).toBeVisible();
  await page.getByRole("button", { name: "购买积分" }).first().click();
  await expect(page.getByText(/订单已支付，支付后余额为/)).toBeVisible();

  await page.goto("/orders?paid=1");
  await expect(page.getByText("支付完成回跳成功。我们正在等待支付平台回调")).toBeVisible();
  await page.getByRole("button", { name: "继续支付" }).first().click();
  await expect(page.getByText("订单已支付成功，当前余额已同步到账。")).toBeVisible();
});

test("管理后台关键操作覆盖详情、对账和安全规则", async ({ page }) => {
  await setupApiMocks(page);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理控制台" })).toBeVisible();
  await expect(page.getByText("生成失败率")).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近异常", exact: true })).toBeVisible();
  await expect(page.getByText("Provider timeout while generating image.")).toBeVisible();

  await page.getByRole("button", { name: "订单对账" }).click();
  await page.getByRole("dialog").getByLabel("处理原因").fill("E2E 对账演练");
  await page.getByRole("dialog").getByRole("button", { name: "执行对账" }).click();
  await expect(page.getByText(/对账完成：关闭过期订单/)).toBeVisible();

  const userCard = page.locator("article").filter({ hasText: "creator@imagora.test" }).first();
  await userCard.getByRole("button", { name: "详情" }).click();
  await expect(page.getByRole("dialog", { name: "用户详情" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "用户详情" }).getByText("creator@imagora.test")).toBeVisible();
  await page.keyboard.press("Escape");

  const safetyPanel = page.getByRole("heading", { name: "安全规则" }).locator("xpath=ancestor::section[1]");
  await safetyPanel.getByLabel("拦截词").fill("e2e-block");
  await safetyPanel.getByRole("button", { name: "新增" }).click();
  await expect(page.getByText("安全规则已新增，后续生成会按新规则执行。")).toBeVisible();

  const safetyEventPanel = page.getByRole("heading", { name: "安全事件" }).locator("xpath=ancestor::section[1]");
  await expect(safetyEventPanel.getByText("e2e-review").first()).toBeVisible();
  await safetyEventPanel.getByRole("button", { name: "复核通过" }).click();
  await page.getByRole("dialog").getByLabel("处理原因").fill("E2E 人工复核通过");
  await page.getByRole("dialog").getByRole("button", { name: "复核通过" }).click();
  await expect(page.getByText("安全事件已标记为已通过。")).toBeVisible();
});

test("核心页面在 375、768、1440 视口保持可访问且无页面级横向溢出", async ({ page }) => {
  await setupApiMocks(page);

  const responsivePages = [
    { path: "/", heading: /Imagora 将清晰提示词转化为可交付视觉资产/ },
    { path: "/generate", heading: "图片生成", exact: true },
    { path: "/history", heading: "生成历史", exact: true },
    { path: "/favorites", heading: "我的收藏", exact: true },
    { path: "/pricing", heading: "积分套餐", exact: true },
    { path: "/orders", heading: "订单记录", exact: true },
    { path: "/admin", heading: "管理控制台", exact: true }
  ];

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);

    for (const responsivePage of responsivePages) {
      await page.goto(responsivePage.path);
      await expect(
        page.getByRole("heading", { exact: responsivePage.exact, name: responsivePage.heading })
      ).toBeVisible();
      const horizontalOverflow = await page.evaluate(
        () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth
      );
      expect(
        horizontalOverflow,
        `${responsivePage.path} should not overflow horizontally at ${viewport.width}px`
      ).toBeLessThanOrEqual(2);
    }
  }
});

async function setupApiMocks(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state = createMockState();
  const generationOutcome = options.generationOutcome ?? "success";

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === "GET" && path === "/api/auth/me") {
      await fulfillData(route, { user: adminUser });
      return;
    }
    if (method === "GET" && path === "/api/auth/captcha") {
      await fulfillData(route, {
        captchaId: `captcha-${Date.now()}`,
        imageSvg: captchaSvg,
        instruction: "请选择图中的亮色方块",
        targetLabel: "亮色方块",
        requiredSelections: 1,
        optionCount: 1,
        expiresAt: now
      });
      return;
    }
    if (method === "POST" && path === "/api/auth/captcha/verify") {
      await fulfillData(route, { verificationId: `captcha-ok-${Date.now()}`, expiresAt: now });
      return;
    }
    if (method === "POST" && path === "/api/auth/login") {
      await fulfillData(route, { user: creatorUser });
      return;
    }
    if (method === "POST" && path === "/api/auth/register") {
      await fulfillData(route, { user: creatorUser });
      return;
    }
    if (method === "POST" && path === "/api/auth/logout") {
      await fulfillData(route, { ok: true });
      return;
    }
    if (method === "POST" && path === "/api/auth/request-password-reset") {
      await fulfillData(route, { ok: true, message: "reset sent" });
      return;
    }
    if (method === "POST" && path === "/api/auth/reset-password") {
      await fulfillData(route, { ok: true, message: "reset ok" });
      return;
    }
    if (method === "GET" && path === "/api/users/me/credits") {
      await fulfillData(route, {
        account: { userId: creatorUser.id, balance: 980, totalEarned: 1200, totalSpent: 220 }
      });
      return;
    }
    if (method === "POST" && path === "/api/generation/quote") {
      await fulfillData(route, { creditCost: 24 });
      return;
    }
    if (method === "POST" && path === "/api/generation/tasks") {
      const task =
        generationOutcome === "failed"
          ? createTask("task-failed", "触发失败场景的广告图", "RUNNING")
          : createTask("task-e2e", "电影感茶杯广告图，薄荷色轮廓光", "RUNNING");
      state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)];
      await fulfillData(route, { task, balanceAfter: 956 });
      return;
    }
    if (method === "GET" && path === "/api/generation/tasks") {
      await fulfillData(route, { tasks: state.tasks });
      return;
    }
    if (method === "GET" && /^\/api\/generation\/tasks\/[^/]+$/.test(path)) {
      state.generationTaskPolls += 1;
      const taskId = path.split("/").at(-1) ?? "task-e2e";
      if (taskId === "task-failed" || generationOutcome === "failed") {
        const failed = {
          ...createTask(taskId, "触发失败场景的广告图", state.generationTaskPolls > 1 ? "FAILED" : "RUNNING"),
          failureCode: state.generationTaskPolls > 1 ? "PROVIDER_UNAVAILABLE" : null,
          failureMessage: state.generationTaskPolls > 1 ? "模型服务暂时不可用，请稍后重试。" : null
        };
        await fulfillData(route, { task: failed, images: [] });
        return;
      }
      // 历史里已存在的真实任务，按其自身数据返回，避免详情 prompt 与列表不一致
      const existing = state.tasks.find((item) => item.id === taskId);
      if (existing && existing.id !== "task-e2e") {
        await fulfillData(route, {
          task: existing,
          images: state.images.filter((image) => image.taskId === existing.id)
        });
        return;
      }
      const task = createTask(
        taskId,
        "电影感茶杯广告图，薄荷色轮廓光",
        state.generationTaskPolls > 1 ? "SUCCEEDED" : "RUNNING"
      );
      const images = state.generationTaskPolls > 1 ? state.images : [];
      await fulfillData(route, { task, images });
      return;
    }
    if (method === "GET" && path === "/api/images") {
      await fulfillData(route, { images: state.images });
      return;
    }
    if (method === "POST" && /^\/api\/images\/[^/]+\/favorite$/.test(path)) {
      const imageId = path.split("/").at(-2);
      state.images = state.images.map((image) => (image.id === imageId ? { ...image, favorite: true } : image));
      await fulfillData(route, { imageId, favorite: true });
      return;
    }
    if (method === "DELETE" && /^\/api\/images\/[^/]+\/favorite$/.test(path)) {
      const imageId = path.split("/").at(-2);
      state.images = state.images.map((image) => (image.id === imageId ? { ...image, favorite: false } : image));
      await fulfillData(route, { imageId, favorite: false });
      return;
    }
    if (method === "POST" && /^\/api\/images\/[^/]+\/download-url$/.test(path)) {
      state.downloadRequests += 1;
      await fulfillData(route, { url: "data:text/plain,e2e-download", fileName: "imagora-e2e.txt" });
      return;
    }
    if (method === "POST" && /^\/api\/images\/[^/]+\/preview-url$/.test(path)) {
      await fulfillData(route, { url: fullSizeImageUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return;
    }
    if (method === "DELETE" && /^\/api\/images\/[^/]+$/.test(path)) {
      const imageId = path.split("/").at(-1);
      state.images = state.images.filter((image) => image.id !== imageId);
      await fulfillData(route, { imageId, deleted: true });
      return;
    }
    if (method === "GET" && path === "/api/plans") {
      await fulfillData(route, { plans });
      return;
    }
    if (method === "POST" && path === "/api/orders") {
      const order = createOrder("order-new", "IG-E2E-NEW", "PENDING");
      state.orders = [order, ...state.orders.filter((item) => item.id !== order.id)];
      await fulfillData(route, { order: { id: order.id }, checkoutUrl: null });
      return;
    }
    if (method === "GET" && path === "/api/orders") {
      await fulfillData(route, { orders: state.orders });
      return;
    }
    if (method === "POST" && /^\/api\/orders\/[^/]+\/pay$/.test(path)) {
      const orderId = path.split("/").at(-2);
      const paidOrder = {
        ...(state.orders.find((order) => order.id === orderId) ??
          createOrder(orderId ?? "order-new", "IG-E2E-NEW", "PENDING")),
        status: "PAID" as const,
        paidAt: now
      };
      state.orders = state.orders.map((order) => (order.id === paidOrder.id ? paidOrder : order));
      await fulfillData(route, { order: paidOrder, balanceAfter: 1_420, checkoutUrl: null });
      return;
    }
    if (await handleAdminRoute(route, state, path, method)) {
      return;
    }

    await fulfillError(route, `Unhandled E2E route ${method} ${path}`);
  });

  return state;
}

async function handleAdminRoute(route: Route, state: MockState, path: string, method: string): Promise<boolean> {
  if (method === "GET" && path === "/api/admin/dashboard") {
    await fulfillData(route, {
      metrics: {
        users: 2,
        tasks: state.tasks.length,
        images: state.images.length,
        paidOrders: 1,
        paidRevenueCents: 900,
        aiCostCents: 120,
        grossProfitCents: 780,
        blockedSafetyEvents: 1,
        reviewRequiredSafetyEvents: state.safetyEvents.filter((event) => event.status === "REVIEW_REQUIRED").length
      }
    });
    return true;
  }
  if (method === "GET" && path === "/api/admin/metrics") {
    await fulfillData(route, {
      service: {
        uptimeSeconds: 360,
        startedAt: now,
        features: { generation: true, payments: true, uploads: true, downloads: true }
      },
      http: { requestsTotal: 128, failuresTotal: 2 },
      domain: {
        generationSuccessRate: 0.98,
        generationFailureRate: 0.02,
        averageGenerationDurationMs: 1500,
        averageQueueWaitMs: 240,
        referenceImagesTotal: 3,
        paymentEventsTotal: 4,
        paymentFailuresTotal: 1,
        refundFailuresTotal: 0,
        blockedSafetyEventsTotal: 1,
        creditsOutstanding: 980,
        creditsExpiringSoon: 120,
        creditsExpiredTotal: 20,
        paidRevenueCents: 900,
        aiCostCents: 120,
        grossProfitCents: 780
      },
      maintenance: {
        closedExpiredOrders: 1,
        reconciledPaidOrders: 1,
        reconciledPaymentEvents: 1,
        expiredCredits: 2
      },
      alerts: [
        {
          id: "alert-1",
          severity: "warning",
          area: "generation",
          metric: "generationFailureRate",
          value: 0.02,
          threshold: 0.01,
          message: "Generation failure rate is above threshold.",
          runbook:
            "Disable generation, inspect provider failures, and restart/scale workers after provider health is confirmed."
        }
      ],
      recentIncidents: [
        {
          id: "incident-1",
          severity: "warning",
          area: "generation",
          status: "OPEN",
          message: "Provider timeout while generating image.",
          errorCode: "PROVIDER_TIMEOUT",
          requestId: "req-e2e",
          userId: creatorUser.id,
          taskId: "task-history",
          orderId: null,
          route: "/api/generation/tasks",
          createdAt: now,
          updatedAt: now,
          resolvedAt: null
        }
      ],
      alertNotifications: [
        {
          id: "notification-1",
          alertId: "alert-1",
          channel: "local",
          status: "SENT",
          severity: "warning",
          dedupeKey: "generationFailureRate:warning",
          message: "Generation failure rate is above threshold.",
          createdAt: now,
          sentAt: now
        }
      ]
    });
    return true;
  }
  if (method === "GET" && path === "/api/admin/users") {
    await fulfillData(route, { users: [adminUser, creatorUser] });
    return true;
  }
  if (method === "GET" && path === "/api/admin/users/user-creator") {
    await fulfillData(route, {
      user: creatorUser,
      account: { balance: 980, totalEarned: 1200, totalSpent: 220 },
      stats: { totalOrders: 2, paidOrders: 1, totalTasks: 1, succeededTasks: 1, totalImages: 1 },
      recentOrders: state.orders,
      recentTasks: state.tasks
    });
    return true;
  }
  if (method === "GET" && path === "/api/admin/generation/tasks") {
    await fulfillData(route, { tasks: state.tasks });
    return true;
  }
  if (method === "GET" && path === "/api/admin/images") {
    await fulfillData(route, { images: state.images });
    return true;
  }
  if (method === "GET" && path === "/api/admin/orders") {
    await fulfillData(route, { orders: state.orders });
    return true;
  }
  if (method === "GET" && path === "/api/admin/plans") {
    await fulfillData(route, { plans });
    return true;
  }
  if (method === "GET" && path === "/api/admin/safety-rules") {
    await fulfillData(route, { rules: state.rules });
    return true;
  }
  if (method === "GET" && path === "/api/admin/safety-events") {
    await fulfillData(route, { events: state.safetyEvents });
    return true;
  }
  if (method === "PATCH" && /^\/api\/admin\/safety-events\/[^/]+$/.test(path)) {
    const body = readJson(route);
    const eventId = path.split("/").at(-1);
    const event = state.safetyEvents.find((item) => item.id === eventId);
    if (!event) {
      await fulfillError(route, "Safety event was not found", 404);
      return true;
    }
    event.status = body.status === "BLOCKED" ? "BLOCKED" : "PASSED";
    await fulfillData(route, { event });
    return true;
  }
  if (method === "POST" && path === "/api/admin/safety-rules") {
    const body = readJson(route);
    const rule = {
      id: `rule-${state.rules.length + 1}`,
      term: String(body.term ?? "e2e-block"),
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now
    };
    state.rules = [rule, ...state.rules];
    await fulfillData(route, { rule });
    return true;
  }
  if (method === "GET" && path === "/api/admin/audit-logs") {
    await fulfillData(route, {
      logs: [
        {
          id: "audit-1",
          adminUserId: adminUser.id,
          action: "maintenance.reconcile",
          targetType: "ORDER",
          targetId: "order-pending",
          reason: "E2E 对账演练",
          before: null,
          after: null,
          ipAddress: "127.0.0.1",
          userAgent: "Playwright",
          createdAt: now
        }
      ]
    });
    return true;
  }
  if (method === "POST" && path === "/api/admin/maintenance/reconcile") {
    await fulfillData(route, {
      maintenance: {
        closedExpiredOrders: 1,
        reconciledPaidOrders: 1,
        reconciledPaymentEvents: 1,
        expiredCredits: 2
      }
    });
    return true;
  }
  return false;
}

function createMockState(): MockState {
  return {
    downloadRequests: 0,
    generationTaskPolls: 0,
    images: [
      {
        id: "image-history",
        taskId: "task-history",
        userId: creatorUser.id,
        thumbnailUrl,
        publicUrl: "",
        width: 1024,
        height: 1024,
        visibility: "PRIVATE",
        favorite: false,
        deletedAt: null,
        createdAt: now
      }
    ],
    orders: [
      createOrder("order-pending", "IG-E2E-PENDING", "PENDING"),
      createOrder("order-paid", "IG-E2E-PAID", "PAID")
    ],
    rules: [
      {
        id: "rule-existing",
        term: "terrorist",
        action: "BLOCK",
        status: "ACTIVE",
        createdAt: now
      }
    ],
    safetyEvents: [
      {
        id: "safety-event-1",
        userId: creatorUser.id,
        targetType: "PROMPT",
        targetId: "e2e-review",
        status: "REVIEW_REQUIRED",
        reasonCode: "LOCAL_REVIEW_HIT",
        reasonMessage: "提示词需要人工复核：e2e-review",
        provider: "local-rules",
        createdAt: now
      }
    ],
    tasks: [createTask("task-history", "半透明智能相机的电影感产品摄影，薄荷色轮廓光", "SUCCEEDED")]
  };
}

function createTask(id: string, prompt: string, status: Task["status"]): Task {
  const failed = status === "FAILED";
  return {
    id,
    userId: creatorUser.id,
    clientRequestId: `client-${id}`,
    referenceImageId: null,
    prompt,
    negativePrompt: "低质量、模糊、水印、变形",
    style: "realistic",
    aspectRatio: "1:1",
    width: 1024,
    height: 1024,
    quantity: 1,
    quality: "standard",
    modelProvider: "openai",
    modelName: "openai:gpt-image-2",
    status,
    creditCost: 24,
    failureCode: failed ? "PROVIDER_UNAVAILABLE" : null,
    failureMessage: failed ? "模型服务暂时不可用，请稍后重试。" : null,
    startedAt: status === "PENDING" ? null : now,
    completedAt: status === "SUCCEEDED" || failed ? now : null,
    createdAt: now,
    updatedAt: now
  };
}

function createOrder(id: string, orderNo: string, status: Order["status"]): Order {
  return {
    id,
    userId: creatorUser.id,
    orderNo,
    planId: "plan-starter",
    amountCents: 900,
    currency: "CNY",
    paymentProvider: "mock",
    paymentIntentId: status === "PAID" ? `mock-${id}` : null,
    status,
    paidAt: status === "PAID" ? now : null,
    createdAt: now,
    updatedAt: now
  };
}

function readJson(route: Route): Record<string, unknown> {
  try {
    return route.request().postDataJSON() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fulfillData(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data })
  });
}

async function fulfillError(route: Route, message: string): Promise<void> {
  await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "NOT_FOUND", message } })
  });
}
