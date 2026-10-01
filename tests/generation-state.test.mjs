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
      resolveGenerationElapsedSeconds,
      resolveImageProgressStages,
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

    const progressAt = (status, progress, resultImages = []) =>
      resolveGenerationProgress({ ...baseTask, quantity: 4, status, progress }, resultImages, 4);
    assert.equal("percentage" in resolveGenerationProgress(null, [], 4), false);
    assert.equal(progressAt("PENDING", undefined).generatedImages, 0);
    assert.equal(progressAt("RUNNING", undefined).generatedImages, null);
    const liveProgress = { stage: "GENERATING", imageSteps: [2, 1, 0, 0], sequence: 3, generatedImages: 1, reviewedImages: 0, savedImages: 0, updatedAt: baseTask.updatedAt };
    const liveTask = { ...baseTask, status: "RUNNING", progress: liveProgress };
    const stagesAt = (progress, index = 0) => resolveImageProgressStages({ ...liveTask, progress }, index).map(stage => stage.state);
    assert.deepEqual(stagesAt(liveProgress), ["complete", "complete", "pending", "pending"]);
    assert.deepEqual(stagesAt(liveProgress, 1), ["active", "pending", "pending", "pending"]);
    assert.deepEqual(stagesAt(liveProgress, 2), ["pending", "pending", "pending", "pending"]);
    assert.deepEqual(stagesAt(undefined), ["unknown", "unknown", "unknown", "unknown"]);
    assert.deepEqual(stagesAt({ ...liveProgress, generatedImages: 0, imageSteps: [2] }), ["complete", "active", "pending", "pending"]);
    assert.equal(progressAt("RUNNING", liveProgress).generatedImages, 1);
    assert.equal(resolveImageProgressLabel({ ...baseTask, status: "RUNNING", progress: liveProgress }, 0), "已返回，待审核");
    assert.equal(resolveImageProgressLabel({ ...baseTask, status: "RUNNING", progress: liveProgress }, 1), "等待模型返回");
    assert.equal(resolveImageProgressLabel({ ...baseTask, status: "RUNNING", progress: liveProgress }, 2), "等待生成");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 600_000;
    assert.deepEqual(stagesAt(liveProgress, 1), ["active", "pending", "pending", "pending"]);
    Date.now = originalNow;
    assert.deepEqual(stagesAt({ ...liveProgress, imageSteps: [3] }), ["complete", "complete", "active", "pending"]);
    assert.deepEqual(stagesAt({ ...liveProgress, imageSteps: [4], reviewedImages: 1 }), ["complete", "complete", "complete", "active"]);
    assert.deepEqual(stagesAt({ ...liveProgress, imageSteps: [4], reviewedImages: 1, savedImages: 1 }), ["complete", "complete", "complete", "complete"]);
    assert.deepEqual(stagesAt({ ...liveProgress, imageSteps: undefined }), ["complete", "complete", "pending", "pending"]);
    assert.deepEqual(stagesAt({ ...liveProgress, imageSteps: [NaN], generatedImages: 0 }), ["unknown", "unknown", "unknown", "unknown"]);
    assert.deepEqual(resolveImageProgressStages({ ...liveTask, status: "FAILED" }, 0), []);
    assert.equal(progressAt("RUNNING", { ...liveProgress, imageSteps: [3], stage: "REVIEWING" }).label, "图片审核中");
    assert.equal(progressAt("FAILED", { ...liveProgress, savedImages: 1 }).savedImages, 0);
    assert.equal(progressAt("SUCCEEDED", undefined, [image]).label, "部分完成");
    assert.equal(progressAt("SUCCEEDED", { ...liveProgress, savedImages: 4 }, [image]).savedImages, 1);
    assert.equal(progressAt("RUNNING", { ...liveProgress, generatedImages: NaN }).generatedImages, null);
    assert.equal(progressAt("RUNNING", { ...liveProgress, generatedImages: 99 }).generatedImages, 4);
    assert.equal(resolveImageProgressLabel({ ...liveTask, progress: undefined }, 0), "等待进度同步");
    const start = Date.parse(baseTask.createdAt);
    assert.equal(resolveGenerationElapsedSeconds(null, start), null);
    assert.equal(resolveGenerationElapsedSeconds(baseTask, start + 31_900), 31);
    assert.equal(resolveGenerationElapsedSeconds({ ...liveTask, startedAt: baseTask.createdAt }, start + 61_900), 61);
    assert.equal(resolveGenerationElapsedSeconds({ ...liveTask, startedAt: baseTask.createdAt }, start - 1000), 0);
    assert.equal(resolveGenerationElapsedSeconds({ ...liveTask, startedAt: "invalid" }, start), null);
    assert.equal(resolveGenerationElapsedSeconds(liveTask, start), null);
    assert.equal(resolveGenerationElapsedSeconds({ ...liveTask, startedAt: baseTask.createdAt, status: "SUCCEEDED", completedAt: "2026-07-13T00:00:12.000Z" }, start + 90_000), 12);
    assert.equal(resolveGenerationElapsedSeconds({ ...liveTask, startedAt: baseTask.createdAt, status: "FAILED", completedAt: "2026-07-13T00:00:12.000Z" }, start + 90_000), 12);
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
