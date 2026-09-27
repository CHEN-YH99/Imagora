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
      resolveGenerationProgress,
      resolveImageProgressLabel,
      resolveProcessingPlaceholderCount
    } from "./apps/web/app/generate/generationState.ts";
    import {
      createGenerationWorkspaceState,
      generationWorkspaceReducer
    } from "./apps/web/app/generate/hooks/useGenerationWorkspace.ts";

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

    const workspaceInitial = {
      prompt: "测试提示词",
      aspectRatio: "1:1",
      quantity: 2,
      model: "openai:gpt-image-2",
      activeGenerationTaskId: "task_previous",
      restoringTaskView: true
    };
    const workspaceState = {
      ...createGenerationWorkspaceState(workspaceInitial),
      task: baseTask,
      images: [image],
      selectedPreviewImage: image,
      message: "旧任务结果",
      appealEventId: "event_1",
      showAppealForm: true,
      appealReason: "需要复核",
      appealLoading: true
    };
    const submittingState = generationWorkspaceReducer(workspaceState, { type: "begin-submission" });
    assert.equal(submittingState.loading, true);
    assert.equal(submittingState.activeGenerationTaskId, null);
    assert.equal(submittingState.task, null);
    assert.deepEqual(submittingState.images, []);
    assert.equal(submittingState.selectedPreviewImage, null);
    assert.equal(submittingState.restoringTaskView, false);
    assert.equal(submittingState.appealEventId, null);

    const restoringState = generationWorkspaceReducer(workspaceState, {
      type: "begin-restore",
      preserveVisibleState: false
    });
    assert.equal(restoringState.loading, true);
    assert.equal(restoringState.messageTone, "info");
    assert.equal(restoringState.task, null);
    assert.deepEqual(restoringState.images, []);
    assert.equal(restoringState.selectedPreviewImage, null);

    const preservedRestoreState = generationWorkspaceReducer(workspaceState, {
      type: "begin-restore",
      preserveVisibleState: true
    });
    assert.equal(preservedRestoreState.task?.id, "task_1");
    assert.equal(preservedRestoreState.images.length, 1);

    const appliedTaskState = generationWorkspaceReducer(createGenerationWorkspaceState(workspaceInitial), {
      type: "apply-task-result",
      result: { task: baseTask, images: [image] }
    });
    assert.equal(appliedTaskState.task?.id, "task_1");
    assert.equal(appliedTaskState.images[0]?.id, "image_1");

    const progressAt = (status, progress, resultImages = [], index = 0) =>
      resolveGenerationProgress({ ...baseTask, quantity: 4, status, progress }, resultImages, 4, index);
    assert.equal(resolveGenerationProgress(null, [], 4).percentage, null);
    assert.equal(progressAt("PENDING", undefined).percentage, 0);
    assert.equal(progressAt("RUNNING", undefined).percentage, null);
    const liveProgress = { stage: "GENERATING", imageSteps: [2, 1, 0, 0], sequence: 3, generatedImages: 1, reviewedImages: 0, savedImages: 0, updatedAt: baseTask.updatedAt };
    assert.equal(progressAt("RUNNING", liveProgress).percentage, 40);
    assert.equal(progressAt("RUNNING", liveProgress, [], 1).percentage, 20);
    assert.equal(progressAt("RUNNING", liveProgress, [], 2).percentage, 0);
    assert.equal(progressAt("RUNNING", liveProgress).generatedImages, 1);
    assert.equal(resolveImageProgressLabel({ ...baseTask, status: "RUNNING", progress: liveProgress }, 0), "已返回，待审核");
    assert.equal(resolveImageProgressLabel({ ...baseTask, status: "RUNNING", progress: liveProgress }, 1), "请求模型中");
    assert.equal(resolveImageProgressLabel({ ...baseTask, status: "RUNNING", progress: liveProgress }, 2), "等待生成");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 600_000;
    assert.equal(progressAt("RUNNING", liveProgress).percentage, 40);
    Date.now = originalNow;
    for (const [step, percentage] of [[0, 0], [1, 20], [2, 40], [3, 60], [4, 80]]) {
      assert.equal(progressAt("RUNNING", { ...liveProgress, imageSteps: [step] }).percentage, percentage);
    }
    assert.equal(progressAt("RUNNING", { ...liveProgress, imageSteps: [5] }).percentage, 80);
    assert.equal(progressAt("RUNNING", { ...liveProgress, imageSteps: [3], stage: "REVIEWING" }).label, "图片审核中");
    assert.equal(progressAt("FAILED", { ...liveProgress, savedImages: 1 }).percentage, 40);
    assert.equal(progressAt("FAILED", { ...liveProgress, savedImages: 1 }).savedImages, 0);
    assert.equal(progressAt("SUCCEEDED", undefined, [image]).percentage, 100);
    assert.equal(progressAt("SUCCEEDED", undefined, [image], 1).percentage, 0);
    assert.equal(progressAt("SUCCEEDED", undefined, [image]).label, "部分完成");
    const newerTask = { ...baseTask, progress: { ...liveProgress, generatedImages: 2 }, updatedAt: "2026-09-24T12:00:02.000Z" };
    const newerState = { ...workspaceState, task: newerTask };
    const staleUpdate = generationWorkspaceReducer(newerState, {
      type: "apply-task-result",
      result: { task: { ...baseTask, progress: liveProgress, updatedAt: "2026-09-24T12:00:01.000Z" }, images: [] }
    });
    assert.equal(staleUpdate, newerState);
    const sameTimestampUpdate = generationWorkspaceReducer(newerState, {
      type: "apply-task-result",
      result: { task: { ...newerTask, progress: { ...liveProgress, sequence: 2 } }, images: [] }
    });
    assert.equal(sameTimestampUpdate, newerState);

  `;

  execFileSync("node", ["node_modules/tsx/dist/cli.mjs", "-e", script], {
    cwd: root,
    stdio: "pipe"
  });

  assert.ok(true);
});
