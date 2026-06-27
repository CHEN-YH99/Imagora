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

  constructor() {
    this.host = this.requiredEnv("SMTP_HOST");
    this.port = Number(process.env.SMTP_PORT ?? "587");
    this.user = this.requiredEnv("SMTP_USER");
    this.password = this.requiredEnv("SMTP_PASSWORD");
    this.from = this.requiredEnv("SMTP_FROM");
  }

  async sendEmail(_input: SendEmailInput): Promise<void> {
    // TODO: 实现 SMTP 邮件发送
    // 可以使用 nodemailer 或其他 SMTP 客户端库
    throw new Error(
      "SmtpMailer not implemented yet. Install nodemailer and implement SMTP transport:\n" +
        "  npm install nodemailer @types/nodemailer\n" +
        `  Host: ${this.host}, Port: ${this.port}, From: ${this.from}`
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
