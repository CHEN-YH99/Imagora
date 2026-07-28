#!/usr/bin/env node
// 校验 IMAGE_CHANNELS 配置并探活各渠道，不消耗生图额度。
// 用法：node --env-file=.env infra/scripts/check-image-channels.mjs
//   --probe  额外向每个渠道发一次 /models 请求验证 key 与连通性

import { resolveAllImageChannels, resolveImageChannels } from "../../packages/ai-providers/dist/index.js";

const probe = process.argv.includes("--probe");
const timeoutMs = Number(process.env.IMAGE_CHANNEL_PROBE_TIMEOUT_MS ?? 15000);

let all;
try {
  all = resolveAllImageChannels();
} catch (error) {
  console.error(`[channels] 配置无效: ${error.message}`);
  process.exit(1);
}

const active = resolveImageChannels();
if (!active.length) {
  console.error("[channels] 没有任何启用的渠道：检查 IMAGE_CHANNELS 或 OPENAI_API_KEY");
  process.exit(1);
}

const source = process.env.IMAGE_CHANNELS?.trim() ? "IMAGE_CHANNELS" : "OPENAI_API_KEY (legacy single channel)";
console.log(`[channels] 配置来源: ${source}`);
console.log(`[channels] 共 ${all.length} 个，启用 ${active.length} 个，按实际尝试顺序：`);
for (const [index, channel] of active.entries()) {
  const model = channel.upstreamModel ? ` upstreamModel=${channel.upstreamModel}` : "";
  const cost = channel.costCentsPerImage === undefined ? "" : ` cost=${channel.costCentsPerImage}分/张`;
  console.log(
    `  ${index + 1}. ${channel.name}  priority=${channel.priority}  ${channel.baseUrl}  key=${maskKey(channel.apiKey)}${model}${cost}`
  );
}

const disabled = all.filter((channel) => !channel.enabled);
if (disabled.length) {
  console.log(`[channels] 已禁用: ${disabled.map((channel) => channel.name).join(", ")}`);
}

if (!probe) {
  console.log("\n[channels] 配置解析通过。加 --probe 可实际探活各渠道（不生图）。");
  process.exit(0);
}

console.log(`\n[channels] 探活中（GET /models，超时 ${timeoutMs}ms）...`);
let failures = 0;
for (const channel of active) {
  const started = Date.now();
  try {
    const response = await fetch(`${channel.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${channel.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const elapsed = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      failures += 1;
      console.log(`  ✗ ${channel.name}  ${response.status} 鉴权失败 — key 或余额有问题  (${elapsed}ms)`);
      continue;
    }
    if (!response.ok) {
      // /models 未必被中转站支持，非鉴权错误不代表生图不可用
      console.log(`  ? ${channel.name}  ${response.status} — 该站可能不支持 /models，鉴权未被拒  (${elapsed}ms)`);
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter(Boolean) : [];
    const wanted = channel.upstreamModel ?? "gpt-image-2";
    const hasWanted = models.includes(wanted);
    const hint = models.length ? (hasWanted ? `含 ${wanted}` : `未列出 ${wanted}（不一定不可用）`) : "未返回模型列表";
    console.log(`  ✓ ${channel.name}  可达，${models.length} 个模型，${hint}  (${elapsed}ms)`);
  } catch (error) {
    failures += 1;
    const elapsed = Date.now() - started;
    const reason = error?.name === "TimeoutError" ? `超时 >${timeoutMs}ms` : (error?.message ?? String(error));
    console.log(`  ✗ ${channel.name}  连接失败: ${reason}  (${elapsed}ms)`);
  }
}

if (failures === active.length) {
  console.error(`\n[channels] 所有 ${active.length} 个渠道都不可达，生图必然失败。`);
  process.exit(1);
}
if (failures > 0) {
  console.log(`\n[channels] ${failures}/${active.length} 个渠道有问题，剩余渠道仍可承接生图。`);
  process.exit(0);
}
console.log(`\n[channels] 全部 ${active.length} 个渠道可达。`);

function maskKey(value) {
  return value.length <= 10 ? "***" : `${value.slice(0, 6)}***${value.slice(-4)}`;
}
