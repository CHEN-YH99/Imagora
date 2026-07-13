import { readFileSync } from "node:fs";
import { buildVerificationEmail, createMailer } from "./packages/mailer/dist/index.js";

// 手动加载 .env（不引外部依赖）
for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const to = process.argv[2] ?? process.env.SMTP_FROM;
console.log(`[probe] provider=${process.env.MAILER_PROVIDER} host=${process.env.SMTP_HOST} to=${to}`);

const mailer = createMailer();
const verifyUrl = `${process.env.WEB_ORIGIN ?? "http://127.0.0.1:3100"}/verify-email?token=probe-${Date.now()}`;
try {
  await mailer.sendEmail(buildVerificationEmail({ to, nickname: "测试用户", verifyUrl }));
  console.log("[probe] OK 邮件已投递，SMTP 全程无报错");
  console.log(`[probe] verifyUrl = ${verifyUrl}`);
} catch (error) {
  console.error("[probe] FAIL", error?.message ?? error);
  process.exitCode = 1;
}
