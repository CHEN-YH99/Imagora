import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

// 活跃生成任务指针：切换页面且 URL 丢失 taskId 时兜底恢复正在进行的任务。
// 这些是静态契约断言，与项目既有前端测试风格一致（web 无独立 dist，node --test 只能读源文件）。

test("generateDrafts exposes an active generation task pointer independent of URL", async () => {
  const draftsFile = await readFile(join(root, "apps/web/lib/generateDrafts.ts"), "utf8");

  assert.match(draftsFile, /ACTIVE_GENERATION_TASK_STORAGE_KEY/);
  assert.match(draftsFile, /export function saveActiveGenerationTaskId/);
  assert.match(draftsFile, /export function readActiveGenerationTaskId/);
  assert.match(draftsFile, /export function clearActiveGenerationTaskId/);
  // 指针必须持久化到 sessionStorage，而不是只存内存态。
  assert.match(draftsFile, /sessionStorage\.setItem\(ACTIVE_GENERATION_TASK_STORAGE_KEY/);
  assert.match(draftsFile, /sessionStorage\.getItem\(ACTIVE_GENERATION_TASK_STORAGE_KEY\)/);
  assert.match(draftsFile, /sessionStorage\.removeItem\(ACTIVE_GENERATION_TASK_STORAGE_KEY\)/);
});

test("generate page saves, restores and clears the active task pointer", async () => {
  const generatePage = await readFile(join(root, "apps/web/app/generate/page.tsx"), "utf8");

  // 引入三个指针函数。
  assert.match(generatePage, /saveActiveGenerationTaskId/);
  assert.match(generatePage, /readActiveGenerationTaskId/);
  assert.match(generatePage, /clearActiveGenerationTaskId/);
  // 提交成功后存指针。
  assert.match(generatePage, /saveActiveGenerationTaskId\(created\.task\.id\)/);
  // URL 无 taskId 时读指针兜底恢复。
  assert.match(generatePage, /readActiveGenerationTaskId\(\)/);
  // 终态清指针，避免下次反复恢复已完成任务。
  assert.match(generatePage, /clearActiveGenerationTaskId\(\)/);
});
