import type { GeneratedImage, Task } from "../../lib/api";

export type GenerationViewState = "idle" | "submitting" | "processing" | "restoring" | "succeeded" | "failed";

export function resolveGenerationViewState(input: {
  loading: boolean;
  restoringTaskView: boolean;
  task: Task | null;
  images: GeneratedImage[];
}): GenerationViewState {
  if (input.restoringTaskView) {
    return "restoring";
  }
  if (input.images.length === 0 && input.loading && !input.task) {
    return "submitting";
  }
  if (
    input.images.length === 0 &&
    (input.loading || input.task?.status === "PENDING" || input.task?.status === "RUNNING")
  ) {
    return "processing";
  }
  if (hasTerminalGenerationFailure(input.task, input.images)) {
    return "failed";
  }
  if (input.task?.status === "SUCCEEDED" && input.images.length > 0) {
    return "succeeded";
  }
  return "idle";
}

export function resolveProcessingPlaceholderCount(task: Task | null, quantity: number): number {
  return Math.max(1, task?.quantity ?? quantity);
}

export function hasTerminalGenerationFailure(task: Task | null, images: GeneratedImage[]): boolean {
  if (!task) {
    return false;
  }
  return (
    images.length === 0 &&
    (task.status === "FAILED" ||
      task.status === "BLOCKED" ||
      task.status === "CANCELED" ||
      Boolean(task.failureMessage))
  );
}

export function resolveGenerationProgress(task: Task | null, images: GeneratedImage[], quantity: number) {
  const totalImages = Math.max(1, task?.quantity ?? quantity);
  const progress = task?.progress;
  const stopped = Boolean(task && ["FAILED", "BLOCKED", "CANCELED"].includes(task.status));
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(totalImages, Math.trunc(value))) : null;
  const delivered = task?.status === "SUCCEEDED" ? count(images.length) : null;
  const generatedImages = delivered ?? count(progress?.generatedImages) ?? (task?.status === "PENDING" ? 0 : null);
  const reviewedImages = delivered ?? count(progress?.reviewedImages);
  const savedImages = stopped ? 0 : (delivered ?? count(progress?.savedImages));
  let label = "正在提交";
  let detail = "等待服务器确认生成任务。";
  if (task?.status === "PENDING") {
    label = "排队中";
    detail = "任务已创建，等待生成服务开始处理。";
  } else if (stopped) {
    label = task?.status === "CANCELED" ? "已取消" : task?.status === "BLOCKED" ? "生成被拦截" : "生成失败";
    detail = "任务已停止，已返回的图片数量不代表最终交付数量。";
  } else if (task?.status === "SUCCEEDED") {
    label = images.length < totalImages ? "部分完成" : "生成完成";
    detail = `已交付 ${images.length} / ${totalImages} 张图片。`;
  } else if (task?.status === "RUNNING") {
    label = "等待模型返回";
    detail =
      generatedImages === null ? "生成服务暂未上报详细进度，正在等待图片返回。" : "请求已发出，等待模型返回图片数据。";
    if (progress?.stage === "RECEIVING") {
      label = "接收图片中";
      detail = "模型请求已响应，正在接收图片数据。";
    }
    if (progress?.stage === "REVIEWING") {
      label = "图片审核中";
      detail =
        reviewedImages === null
          ? "等待审核结果同步。"
          : `已审核 ${reviewedImages} / ${totalImages} 张图片，审核通过后开始保存。`;
    } else if (progress?.stage === "SAVING" || progress?.stage === "COMPLETED") {
      label = "保存图片中";
      detail =
        savedImages === null
          ? "等待保存结果同步。"
          : `已保存 ${savedImages} / ${totalImages} 张图片，等待任务确认完成。`;
    }
  }
  return { label, detail, totalImages, generatedImages, reviewedImages, savedImages };
}

export type ImageProgressStageState = "pending" | "active" | "complete" | "unknown";

export function resolveImageProgressStages(task: Task | null, index: number) {
  if (task && isTerminalTaskStatus(task.status)) return [];
  const progress = task?.progress;
  const reported = progress?.imageSteps?.[index];
  const step =
    typeof reported === "number" && Number.isInteger(reported) && reported >= 0 && reported <= 4 ? reported : null;
  const received = index < (progress?.generatedImages ?? 0);
  const reviewed = index < (progress?.reviewedImages ?? 0);
  const saved = index < (progress?.savedImages ?? 0);
  const known = !task || task.status === "PENDING" || step !== null || received || reviewed || saved;
  const complete = [received || (step ?? 0) >= 2, received, reviewed, saved];
  return ["生成", "接收", "审核", "保存"].map((label, stageIndex) => {
    const ordinal = stageIndex + 1;
    // 阶段表示已观察到的事件，不代表模型内部完成比例；旧任务不推断缺失状态。
    const state: ImageProgressStageState = !known
      ? "unknown"
      : complete[stageIndex] || (step ?? 0) > ordinal || complete.slice(stageIndex + 1).some(Boolean)
        ? "complete"
        : step === ordinal
          ? "active"
          : "pending";
    return { label, state };
  });
}

export function resolveGenerationElapsedSeconds(task: Task | null, now: number): number | null {
  if (!task) return null;
  const start = Date.parse((task.status === "PENDING" ? task.createdAt : task.startedAt) ?? "");
  const end = isTerminalTaskStatus(task.status) ? Date.parse(task.completedAt ?? "") : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export function resolveImageProgressLabel(task: Task | null, index: number): string {
  if (!task) return "正在提交任务";
  if (task.status === "PENDING") return "排队等待";
  const progress = task.progress;
  if (!progress) return "等待进度同步";
  const step = progress.imageSteps?.[index];
  if (index < progress.savedImages) return "已保存，确认结果中";
  if (step === 4) return "保存图片中";
  if (step === 3 && index >= progress.reviewedImages) return "图片审核中";
  if (index < progress.reviewedImages) return "已审核，待保存";
  if (index < progress.generatedImages) return "已返回，待审核";
  if (step === 2) return "接收图片中";
  if (step === 1) return "等待模型返回";
  return step === 0 ? "等待生成" : "等待进度同步";
}

export function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED" || status === "CANCELED";
}
