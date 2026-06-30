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

test("web core pages expose recoverable empty states and confirm destructive actions", async () => {
  const accountPage = await readFile(join(root, "apps/web/app/account/page.tsx"), "utf8");
  const adminPage = await readFile(join(root, "apps/web/app/admin/page.tsx"), "utf8");
  const appFrame = await readFile(join(root, "apps/web/components/AppFrame.tsx"), "utf8");
  const detailPage = await readFile(join(root, "apps/web/app/images/[imageId]/page.tsx"), "utf8");
  const favoritesPage = await readFile(join(root, "apps/web/app/favorites/page.tsx"), "utf8");
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");
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
  assert.match(favoritesPage, /重新加载收藏/);
  assert.match(favoritesPage, /取消收藏/);
  assert.match(ordersPage, /重新加载订单/);
  assert.match(pricingPage, /重新加载套餐/);
  assert.match(accountPage, /重新加载账户/);
  assert.match(generatePage, /validateForm/);
  assert.match(generatePage, /Math\.max\(1, Math\.min\(4, Math\.trunc\(nextValue\)\)\)/);
  assert.match(generatePage, /参考图上传完成/);
  assert.match(generatePage, /重试提交/);
  assert.match(generatePage, /去历史查看/);
  assert.match(adminPage, /处理原因/);
  assert.match(adminPage, /confirmDisabled=\{confirmReason\.trim\(\)\.length < 3\}/);
  assert.match(adminPage, /审计日志/);
});
