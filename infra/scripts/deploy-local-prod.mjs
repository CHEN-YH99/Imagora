import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const composeFile = "infra/docker-compose.prod.yml";
const envFile = process.env.DEPLOY_ENV_FILE ?? ".env.production";

const envFilePath = resolve(process.cwd(), envFile);
if (!existsSync(envFilePath)) {
  console.error(
    `[deploy] 缺少环境文件 ${envFile}。\n` +
      `  请先执行: cp .env.production.example ${envFile}\n` +
      `  并替换其中所有 replace-* 占位值后再部署。\n` +
      `  (如需指定其它文件，用 DEPLOY_ENV_FILE=path 覆盖。)`
  );
  process.exit(1);
}

// docker compose 默认只自动读取 cwd 下的 .env，不会读 .env.production。
// compose 文件里大量 ${VAR:?} 强制替换，不显式 --env-file 会直接中断。
const args = ["compose", "--env-file", envFile, "-f", composeFile, "up", "-d", "--build"];

const child = spawn("docker", args, {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
