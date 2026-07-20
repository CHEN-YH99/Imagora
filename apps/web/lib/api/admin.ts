const labelMap: Record<string, string> = {
  ACTIVE: "启用",
  ADMIN: "管理员",
  ADJUST: "人工调整",
  ACKNOWLEDGED: "已确认",
  APPROVED: "已通过",
  BLOCK: "拦截",
  BLOCKED: "已拦截",
  CANCELED: "已取消",
  CLOSED: "已关闭",
  critical: "严重",
  DELETED: "已删除",
  EXPIRE: "过期",
  FAILED: "失败",
  GRANT: "发放",
  HIDDEN: "已隐藏",
  IDLE: "待提交",
  INACTIVE: "停用",
  info: "提示",
  OPEN: "待处理",
  PAID: "已支付",
  PASSED: "已通过",
  PENDING: "待处理",
  PRIVATE: "私有",
  PUBLIC: "公开",
  REFUND: "退回",
  REFUNDED: "退款成功",
  REJECTED: "已驳回",
  RESOLVED: "已解决",
  REVIEW: "复核",
  REVIEW_REQUIRED: "待复核",
  RUNNING: "处理中",
  SENT: "已发送",
  SPEND: "消耗",
  SUCCEEDED: "已完成",
  SUSPENDED: "已停用",
  USER: "普通用户",
  warning: "警告"
};

const styleLabelMap: Record<string, string> = {
  anime: "动漫",
  cinematic: "电影写实",
  illustration: "插画",
  isometric: "等距图形",
  poster: "海报设计",
  product: "产品摄影",
  product_photography: "产品摄影",
  realistic: "写实"
};

const qualityLabelMap: Record<string, string> = {
  draft: "草稿",
  Draft: "草稿",
  high: "高清",
  standard: "标准",
  Studio: "标准",
  Ultra: "精细"
};

const planNameMap: Record<string, string> = {
  Creator: "创作者版",
  Starter: "入门版",
  Studio: "团队版"
};

const planDescriptionMap: Record<string, string> = {
  "1850 credits for teams and ecommerce operators": "面向小团队、电商运营和持续内容生产的高容量积分包。",
  "220 credits for prompt exploration": "适合验证提示词方向、探索风格和完成轻量创作。",
  "620 credits with HD downloads": "适合个人创作者稳定生成素材，并支持高清下载。"
};

const providerLabelMap: Record<string, string> = {
  alipay: "支付宝",
  mock: "平台结算",
  stripe: "银行卡支付",
  wechat: "微信支付"
};

const auditActionMap: Record<string, string> = {
  "maintenance.generation.reconcile": "生成任务补偿对账",
  "image.visibility.update": "图片可见性变更",
  "maintenance.reconcile": "订单对账",
  "order.refund": "订单退款",
  "plan.create": "创建套餐",
  "plan.update": "更新套餐",
  "safety-appeal.review": "安全申诉处理",
  "safety-rule.create": "新增安全规则",
  "safety-rule.update": "更新安全规则",
  "safety-event.review": "安全事件复核",
  "user.credits.adjust": "用户积分调整",
  "user.status.update": "用户状态变更"
};

const targetTypeMap: Record<string, string> = {
  IMAGE: "图片",
  ORDER: "订单",
  PLAN: "套餐",
  PROMPT: "提示词",
  SAFETY_RULE: "安全规则",
  SAFETY_EVENT: "安全事件",
  SAFETY_APPEAL: "安全申诉",
  SYSTEM: "系统",
  TASK: "任务",
  UPLOAD_IMAGE: "参考图",
  USER: "用户"
};

const metricLabelMap: Record<string, string> = {
  generation: "生成",
  generationBacklog: "生成任务积压",
  generationFailureRate: "生成失败率",
  http: "接口",
  httpFailureRate: "接口失败率",
  paymentAmountMismatchEvents: "支付金额不一致事件",
  payments: "支付",
  pendingOrders: "待支付订单",
  refundFailuresTotal: "积分退回失败",
  staleRunningTasks: "长时间运行任务"
};

const alertMessageMap: Record<string, string> = {
  "Generation failure rate is above threshold.": "生成失败率超过阈值。",
  "Generation task backlog is above threshold.": "生成任务积压超过阈值。",
  "Generation tasks have been running longer than the stale threshold.": "存在运行时间超过阈值的生成任务。",
  "Generation refund failures were detected.": "检测到生成失败后的积分退回异常。",
  "HTTP 5xx failure rate is above threshold.": "服务接口 5xx 失败率超过阈值。",
  "Payment succeeded events with amount mismatch were detected.": "检测到支付成功事件与订单金额不一致。",
  "Pending payment orders are above threshold.": "待支付订单数量超过阈值。"
};

const alertRunbookMap: Record<string, string> = {
  "Check payment provider status, disable payments if needed, and run order reconciliation.":
    "检查支付服务状态，必要时暂停支付入口，并执行订单对账。",
  "Disable generation, inspect provider failures, and restart/scale workers after provider health is confirmed.":
    "暂停生成入口，检查模型服务故障，确认服务恢复后重启或扩容生成处理服务。",
  "Do not manually grant credits until the provider event and order snapshot are verified.":
    "在核对支付事件和订单快照前，不要手动发放积分。",
  "Inspect route metrics, recent deploys, and provider logs by requestId.":
    "按请求编号检查路由指标、近期发布记录和外部服务日志。",
  "Pause generation, inspect credit ledger entries by taskId, and reconcile refunds before retrying.":
    "暂停生成入口，按任务编号核对积分流水，完成退回对账后再恢复重试。",
  "Run worker recovery, verify refunds, and check provider timeout logs by taskId.":
    "执行生成处理服务恢复流程，核对积分退回，并按任务编号检查超时日志。",
  "Scale workers or temporarily disable generation submissions until backlog drains.":
    "扩容生成处理服务，或临时暂停新的生成提交，直到积压任务处理完毕。"
};

const safetyRuleTermMap: Record<string, string> = {
  "child abuse": "儿童安全风险内容",
  "sexual violence": "性暴力内容",
  terrorist: "恐怖主义内容"
};

export function formatStatusLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return labelMap[value] ?? value;
}

export function formatStyleLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return styleLabelMap[value] ?? value;
}

export function formatQualityLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return qualityLabelMap[value] ?? value;
}

export function formatCredits(value: number): string {
  return `${value.toLocaleString("zh-CN")} 积分`;
}

export function formatPlanName(value: string): string {
  return planNameMap[value] ?? value;
}

export function formatPlanDescription(value: string): string {
  return planDescriptionMap[value] ?? value;
}

export function formatPaymentProvider(value: string): string {
  return providerLabelMap[value] ?? value;
}

export function formatAuditAction(value: string): string {
  return auditActionMap[value] ?? value;
}

export function formatTargetType(value: string): string {
  return targetTypeMap[value] ?? value;
}

export function formatMetricLabel(value: string): string {
  return metricLabelMap[value] ?? value;
}

export function formatOperationalAlertMessage(value: string): string {
  return alertMessageMap[value] ?? value;
}

export function formatOperationalRunbook(value: string): string {
  return alertRunbookMap[value] ?? value;
}

export function formatSafetyRuleTerm(value: string): string {
  return safetyRuleTermMap[value] ?? value;
}

export function formatNickname(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  if (value === "Demo Creator") {
    return "创作用户";
  }
  if (value === "Imagora Admin") {
    return "Imagora 管理员";
  }
  return value;
}

export function formatLedgerRemark(value: string): string {
  if (value === "Initial admin credits") {
    return "管理员初始积分";
  }
  if (value === "Demo welcome credits" || value === "Welcome credits") {
    return "新用户欢迎积分";
  }
  if (value === "Image generation task") {
    return "图片生成任务扣减";
  }
  if (value === "Retry image generation task") {
    return "重新生成任务扣减";
  }
  if (value === "Generation task could not be queued") {
    return "生成任务入队失败自动返还";
  }
  if (value === "Task ended before image delivery" || value === "Task failed before image delivery") {
    return "生成未交付自动返还";
  }
  if (value === "未交付图片的积分自动返还") {
    return value;
  }
  if (value.startsWith("Purchased ")) {
    return `购买${formatPlanName(value.replace("Purchased ", ""))}`;
  }
  return value;
}
