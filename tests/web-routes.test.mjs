import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("web exposes image detail workflow from history and favorites", async () => {
  const detailPage = await readFile(join(root, "apps/web/app/images/[imageId]/page.tsx"), "utf8");
  const historyPage = await readFile(join(root, "apps/web/app/history/page.tsx"), "utf8");
  const favoritesPage = await readFile(join(root, "apps/web/app/favorites/page.tsx"), "utf8");

  assert.match(detailPage, /\/api\/images\/\$\{imageId\}/);
  assert.match(detailPage, /\/api\/generation\/tasks\/\$\{(?:image|imageResult\.image)\.taskId\}/);
  assert.match(detailPage, /download-url/);
  assert.match(detailPage, /favorite/);
  assert.match(detailPage, /再次生成/);
  assert.match(detailPage, /删除图片/);
  assert.match(historyPage, /href=\{`\/images\/\$\{image\.id\}`\}/);
  assert.match(favoritesPage, /href=\{`\/images\/\$\{image\.id\}`\}/);
});

test("web auth pages validate inputs and registration does not ask for nickname", async () => {
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");
  const apiMain = await readFile(join(root, "apps/api/src/main.ts"), "utf8");
  const appFrame = await readFile(join(root, "apps/web/components/AppFrame.tsx"), "utf8");
  const forgotPasswordPage = await readFile(join(root, "apps/web/app/forgot-password/page.tsx"), "utf8");
  const loginPage = await readFile(join(root, "apps/web/app/login/page.tsx"), "utf8");
  const nextConfig = await readFile(join(root, "apps/web/next.config.mjs"), "utf8");
  const registerPage = await readFile(join(root, "apps/web/app/register/page.tsx"), "utf8");
  const resetPasswordPage = await readFile(join(root, "apps/web/app/reset-password/page.tsx"), "utf8");
  const verifyEmailPage = await readFile(join(root, "apps/web/app/verify-email/page.tsx"), "utf8");

  assert.match(appFrame, /role="dialog"/);
  assert.match(appFrame, /确认退出/);
  assert.match(appFrame, /await apiLogout/);
  assert.match(appFrame, /autoFocus/);
  assert.match(loginPage, /validateLoginForm/);
  assert.match(loginPage, /role="alert"/);
  assert.match(loginPage, /captchaSelections/);
  assert.match(loginPage, /captchaVerificationIds/);
  assert.match(loginPage, /requiredCaptchaRounds = 2/);
  assert.match(loginPage, /verifyLoginCaptcha/);
  assert.match(loginPage, /handleCaptchaClick/);
  assert.match(loginPage, /已选择/);
  assert.match(loginPage, /aspect-\[18\/13\]/);
  assert.match(loginPage, /acceptLoginRules/);
  assert.match(loginPage, /captchaPanelOpen/);
  assert.match(loginPage, /点击文字进行图片验证/);
  assert.match(loginPage, /我已阅读并同意登录安全准则/);
  assert.match(loginPage, /role="dialog"/);
  assert.match(loginPage, /data:image\/svg\+xml;utf8/);
  assert.doesNotMatch(loginPage, /dangerouslySetInnerHTML/);
  assert.match(registerPage, /validateRegisterForm/);
  assert.match(registerPage, /confirmPassword/);
  assert.match(registerPage, /onPaste=\{handleConfirmPasswordPaste\}/);
  assert.match(registerPage, /event\.preventDefault\(\)/);
  assert.match(registerPage, /role="alert"/);
  assert.match(registerPage, /commonPasswordBlocklist/);
  assert.doesNotMatch(registerPage, /昵称/);
  assert.doesNotMatch(registerPage, /nickname/);
  assert.match(resetPasswordPage, /validateResetPasswordForm/);
  assert.match(resetPasswordPage, /密码至少需要 12 位/);
  assert.match(resetPasswordPage, /role=\{success \? "status" : "alert"\}/);
  assert.match(forgotPasswordPage, /validateForgotPasswordForm/);
  assert.match(forgotPasswordPage, /role=\{success \? "status" : "alert"\}/);
  assert.match(verifyEmailPage, /role="status"/);
  assert.match(apiClient, /AbortController/);
  assert.match(apiClient, /verifyLoginCaptcha/);
  assert.match(apiClient, /captchaVerificationIds/);
  assert.match(apiClient, /captchaSelections/);
  assert.match(apiClient, /请求超时，请检查网络后重试。/);
  assert.match(apiClient, /INVALID_RESET_TOKEN/);
  assert.match(apiMain, /password: newPasswordSchema/);
  assert.match(apiMain, /captchaVerifications/);
  assert.match(apiMain, /captchaRequiredRounds/);
  assert.match(apiMain, /captchaSelections/);
  assert.match(apiMain, /createCaptchaChallenge/);
  assert.match(nextConfig, /X-Content-Type-Options/);
  assert.match(nextConfig, /X-Frame-Options/);
  assert.match(nextConfig, /Permissions-Policy/);
});

test("web falls back to login globally when a protected request returns 401", async () => {
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");
  const appFrame = await readFile(join(root, "apps/web/components/AppFrame.tsx"), "utf8");
  const loginPage = await readFile(join(root, "apps/web/app/login/page.tsx"), "utf8");

  // apiFetch 只对非 auth 接口的 401 广播会话过期，避免登录失败被误判为会话过期
  assert.match(apiClient, /SESSION_EXPIRED_EVENT/);
  assert.match(apiClient, /isAuthEndpoint/);
  assert.match(apiClient, /startsWith\("\/api\/auth\/"\)/);
  assert.match(
    apiClient,
    /response\.status === 401 && payload\.error\?\.code === "UNAUTHORIZED" && !isAuthEndpoint\(path\)/
  );
  // AppFrame 订阅事件后清用户态并带 next 跳登录
  assert.match(appFrame, /SESSION_EXPIRED_EVENT/);
  assert.match(appFrame, /addEventListener\(SESSION_EXPIRED_EVENT/);
  assert.match(appFrame, /router\.replace\(`\/login/);
  assert.match(appFrame, /next=\$\{encodeURIComponent\(pathname\)\}/);
  // 登录页读取 next 并防开放重定向后回跳
  assert.match(loginPage, /safeNextPath\(searchParams\.get\("next"\)\)/);
  assert.match(loginPage, /startsWith\("\/\/"\)/);
});

test("web core pages expose recoverable empty states and confirm destructive actions", async () => {
  const accountPage = await readFile(join(root, "apps/web/app/account/page.tsx"), "utf8");
  const adminPage = await readFile(join(root, "apps/web/app/admin/page.tsx"), "utf8");
  const appFrame = await readFile(join(root, "apps/web/components/AppFrame.tsx"), "utf8");
  const detailPage = await readFile(join(root, "apps/web/app/images/[imageId]/page.tsx"), "utf8");
  const favoritesPage = await readFile(join(root, "apps/web/app/favorites/page.tsx"), "utf8");
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
  const homePage = await readFile(join(root, "apps/web/app/page.tsx"), "utf8");
  const historyPage = await readFile(join(root, "apps/web/app/history/page.tsx"), "utf8");
  const ordersPage = await readFile(join(root, "apps/web/app/orders/page.tsx"), "utf8");
  const pricingPage = await readFile(join(root, "apps/web/app/pricing/page.tsx"), "utf8");

  assert.match(appFrame, /export function EmptyState/);
  assert.match(appFrame, /export function InlineNotice/);
  assert.match(appFrame, /export function ConfirmDialog/);
  assert.match(appFrame, /role=\{tone === "danger" \? "alert" : "status"\}/);

  for (const page of [accountPage, detailPage, favoritesPage, generatePage, historyPage, ordersPage, pricingPage]) {
    assert.match(page, /EmptyState/);
    assert.match(page, /InlineNotice/);
  }

  assert.match(historyPage, /ConfirmDialog/);
  assert.match(detailPage, /ConfirmDialog/);
  assert.match(favoritesPage, /ConfirmDialog/);
  assert.match(adminPage, /ConfirmDialog/);
  assert.doesNotMatch(historyPage, /window\.confirm/);
  assert.doesNotMatch(detailPage, /window\.confirm/);
  assert.doesNotMatch(favoritesPage, /window\.confirm/);
  assert.doesNotMatch(adminPage, /window\.confirm/);
  assert.match(accountPage, /emailVerifiedAt/);
  assert.match(accountPage, /重新发送验证邮件/);
  assert.match(accountPage, /\/api\/auth\/resend-verification/);
  assert.match(accountPage, /权益到账/);
  assert.match(accountPage, /异常订单/);
  assert.match(accountPage, /去订单页处理/);
  assert.match(accountPage, /PENDING", "CLOSED", "CANCELED", "REFUNDED/);
  assert.match(ordersPage, /继续支付/);
  assert.match(ordersPage, /checkoutUrl/);
  assert.match(ordersPage, /window\.location\.href/);
  assert.match(ordersPage, /ORDER_NOT_PAYABLE|订单已关闭|订单已取消|订单已退款/);
  assert.match(ordersPage, /searchParams\.get\("paid"\)/);
  assert.match(ordersPage, /searchParams\.get\("canceled"\)/);
  assert.match(ordersPage, /支付完成回跳/);
  assert.match(ordersPage, /取消了支付/);
  assert.match(ordersPage, /router\.replace/);
  assert.match(pricingPage, /searchParams\.get\("canceled"\)/);
  assert.match(pricingPage, /取消了支付/);
  assert.match(pricingPage, /router\.replace/);
  assert.match(pricingPage, /buyingPlanId/);
  assert.match(pricingPage, /clientRequestId: crypto\.randomUUID\(\)/);
  assert.match(favoritesPage, /重新加载收藏/);
  assert.match(favoritesPage, /取消收藏/);
  assert.match(ordersPage, /重新加载订单/);
  assert.match(pricingPage, /重新加载套餐/);
  assert.match(accountPage, /重新加载账户/);
  assert.match(generatePage, /validateForm/);
  assert.match(generatePage, /quoteRequestSequenceRef/);
  assert.match(generatePage, /restoreTask\(taskId\)/);
  assert.match(generatePage, /buildGenerateTaskPath\(created\.task\.id\)/);
  assert.match(generatePage, /\/api\/generation\/tasks\/\$\{taskId\}/);
  assert.match(generatePage, /setTimeout\(\(\) =>/);
  assert.match(generatePage, /readGenerationTaskSnapshot/);
  assert.match(generatePage, /saveGenerationTaskSnapshot/);
  assert.match(generatePage, /restoringTaskView/);
  assert.match(generatePage, /activeGenerationTaskId/);
  assert.match(generatePage, /submittedTaskIdRef/);
  assert.match(generatePage, /taskSyncSequenceRef/);
  assert.match(generatePage, /pollActiveGenerationTask/);
  assert.match(generatePage, /generationTaskSyncErrorMessage/);
  assert.match(generatePage, /Math\.max\(1, Math\.min\(4, Math\.trunc\(nextValue\)\)\)/);
  assert.match(generatePage, /min-h-52/);
  assert.doesNotMatch(generatePage, /参考图/);
  assert.doesNotMatch(generatePage, /referenceImageId/);
  assert.match(generatePage, /重试提交/);
  assert.match(generatePage, /去历史查看/);
  assert.match(homePage, /import Link from "next\/link"/);
  assert.match(homePage, /<Link[\s\S]*href="\/generate"/);
  assert.match(adminPage, /处理原因/);
  assert.match(adminPage, /peekCurrentUser/);
  assert.match(adminPage, /confirmDisabled=\{confirmReason\.trim\(\)\.length < 3\}/);
  assert.match(adminPage, /审计日志/);
});

test("generate entry flows keep prompt drafts out of URLs", async () => {
  const detailPage = await readFile(join(root, "apps/web/app/images/[imageId]/page.tsx"), "utf8");
  const generateDrafts = await readFile(join(root, "apps/web/lib/generateDrafts.ts"), "utf8");
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
  const historyPage = await readFile(join(root, "apps/web/app/history/page.tsx"), "utf8");
  const homePage = await readFile(join(root, "apps/web/app/page.tsx"), "utf8");
  const registerPage = await readFile(join(root, "apps/web/app/register/page.tsx"), "utf8");

  for (const page of [detailPage, generatePage, historyPage, homePage, registerPage]) {
    assert.doesNotMatch(page, /prompt=/);
    assert.doesNotMatch(page, /searchParams\.get\("prompt"\)/);
  }

  assert.match(generateDrafts, /GENERATION_DRAFT_STORAGE_KEY/);
  assert.match(generateDrafts, /sessionStorage\.setItem/);
  assert.match(generateDrafts, /sessionStorage\.getItem/);
  assert.match(generateDrafts, /sessionStorage\.removeItem/);
  assert.match(homePage, /saveGenerationDraft/);
  assert.match(historyPage, /saveGenerationDraft/);
  assert.match(detailPage, /saveGenerationDraft/);
  assert.match(generatePage, /consumeGenerationDraft/);
});

test("generate page restores browser storage state after hydration", async () => {
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
  const componentStart = generatePage.indexOf("function GenerateExperience()");
  const firstEffect = generatePage.indexOf("useEffect(() => {", componentStart);
  const preEffectBody = generatePage.slice(componentStart, firstEffect);
  const hydratedBody = generatePage.slice(firstEffect);

  assert.ok(componentStart >= 0, "GenerateExperience component should exist");
  assert.ok(firstEffect > componentStart, "GenerateExperience should use effects for browser-only state");
  assert.doesNotMatch(preEffectBody, /\bconsumeGenerationDraft\(/);
  assert.doesNotMatch(preEffectBody, /\breadGenerationTaskSnapshot\(/);
  assert.match(hydratedBody, /\bconsumeGenerationDraft\(/);
  assert.match(hydratedBody, /\breadGenerationTaskSnapshot\(/);
});

test("admin console exposes enterprise filters, detail drawers, and audit queries", async () => {
  const adminPage = await readFile(join(root, "apps/web/app/admin/page.tsx"), "utf8");
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");

  assert.match(adminPage, /selectedDetail/);
  assert.match(adminPage, /openTaskDetail/);
  assert.match(adminPage, /openImageDetail/);
  assert.match(adminPage, /openOrderDetail/);
  assert.match(adminPage, /function detailDialogLabel\(/);
  assert.match(adminPage, /aria-label=\{`.*详情`\}/);
  assert.match(adminPage, /\/api\/admin\/generation\/tasks\/\$\{taskId\}/);
  assert.match(adminPage, /\/api\/admin\/images\/\$\{imageId\}/);
  assert.match(adminPage, /\/api\/admin\/orders\/\$\{orderId\}/);

  assert.match(adminPage, /时间范围/);
  assert.match(adminPage, /createdFrom/);
  assert.match(adminPage, /createdTo/);
  assert.match(adminPage, /userIdFilter/);
  assert.match(adminPage, /orderNoFilter/);
  assert.match(adminPage, /订单号筛选/);
  assert.match(adminPage, /adminUserId/);
  assert.match(adminPage, /auditActionFilter/);
  assert.match(adminPage, /auditTargetTypeFilter/);
  assert.match(adminPage, /auditTargetIdFilter/);

  assert.match(apiClient, /export type AuditLog/);
  assert.match(apiClient, /adminUserId: string/);
  assert.match(apiClient, /reason: string \| null/);
  assert.match(apiClient, /userId: string/);
  assert.match(apiClient, /paymentIntentId/);
});

test("admin console exposes operational incidents and alert notifications", async () => {
  const adminPage = await readFile(join(root, "apps/web/app/admin/page.tsx"), "utf8");
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");

  assert.match(adminPage, /最近异常/);
  assert.match(adminPage, /处理状态/);
  assert.match(adminPage, /告警通知/);
  assert.match(adminPage, /recentIncidents/);
  assert.match(adminPage, /alertNotifications/);
  assert.match(adminPage, /requestId/);
  assert.match(adminPage, /taskId/);
  assert.match(adminPage, /orderId/);

  assert.match(apiClient, /export type OperationalIncident/);
  assert.match(apiClient, /export type AlertNotification/);
  assert.match(apiClient, /recentIncidents: OperationalIncident\[\]/);
  assert.match(apiClient, /alertNotifications: AlertNotification\[\]/);
  assert.match(apiClient, /averageQueueWaitMs/);
  assert.match(apiClient, /paymentFailuresTotal/);
  assert.match(apiClient, /refundFailuresTotal/);
});

test("admin console exposes safety review queue and manual handling actions", async () => {
  const adminPage = await readFile(join(root, "apps/web/app/admin/page.tsx"), "utf8");
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");

  assert.match(adminPage, /安全事件/);
  assert.match(adminPage, /safetyEvents/);
  assert.match(adminPage, /\/api\/admin\/safety-events/);
  assert.match(adminPage, /safety-event/);
  assert.match(adminPage, /人工复核/);
  assert.match(adminPage, /复核通过/);
  assert.match(adminPage, /确认拦截/);

  assert.match(apiClient, /export type SafetyEvent/);
  assert.match(apiClient, /REVIEW_REQUIRED/);
  assert.match(apiClient, /reviewRequiredSafetyEvents/);
});

test("generate page exposes safety appeal entry after direct content blocking", async () => {
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");

  assert.match(generatePage, /async function loadLatestSafetyAppeal\(\)/);
  assert.match(generatePage, /await loadLatestSafetyAppeal\(\);/);
  assert.match(generatePage, /CONTENT_REVIEW_REQUIRED/);
  assert.match(apiClient, /body: \{ safetyEventId, reason \}/);
});

test("generation failures reconcile refunds and surface refunded credit copy", async () => {
  const apiMain = await readFile(join(root, "apps/api/src/main.ts"), "utf8");
  const apiClient = await readFile(join(root, "apps/web/lib/api.ts"), "utf8");
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
  const workerMain = await readFile(join(root, "apps/worker/src/main.ts"), "utf8");

  assert.match(apiMain, /runGenerationMaintenance/);
  assert.match(apiMain, /startBackgroundGenerationMaintenance/);
  assert.match(apiMain, /GENERATION_MAINTENANCE_INTERVAL_MS/);
  assert.match(apiMain, /\/api\/admin\/maintenance\/reconcile-generation/);
  assert.match(apiClient, /refundedCredits\?: number/);
  assert.match(generatePage, /generationFailureMessage/);
  assert.match(generatePage, /generationTaskSyncErrorMessage/);
  assert.match(generatePage, /页面会继续自动刷新结果/);
  assert.match(generatePage, /setActiveGenerationTaskId\(created\.task\.id\)/);
  assert.match(generatePage, /setMessageTone\("info"\)/);
  assert.match(generatePage, /已自动返还/);
  assert.match(workerMain, /refundTaskCredits/);
  assert.match(workerMain, /provider: provider\.name/);
  assert.match(workerMain, /deliveredQuote\.creditCost/);
  assert.match(workerMain, /NO_IMAGES_DELIVERED/);
});

test("generate page shows animated processing placeholders before results arrive", async () => {
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
  const draftsFile = await readFile(join(root, "apps/web/lib/generateDrafts.ts"), "utf8");

  assert.match(generatePage, /function GenerationProcessingPlaceholder/);
  assert.match(generatePage, /isGenerationProcessing/);
  assert.match(generatePage, /setTask\(null\);/);
  assert.match(generatePage, /Array\.from\(\{ length: Math\.max\(1, quantity\) \}/);
  assert.match(generatePage, /生成占位/);
  assert.match(generatePage, /aria-label=\{`第 \$\{index \+ 1\} 张图片正在生成`\}/);
  assert.match(generatePage, /style=\{\{ aspectRatio: processingAspectRatio/);
  assert.match(generatePage, /motion-reduce:/);
  assert.match(generatePage, /animate-spin/);
  assert.match(generatePage, /animate-pulse/);
  assert.match(generatePage, /terminalGenerationFailureMessage/);
  assert.match(generatePage, /生成失败/);
  assert.match(generatePage, /!terminalGenerationFailureMessage && !isGenerationProcessing && images\.length === 0/);
  assert.match(generatePage, /task\?\.failureMessage/);
  assert.match(generatePage, /正在恢复上一次生成结果/);
  assert.match(draftsFile, /GENERATION_TASK_SNAPSHOTS_STORAGE_KEY/);
  assert.match(draftsFile, /saveGenerationTaskSnapshot/);
  assert.match(draftsFile, /readGenerationTaskSnapshot/);
});
