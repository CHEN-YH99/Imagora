const apiErrorCodeMap: Record<string, string> = {
  CONFLICT: "账号信息无法完成注册，请检查邮箱或直接登录。",
  CAPTCHA_INVALID: "图片验证已失效或输入错误，请刷新后重试。",
  CAPTCHA_REQUIRED: "请先完成图片验证。",
  INVALID_CREDENTIALS: "邮箱或密码不正确。",
  CONTENT_BLOCKED: "内容未通过安全规则，请调整提示词或参考图后重试。",
  CONTENT_REVIEW_REQUIRED: "内容已提交人工复核，暂时无法生成。如认为是误判，可在下方发起申诉。",
  FEATURE_DISABLED: "该功能当前暂不可用，请稍后再试。",
  FORBIDDEN: "当前账号没有权限执行此操作。",
  INSUFFICIENT_CREDITS: "积分余额不足，请充值后再提交生成。",
  INTERNAL_ERROR: "服务暂时异常，请稍后重试。",
  INVALID_CURRENT_PASSWORD: "当前密码不正确，请重新输入。",
  INVALID_RESET_TOKEN: "重置链接无效或已过期，请重新申请。",
  INVALID_VERIFY_TOKEN: "验证链接无效或已过期，请重新申请验证邮件。",
  NOT_FOUND: "请求的资源不存在或已被移除。",
  ORDER_NOT_PAYABLE: "该订单当前不可支付，请重新创建订单。",
  PLAN_UNAVAILABLE: "该套餐当前不可购买，请选择其他套餐。",
  RATE_LIMITED: "操作过于频繁，请稍后再试。",
  RATE_LIMIT_UNAVAILABLE: "服务限流组件暂时不可用，请稍后再试。",
  TASK_NOT_RETRYABLE: "只有失败或被拦截的任务可以重新生成。",
  UNAUTHORIZED: "登录已失效，请重新登录。",
  VALIDATION_ERROR: "提交内容格式不正确，请检查后重试。"
};

const apiErrorMessageMap: Record<string, string> = {
  "Admin cannot change own status here": "不能在此处修改当前管理员账号状态。",
  "Cannot remove the last active administrator": "不能移除最后一个启用中的管理员账号。",
  "Credit balance is not enough": "积分余额不足，请充值后再提交生成。",
  "Email is already registered": "该邮箱已注册，请直接登录或更换邮箱。",
  "Unable to create account with these credentials": "账号信息无法完成注册，请检查邮箱或直接登录。",
  "Invalid email or password": "邮箱或密码不正确。",
  "Invalid request payload": "提交内容格式不正确，请检查后重试。",
  "Only failed or blocked tasks can be retried": "只有失败或被拦截的任务可以重新生成。",
  "Order is not payable": "该订单当前不可支付，请重新创建订单。",
  "Payment provider does not match order": "支付渠道与订单不匹配，请重新创建订单。",
  "Payment provider is not enabled": "当前支付渠道未启用。",
  "Plan is not available": "该套餐当前不可购买，请选择其他套餐。",
  "Prompt requires manual safety review": "内容需要人工复核，暂时无法提交生成；如有误判请联系管理员申诉。",
  "Reference image requires manual safety review": "参考图需要人工复核，暂时无法使用；如有误判请联系管理员申诉。",
  "Prompt was blocked by safety rules": "提示词未通过安全规则，请调整后重试。",
  "Reference image content is empty": "参考图内容为空，请重新上传。",
  "Reference image content is not valid base64": "参考图内容无法识别，请重新上传。",
  "Reference image was blocked by safety rules": "参考图未通过安全规则，请更换图片后重试。",
  "Request failed": "请求失败，请稍后重试。",
  "Too many requests, please retry later": "操作过于频繁，请稍后再试。",
  "User is not active": "账号当前不可用，请联系管理员。"
};

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string | undefined,
    public readonly apiMessage: string | undefined,
    public readonly status: number
  ) {
    super(formatApiErrorMessage(code, apiMessage, status));
    this.name = "ApiRequestError";
  }
}

export function formatApiErrorMessage(code: string | undefined, message: string | undefined, status?: number): string {
  if (code && apiErrorCodeMap[code]) {
    return apiErrorCodeMap[code];
  }
  if (message && apiErrorMessageMap[message]) {
    return apiErrorMessageMap[message];
  }
  return status ? `请求失败，请稍后重试。（${status}）` : "请求失败，请稍后重试。";
}
