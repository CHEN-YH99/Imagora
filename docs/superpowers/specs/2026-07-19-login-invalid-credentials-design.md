# 登录凭据错误与验证码重试设计

## 目标

拆分凭据错误、验证码错误和会话失效，恢复登录尝试令牌支持的免重复验证码重试。

## 契约

- 凭据错误返回 `401 INVALID_CREDENTIALS`，显示“邮箱或密码不正确。”。
- `CAPTCHA_REQUIRED` / `CAPTCHA_INVALID` 才重置图片验证。
- 受保护资源的 `401 UNAUTHORIZED` 继续广播会话失效。

## 重试

- 首次验证后凭据错误，后端签发 HttpOnly 登录尝试 cookie。
- 前端设置 `loginRetryAvailable=true`，允许修改密码后直接重试。
- 重试 cookie 失效时，后端返回验证码错误，前端再要求重新验证。

## 验证

- auth 测试锁定新错误码和尝试 cookie。
- web 测试锁定错误提示和条件化验证码重置。
- 执行 typecheck、全量测试、build 和运行态验活。
