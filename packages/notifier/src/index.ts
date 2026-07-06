import type { AlertNotificationPayload } from "@imagora/shared";
import type { Mailer } from "@imagora/mailer";

/**
 * 单个告警通道的发送结果。ok=false 时 error 给出简短原因（会落库到 message）。
 */
export interface ChannelResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/**
 * 告警外发通道抽象。所有通道底层都是"把一条告警送出去"，
 * 具体是 SMTP 邮件还是 HTTP webhook 由实现决定。
 */
export interface NotificationChannel {
  readonly name: string;
  send(payload: AlertNotificationPayload): Promise<void>;
}

const SEVERITY_LABEL: Record<AlertNotificationPayload["severity"], string> = {
  info: "INFO",
  warning: "WARNING",
  critical: "CRITICAL"
};

/**
 * 把告警渲染成人类可读的纯文本，邮件与 webhook 的 text 字段共用。
 */
export function renderAlertText(payload: AlertNotificationPayload): string {
  const label = SEVERITY_LABEL[payload.severity] ?? payload.severity.toUpperCase();
  return [
    `[${label}] ${payload.message}`,
    `Alert: ${payload.id}`,
    `Area: ${payload.area}`,
    `Metric: ${payload.metric} = ${payload.value} (threshold ${payload.threshold})`,
    `Runbook: ${payload.runbook}`
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAlertHtml(payload: AlertNotificationPayload): string {
  const label = SEVERITY_LABEL[payload.severity] ?? payload.severity.toUpperCase();
  const color = payload.severity === "critical" ? "#b91c1c" : payload.severity === "warning" ? "#b45309" : "#334155";
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;line-height:1.6;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
  <p style="margin:0 0 12px;"><strong style="color:${color};">[${label}]</strong> ${escapeHtml(payload.message)}</p>
  <table style="border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:2px 12px 2px 0;color:#666;">Alert</td><td>${escapeHtml(payload.id)}</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666;">Area</td><td>${escapeHtml(payload.area)}</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666;">Metric</td><td>${escapeHtml(payload.metric)} = ${payload.value} (threshold ${payload.threshold})</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666;">Runbook</td><td>${escapeHtml(payload.runbook)}</td></tr>
  </table>
</div>`;
}

export interface WebhookChannelOptions {
  url: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 通用 Webhook 通道：POST 一个结构化 JSON 到目标 URL。
 * 非 2xx 视为失败；带超时与有限重试。适配自建告警网关 / Slack / 企业微信等只需改接收端格式。
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = "webhook";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebhookChannelOptions) {
    if (!options.url) {
      throw new Error("WebhookChannel requires a url");
    }
    this.url = options.url;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 10_000;
    this.maxAttempts = options.maxAttempts && options.maxAttempts > 0 ? options.maxAttempts : 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(payload: AlertNotificationPayload): Promise<void> {
    const body = JSON.stringify({
      id: payload.id,
      severity: payload.severity,
      area: payload.area,
      metric: payload.metric,
      value: payload.value,
      threshold: payload.threshold,
      message: payload.message,
      runbook: payload.runbook,
      text: renderAlertText(payload)
    });

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal
        });
        if (response.status >= 200 && response.status < 300) {
          return;
        }
        lastError = new Error(`webhook responded with status ${response.status}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("webhook delivery failed");
  }
}

export interface EmailChannelOptions {
  mailer: Mailer;
  recipients: string;
}

/**
 * 邮件通道：复用现有 Mailer（生产为真实 SmtpMailer）把告警发到运维邮箱。
 */
export class EmailChannel implements NotificationChannel {
  readonly name = "email";
  private readonly mailer: Mailer;
  private readonly recipients: string;

  constructor(options: EmailChannelOptions) {
    if (!options.recipients) {
      throw new Error("EmailChannel requires recipients");
    }
    this.mailer = options.mailer;
    this.recipients = options.recipients;
  }

  async send(payload: AlertNotificationPayload): Promise<void> {
    const label = SEVERITY_LABEL[payload.severity] ?? payload.severity.toUpperCase();
    await this.mailer.sendEmail({
      to: this.recipients,
      subject: `[Imagora][${label}] ${payload.message}`,
      text: renderAlertText(payload),
      html: renderAlertHtml(payload)
    });
  }
}

/**
 * 告警分发器：向所有已配置通道并发发送，收敛每个通道的成功/失败结果。
 * dispatch 本身不抛错——单通道失败不影响其它通道，结果供调用方落库。
 */
export class AlertNotifier {
  constructor(private readonly channels: NotificationChannel[]) {}

  get channelNames(): string[] {
    return this.channels.map((channel) => channel.name);
  }

  hasChannels(): boolean {
    return this.channels.length > 0;
  }

  /**
   * 向通道并发发送。可选 channels 只发指定名字的通道（用于按冷却窗口跳过已发通道）。
   * 单通道失败被收敛为 ok=false，不影响其它通道，也不抛错。
   */
  async dispatch(payload: AlertNotificationPayload, options?: { channels?: string[] }): Promise<ChannelResult[]> {
    const targets = options?.channels
      ? this.channels.filter((channel) => options.channels?.includes(channel.name))
      : this.channels;
    return Promise.all(
      targets.map(async (channel) => {
        try {
          await channel.send(payload);
          return { channel: channel.name, ok: true } satisfies ChannelResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { channel: channel.name, ok: false, error: message } satisfies ChannelResult;
        }
      })
    );
  }
}

export interface CreateAlertNotifierOptions {
  mailer: Mailer;
  env?: NodeJS.ProcessEnv;
}

/**
 * 按环境变量装配通道：
 * - ALERT_WEBHOOK_URL 存在 → 加 WebhookChannel（ALERT_WEBHOOK_TIMEOUT_MS/ALERT_WEBHOOK_MAX_ATTEMPTS 可调）
 * - ALERT_EMAIL_TO 存在 → 加 EmailChannel（复用传入 mailer）
 * 没有任何配置则返回零通道 notifier（hasChannels()=false），由生产门禁在别处拦截。
 */
export function createAlertNotifier(options: CreateAlertNotifierOptions): AlertNotifier {
  const env = options.env ?? process.env;
  const channels: NotificationChannel[] = [];

  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    channels.push(
      new WebhookChannel({
        url: webhookUrl,
        timeoutMs: envNumber(env.ALERT_WEBHOOK_TIMEOUT_MS),
        maxAttempts: envNumber(env.ALERT_WEBHOOK_MAX_ATTEMPTS)
      })
    );
  }

  const emailTo = env.ALERT_EMAIL_TO?.trim();
  if (emailTo) {
    channels.push(new EmailChannel({ mailer: options.mailer, recipients: emailTo }));
  }

  return new AlertNotifier(channels);
}

function envNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
