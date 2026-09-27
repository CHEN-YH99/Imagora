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

export function resolveGenerationProgress(
  task: Task | null,
  images: GeneratedImage[],
  quantity: number,
  index?: number
) {
  const totalImages = Math.max(1, task?.quantity ?? quantity);
  const progress = task?.progress;
  const stopped = Boolean(task && ["FAILED", "BLOCKED", "CANCELED"].includes(task.status));
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(totalImages, Math.trunc(value))) : null;
  const delivered = task?.status === "SUCCEEDED" ? images.length : null;
  const generatedImages = count(progress?.generatedImages) ?? delivered ?? (task?.status === "PENDING" ? 0 : null);
  const reviewedImages = count(progress?.reviewedImages) ?? delivered;
  const savedImages = stopped ? 0 : (count(progress?.savedImages) ?? delivered);
  const imageStep = (imageIndex: number): number | null => {
    if (!task) return null;
    if (task.status === "PENDING") return 0;
    if (task.status === "SUCCEEDED") return imageIndex < images.length ? 5 : 0;
    const reported = progress?.imageSteps?.[imageIndex];
    if (typeof reported === "number" && Number.isFinite(reported)) {
      return Math.max(0, Math.min(4, Math.trunc(reported)));
    }
    // 旧任务只根据已经持久化的事实恢复；没有记录的阶段不猜测。
    if (!progress) return null;
    if (imageIndex < progress.savedImages) return 4;
    if (imageIndex < progress.reviewedImages) return 3;
    if (imageIndex < progress.generatedImages) return 2;
    return null;
  };
  const steps = Array.from({ length: totalImages }, (_, imageIndex) => imageStep(imageIndex));
  const step =
    index === undefined
      ? steps.every((value) => value !== null)
        ? steps.reduce<number>((sum, value) => sum + (value ?? 0), 0) / totalImages
        : null
      : imageStep(index);
  const percentage = step === null ? null : Math.floor((step / 5) * 100);
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
    label = "模型生成中";
    detail =
      generatedImages === null
        ? "生成服务暂未上报详细进度，正在等待图片返回。"
        : `已接收 ${generatedImages} / ${totalImages} 张图片，按实际处理步骤更新。`;
    if (progress?.stage === "RECEIVING") {
      label = "接收图片中";
      detail = "模型请求已响应，正在接收图片数据。";
    }
    if (progress?.stage === "REVIEWING") {
      label = "图片审核中";
      detail = `已审核 ${reviewedImages ?? 0} / ${generatedImages ?? totalImages} 张图片，审核通过后开始保存。`;
    } else if (progress?.stage === "SAVING" || progress?.stage === "COMPLETED") {
      label = "保存图片中";
      detail = `已保存 ${savedImages ?? 0} / ${generatedImages ?? totalImages} 张图片，等待任务确认完成。`;
    }
  }
  return { label, detail, totalImages, generatedImages, reviewedImages, savedImages, percentage, step, totalSteps: 5 };
}

export function resolveImageProgressLabel(task: Task | null, index: number): string {
  if (!task) return "正在提交任务";
  if (task.status === "PENDING") return "排队等待";
  const progress = task.progress;
  if (!progress) return "等待模型返回";
  const step = progress.imageSteps?.[index];
  if (index < progress.savedImages) return "已保存，确认结果中";
  if (step === 4) return "保存图片中";
  if (step === 3 && index >= progress.reviewedImages) return "图片审核中";
  if (index < progress.reviewedImages) return "已审核，待保存";
  if (index < progress.generatedImages) return "已返回，待审核";
  if (step === 2) return "接收图片中";
  if (step === 1) return "请求模型中";
  return step === 0 ? "等待生成" : "等待进度同步";
}

export function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED" || status === "CANCELED";
}
