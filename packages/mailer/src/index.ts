import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface Mailer {
  sendEmail(input: SendEmailInput): Promise<void>;
}

export interface VerificationEmailInput {
  to: string;
  nickname: string;
  verifyUrl: string;
}

export function buildVerificationEmail(input: VerificationEmailInput): SendEmailInput {
  const { to, nickname, verifyUrl } = input;
  const subject = "验证你的 Imagora 邮箱";
  const text =
    `你好 ${nickname}，\n\n` +
    `感谢注册 Imagora。请点击下方链接完成邮箱验证，验证后将自动到账 120 积分：\n` +
    `${verifyUrl}\n\n` +
    `链接将在 24 小时后失效。如果不是你本人操作，请忽略本邮件。\n\n— Imagora`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;line-height:1.6;color:#1a1a1a;max-width:560px;margin:0 auto;padding:32px 24px;">
  <h1 style="font-size:20px;margin:0 0 16px;">你好，${escapeHtml(nickname)}</h1>
  <p>感谢注册 Imagora。请点击下方按钮完成邮箱验证，验证后将自动到账 <strong>120 积分</strong>。</p>
  <p style="margin:24px 0;">
    <a href="${verifyUrl}" style="display:inline-block;padding:10px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">验证邮箱</a>
  </p>
  <p style="font-size:13px;color:#666;">如果按钮无法点击，请复制以下链接到浏览器：</p>
  <p style="font-size:13px;color:#666;word-break:break-all;">${verifyUrl}</p>
  <p style="font-size:13px;color:#999;margin-top:32px;">链接将在 24 小时后失效。如果不是你本人操作，请忽略本邮件。</p>
</div>`;
  return { to, subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * ConsoleMailer - 开发环境用，将邮件内容输出到控制台
 * 生产环境不应使用此实现
 */
export class ConsoleMailer implements Mailer {
  async sendEmail(input: SendEmailInput): Promise<void> {
    console.log("[ConsoleMailer] Sending email:");
    console.log(`  To: ${input.to}`);
    console.log(`  Subject: ${input.subject}`);
    console.log(`  Body (text):\n${input.text ?? "(no text version)"}`);
    console.log(`  Body (html):\n${input.html}`);
    console.log("[ConsoleMailer] Email sent (logged only, not actually delivered)");
  }
}

/**
 * SmtpMailer - SMTP 邮件发送（骨架占位）
 *
 * 使用前需要配置环境变量：
 * - SMTP_HOST: SMTP 服务器地址
 * - SMTP_PORT: SMTP 端口（默认 587）
 * - SMTP_USER: SMTP 用户名
 * - SMTP_PASSWORD: SMTP 密码
 * - SMTP_FROM: 发件人地址
 */
export class SmtpMailer implements Mailer {
  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly password: string;
  private readonly from: string;
  private readonly fromName: string;
  private readonly secure: boolean;
  private readonly requireTls: boolean;
  private readonly timeoutMs: number;

  constructor() {
    this.host = this.requiredEnv("SMTP_HOST");
    this.port = envNumber("SMTP_PORT", 587);
    this.user = this.requiredEnv("SMTP_USER");
    this.password = this.requiredEnv("SMTP_PASSWORD");
    this.from = this.requiredEnv("SMTP_FROM");
    this.fromName = process.env.SMTP_FROM_NAME ?? "Imagora";
    this.secure = envBool("SMTP_SECURE", this.port === 465);
    this.requireTls = envBool("SMTP_REQUIRE_TLS", true);
    this.timeoutMs = envNumber("SMTP_TIMEOUT_MS", 15_000);
  }

  async sendEmail(input: SendEmailInput): Promise<void> {
    const recipients = parseRecipients(input.to);
    if (!recipients.length) {
      throw new Error("Email recipient is required");
    }

    const client = new SmtpClient({
      host: this.host,
      port: this.port,
      secure: this.secure,
      requireTls: this.requireTls,
      timeoutMs: this.timeoutMs
    });

    try {
      await client.connect();
      await client.authenticate(this.user, this.password);
      await client.send({
        from: this.from,
        recipients,
        message: buildMimeMessage({
          from: formatMailbox(this.from, this.fromName),
          to: input.to,
          subject: input.subject,
          html: input.html,
          text: input.text
        })
      });
    } finally {
      await client.close();
    }
  }

  private requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  }
}

/**
 * AliyunMailer - 阿里云邮件推送（骨架占位）
 *
 * 使用前需要配置环境变量：
 * - ALIYUN_ACCESS_KEY_ID: 阿里云 Access Key ID
 * - ALIYUN_ACCESS_KEY_SECRET: 阿里云 Access Key Secret
 * - ALIYUN_MAIL_REGION: 邮件推送区域（默认 cn-hangzhou）
 * - ALIYUN_MAIL_FROM: 发件人地址
 */
export class AliyunMailer implements Mailer {
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly region: string;
  private readonly from: string;

  constructor() {
    this.accessKeyId = this.requiredEnv("ALIYUN_ACCESS_KEY_ID");
    this.accessKeySecret = this.requiredEnv("ALIYUN_ACCESS_KEY_SECRET");
    this.region = process.env.ALIYUN_MAIL_REGION ?? "cn-hangzhou";
    this.from = this.requiredEnv("ALIYUN_MAIL_FROM");
  }

  async sendEmail(_input: SendEmailInput): Promise<void> {
    // TODO: 实现阿里云邮件推送
    // 参考文档: https://help.aliyun.com/document_detail/29444.html
    throw new Error(
      "AliyunMailer not implemented yet. Install @alicloud/dm20151123 and implement DirectMail API:\n" +
        "  npm install @alicloud/dm20151123\n" +
        `  Region: ${this.region}, From: ${this.from}`
    );
  }

  private requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  }
}

/**
 * 创建邮件服务实例
 * 根据环境变量 MAILER_PROVIDER 选择实现：
 * - "console" (默认): ConsoleMailer - 开发环境，输出到控制台
 * - "smtp": SmtpMailer - 使用 SMTP 发送
 * - "aliyun": AliyunMailer - 使用阿里云邮件推送
 */
export function createMailer(): Mailer {
  const provider = process.env.MAILER_PROVIDER ?? "console";

  switch (provider) {
    case "console":
      return new ConsoleMailer();
    case "smtp":
      return new SmtpMailer();
    case "aliyun":
      return new AliyunMailer();
    default:
      throw new Error(`Unknown MAILER_PROVIDER: ${provider}. Valid options: console, smtp, aliyun`);
  }
}

interface SmtpClientOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  timeoutMs: number;
}

interface SendSmtpMessageInput {
  from: string;
  recipients: string[];
  message: string;
}

class SmtpClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private pending: {
    resolve: (response: SmtpResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private capabilities = new Set<string>();

  constructor(private readonly options: SmtpClientOptions) {}

  async connect(): Promise<void> {
    this.socket = await openSocket(this.options);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.handleData(chunk.toString()));
    this.socket.on("error", (error) => this.rejectPending(error));
    this.socket.on("close", () => this.rejectPending(new Error("SMTP connection closed unexpectedly")));

    await this.expect([220]);
    await this.ehlo();

    if (!this.options.secure && this.capabilities.has("STARTTLS")) {
      await this.command("STARTTLS", [220]);
      await this.upgradeToTls();
      await this.ehlo();
    } else if (!this.options.secure && this.options.requireTls) {
      throw new Error("SMTP server does not advertise STARTTLS");
    }
  }

  async authenticate(user: string, password: string): Promise<void> {
    const credentials = Buffer.from(`\u0000${user}\u0000${password}`, "utf8").toString("base64");
    if (this.capabilities.has("AUTH PLAIN") || this.capabilities.has("AUTH")) {
      await this.command(`AUTH PLAIN ${credentials}`, [235]);
      return;
    }

    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(user, "utf8").toString("base64"), [334]);
    await this.command(Buffer.from(password, "utf8").toString("base64"), [235]);
  }

  async send(input: SendSmtpMessageInput): Promise<void> {
    await this.command(`MAIL FROM:<${input.from}>`, [250]);
    for (const recipient of input.recipients) {
      await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await this.command("DATA", [354]);
    await this.command(`${dotStuff(input.message)}\r\n.`, [250]);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return;
    }

    try {
      await this.command("QUIT", [221]);
    } catch {
      // The message has already been sent; close best-effort.
    } finally {
      socket.end();
      this.socket = null;
    }
  }

  private async ehlo(): Promise<void> {
    const response = await this.command("EHLO imagora.local", [250]);
    this.capabilities = parseCapabilities(response.lines);
  }

  private async upgradeToTls(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      throw new Error("SMTP connection is not open");
    }

    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SMTP STARTTLS timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      const upgraded = tls.connect(
        {
          socket,
          servername: this.options.host
        },
        () => {
          clearTimeout(timer);
          resolve(upgraded);
        }
      );
      upgraded.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.handleData(chunk.toString()));
    this.socket.on("error", (error) => this.rejectPending(error));
    this.socket.on("close", () => this.rejectPending(new Error("SMTP connection closed unexpectedly")));
  }

  private async command(command: string, expectedCodes: number[]): Promise<SmtpResponse> {
    this.write(`${command}\r\n`);
    return this.expect(expectedCodes);
  }

  private expect(expectedCodes: number[]): Promise<SmtpResponse> {
    if (this.pending) {
      throw new Error("SMTP client cannot wait for multiple responses at once");
    }

    return new Promise<SmtpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`SMTP response timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);

      this.pending = {
        resolve: (response) => {
          if (!expectedCodes.includes(response.code)) {
            reject(new Error(`Unexpected SMTP response ${response.code}: ${response.lines.join(" | ")}`));
            return;
          }
          resolve(response);
        },
        reject,
        timer
      };

      this.flushResponses();
    });
  }

  private write(value: string): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("SMTP connection is not open");
    }
    this.socket.write(value);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    this.flushResponses();
  }

  private flushResponses(): void {
    if (!this.pending) {
      return;
    }
    const parsed = readSmtpResponse(this.buffer);
    if (!parsed) {
      return;
    }

    this.buffer = parsed.remaining;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(parsed.response);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

function openSocket(options: SmtpClientOptions): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SMTP connection timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const socket = options.secure
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port });

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readSmtpResponse(buffer: string): { response: SmtpResponse; remaining: string } | null {
  const lines = buffer.split(/\r?\n/);
  if (!buffer.endsWith("\n")) {
    lines.pop();
  }

  const responseLines: string[] = [];
  for (const line of lines) {
    if (!/^\d{3}[ -]/.test(line)) {
      return null;
    }
    responseLines.push(line);
    if (line[3] === " ") {
      const consumed = responseLines.join("\r\n").length + 2;
      return {
        response: {
          code: Number(line.slice(0, 3)),
          lines: responseLines.map((item) => item.slice(4))
        },
        remaining: buffer.slice(consumed)
      };
    }
  }

  return null;
}

function parseCapabilities(lines: string[]): Set<string> {
  const capabilities = new Set<string>();
  for (const line of lines.slice(1)) {
    const normalized = line.trim().toUpperCase();
    if (!normalized) {
      continue;
    }
    capabilities.add(normalized);
    const [name] = normalized.split(/\s+/, 1);
    if (name) {
      capabilities.add(name);
    }
  }
  return capabilities;
}

function buildMimeMessage(input: SendEmailInput & { from: string }): string {
  const boundary = `imagora-${randomUUID()}`;
  const text = input.text ?? stripHtml(input.html);
  const headers = [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: <${randomUUID()}@imagora.local>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeBody(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeBody(input.html),
    `--${boundary}--`,
    ""
  ];

  return [...headers, "", ...body].join("\r\n");
}

function parseRecipients(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^.*<([^>]+)>.*$/, "$1"))
    .filter((item) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item));
}

function formatMailbox(email: string, name: string): string {
  const safeName = sanitizeHeader(name).replaceAll('"', '\\"');
  return `"${safeName}" <${email}>`;
}

function encodeHeader(value: string): string {
  const sanitized = sanitizeHeader(value);
  return isAscii(sanitized) ? sanitized : `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function isAscii(value: string): boolean {
  return [...value].every((character) => character.charCodeAt(0) <= 127);
}

function normalizeBody(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

function dotStuff(value: string): string {
  return normalizeBody(value)
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
