#!/usr/bin/env node
// worker 保活 supervisor —— 一劳永逸解决"常驻 worker 被外部当成一次性任务回收后没人管"的问题。
//
// 背景：inline 队列模式下，API 只把生成任务写进库变成 PENDING，真正出图 100% 依赖 worker
// 进程每 2.5s 轮询领取。一旦 worker 挂掉且无人重启，后续所有生成都会卡在 PENDING，
// 5 分钟后被判 QUEUE_TIMEOUT 退款——用户视角就是"点了生成，转半天圈，然后失败"。
//
// 本脚本作为一个**常驻父进程**持有 worker：
//   - worker 退出（无论正常/崩溃/被信号杀）→ 记录退出码 → 退避后自动重拉
//   - 每次拉起写日志到 .local-dev-logs/worker.log，心跳写 .local-dev-logs/worker-supervisor.status.json
//   - 收到 SIGINT/SIGTERM 时优雅停掉 worker 再退出，不留僵尸
//
// 用法（推荐 detached 甩出去常驻，脱离任何会外框架）：
//   Start-Process node -ArgumentList 'infra/scripts/worker-supervisor.mjs' -WindowStyle Hidden
// 前台调试：
//   node infra/scripts/worker-supervisor.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
const workerDir = join(repoRoot, "apps", "worker");
const logDir = join(repoRoot, ".local-dev-logs");
const logFile = join(logDir, "worker.log");
const statusFile = join(logDir, "worker-supervisor.status.json");
const envFile = join(repoRoot, ".env");

// 退避策略：连续崩溃时逐步拉长间隔，避免瞬时崩溃打成 busy-loop 打满 CPU。
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// worker 稳定存活超过这个时长，视为"健康启动"，重置退避계数。
const HEALTHY_UPTIME_MS = 60_000;

let stopping = false;
let child = null;
let restartCount = 0;
let consecutiveFailures = 0;

mkdirSync(logDir, { recursive: true });

function supervisorLog(message) {
  const line = `[${new Date().toISOString()}] [supervisor] ${message}\n`;
  process.stdout.write(line);
  try {
    // 追加到 worker.log，和 worker 自身输出共处一个文件，排障时时间线连贯
    writeFileSync(logFile, line, { flag: "a" });
  } catch {
    // 日志写失败不应影响保活主逻辑
  }
}

function writeStatus(extra) {
  try {
    writeFileSync(
      statusFile,
      JSON.stringify(
        {
          supervisorPid: process.pid,
          workerPid: child?.pid ?? null,
          restartCount,
          consecutiveFailures,
          updatedAt: new Date().toISOString(),
          ...extra
        },
        null,
        2
      )
    );
  } catch {
    // 状态文件写失败可忽略
  }
}

function backoffMs() {
  if (consecutiveFailures <= 0) return 0;
  const ms = MIN_BACKOFF_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

function startWorker() {
  if (stopping) return;

  if (!existsSync(join(workerDir, "dist", "main.js"))) {
    supervisorLog(
      "apps/worker/dist/main.js 不存在，请先构建：npm run build:packages && npm --workspace apps/worker run build。10s 后重试。"
    );
    consecutiveFailures += 1;
    writeStatus({ state: "waiting-build" });
    setTimeout(startWorker, 10_000);
    return;
  }

  // 日志句柄：worker 的 stdout/stderr 直接落盘（追加），和 supervisorLog 同一文件
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const startedAt = Date.now();
  restartCount += 1;
  supervisorLog(`拉起 worker（第 ${restartCount} 次），cwd=${workerDir}`);

  child = spawn(process.execPath, [`--env-file=${envFile}`, join("dist", "main.js")], {
    cwd: workerDir,
    stdio: ["ignore", out, err],
    env: process.env,
    windowsHide: true
  });

  writeStatus({ state: "running", startedAt: new Date(startedAt).toISOString() });

  child.on("exit", (code, signal) => {
    child = null;
    const uptime = Date.now() - startedAt;
    supervisorLog(`worker 退出：code=${code} signal=${signal ?? "none"} 存活=${Math.round(uptime / 1000)}s`);

    if (stopping) {
      writeStatus({ state: "stopped" });
      return;
    }

    // 存活够久算健康，重置退避；否则视为崩溃循环，累加退避계数
    if (uptime >= HEALTHY_UPTIME_MS) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
    }

    const wait = backoffMs();
    supervisorLog(`${Math.round(wait / 1000)}s 后重拉（连续短命次数=${consecutiveFailures}）`);
    writeStatus({ state: "restarting", nextRestartInMs: wait });
    setTimeout(startWorker, wait);
  });

  child.on("error", (error) => {
    supervisorLog(`spawn worker 失败：${error.message}`);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  supervisorLog(`收到 ${signal}，正在停止 worker 并退出 supervisor`);
  writeStatus({ state: "stopping" });
  if (child) {
    child.kill();
    // 给 worker 一点优雅退出时间，之后强杀
    setTimeout(() => {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
      process.exit(0);
    }, 3_000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

supervisorLog(`supervisor 启动，pid=${process.pid}`);
writeStatus({ state: "starting" });
startWorker();
