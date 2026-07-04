#!/usr/bin/env node
// dev 启动前的清场脚本，一劳永逸解决 Windows 上的两类顽疾：
//   1. Prisma generate 撞文件锁后遗留的 query_engine-*.dll.node.tmp* 垃圾（每个 ~20MB）
//   2. 上一轮没退干净的僵尸进程霸占端口（3100 / 4100 等）
//
// 用法：node infra/scripts/dev-preflight.mjs [port...]
//   传入的每个端口，会找出正在 LISTENING 的进程并杀掉。
//   无论是否传端口，都会清理 Prisma 的 .tmp 残留。
//
// 跨平台：Windows 用 netstat + taskkill，POSIX 用 lsof + kill。

import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
const isWindows = process.platform === "win32";

function log(msg) {
  process.stdout.write(`[preflight] ${msg}\n`);
}

// —— 1. 清理 Prisma generate 残留的 .tmp 文件 ——
function cleanPrismaTmp() {
  const clientDir = join(repoRoot, "packages", "database", "generated", "client");
  let entries;
  try {
    entries = readdirSync(clientDir);
  } catch {
    return; // generated 目录还没生成，跳过
  }
  const stale = entries.filter((name) => name.includes(".tmp"));
  if (stale.length === 0) return;
  let cleaned = 0;
  for (const name of stale) {
    try {
      rmSync(join(clientDir, name), { force: true });
      cleaned += 1;
    } catch (err) {
      log(`无法删除残留 ${name}: ${err.message}`);
    }
  }
  if (cleaned > 0) log(`已清理 ${cleaned} 个 Prisma .tmp 残留`);
}

// —— 2. 释放被占用的端口 ——
function pidsOnPort(port) {
  const pids = new Set();
  try {
    if (isWindows) {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        // 只认 LISTENING，且本地地址以 :port 结尾（含 0.0.0.0:port / [::]:port / 127.0.0.1:port）
        if (!/\bLISTENING\b/.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const local = cols[1] ?? "";
        if (!local.endsWith(`:${port}`)) continue;
        const pid = cols[cols.length - 1];
        if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
    } else {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      for (const pid of out.split(/\s+/)) {
        if (/^\d+$/.test(pid)) pids.add(pid);
      }
    }
  } catch {
    // netstat/lsof 无输出或不存在时会抛错，视为端口空闲
  }
  return [...pids];
}

function killPid(pid) {
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
    } else {
      execFileSync("kill", ["-9", pid], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function freePort(port) {
  const pids = pidsOnPort(port);
  if (pids.length === 0) return;
  for (const pid of pids) {
    if (killPid(pid)) {
      log(`端口 ${port} 被 PID ${pid} 占用，已终止`);
    } else {
      log(`端口 ${port} 被 PID ${pid} 占用，但终止失败（可能已退出或权限不足）`);
    }
  }
}

// —— main ——
cleanPrismaTmp();
for (const arg of process.argv.slice(2)) {
  const port = Number(arg);
  if (Number.isInteger(port) && port > 0) freePort(port);
}
