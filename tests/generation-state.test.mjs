import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const root = process.cwd();

test("generation view state helper resolves visible states and placeholder count", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import {
      hasTerminalGenerationFailure,
      isTerminalTaskStatus,
      resolveGenerationViewState,
      resolveProcessingPlaceholderCount
    } from "./apps/web/app/generate/generationState.ts";

    const baseTask = {
      id: "task_1",
      userId: "user_1",
      clientRequestId: "client_1",
      prompt: "测试提示词",
      negativePrompt: null,
      style: "realistic",
      aspectRatio: "1:1",
      width: 1024,
      height: 1024,
      quantity: 3,
      quality: "standard",
      modelProvider: "openai",
      modelName: "openai:gpt-image-2",
      status: "PENDING",
      creditCost: 30,
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    };
    const image = {
      id: "image_1",
      taskId: "task_1",
      userId: "user_1",
      thumbnailUrl: "/thumb.png",
      publicUrl: "/image.png",
      width: 1024,
      height: 1024,
      visibility: "PRIVATE",
      deletedAt: null,
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const state = (override) => resolveGenerationViewState({ loading: false, restoringTaskView: false, task: null, images: [], ...override });

    assert.equal(state({}), "idle");
    assert.equal(state({ restoringTaskView: true }), "restoring");
    assert.equal(state({ loading: true }), "submitting");
    assert.equal(state({ task: { ...baseTask, status: "PENDING" } }), "processing");
    assert.equal(state({ task: { ...baseTask, status: "RUNNING" } }), "processing");
    assert.equal(state({ task: { ...baseTask, status: "FAILED", failureMessage: "provider failed" } }), "failed");
    assert.equal(state({ task: { ...baseTask, status: "BLOCKED", failureMessage: "blocked" } }), "failed");
    assert.equal(state({ task: { ...baseTask, status: "SUCCEEDED" }, images: [image] }), "succeeded");
    assert.equal(hasTerminalGenerationFailure({ ...baseTask, status: "SUCCEEDED" }, []), false);
    assert.equal(hasTerminalGenerationFailure({ ...baseTask, status: "FAILED" }, []), true);
    assert.equal(isTerminalTaskStatus("CANCELED"), true);
    assert.equal(isTerminalTaskStatus("RUNNING"), false);
    assert.equal(resolveProcessingPlaceholderCount(null, 2), 2);
    assert.equal(resolveProcessingPlaceholderCount({ ...baseTask, quantity: 4 }, 1), 4);
  `;

  execFileSync("node", ["node_modules/tsx/dist/cli.mjs", "-e", script], {
    cwd: root,
    stdio: "pipe"
  });

  assert.ok(true);
});
