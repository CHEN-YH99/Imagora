import type { Store } from "@imagora/database";
import {
  advanceGenerationProgress,
  createGenerationProgress,
  type GenerationProgress,
  type GenerationTask
} from "@imagora/shared";

export type ReportGenerationProgress = (
  update: Partial<Pick<GenerationProgress, "stage" | "generatedImages" | "reviewedImages" | "savedImages">>,
  imageStep?: { index: number; step: number }
) => void;

/** 记录每个实际步骤，合并持久化；接收上游图片时不等待数据库。 */
export function createGenerationProgressReporter(
  store: Pick<Store, "updateGenerationProgress">,
  task: GenerationTask,
  onError: (error: unknown) => void,
  intervalMs = 1_000
) {
  let progress = structuredClone(task.progress ?? createGenerationProgress("GENERATING"));
  let pending: GenerationProgress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let lastWriteAt = 0;
  let closed = false;

  function schedule() {
    if (closed || timer || inFlight || !pending) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void persist();
      },
      Math.max(0, lastWriteAt + intervalMs - Date.now())
    );
  }

  function persist(): Promise<void> {
    if (inFlight) return inFlight;
    if (!pending) return Promise.resolve();
    const next = pending;
    pending = undefined;
    inFlight = Promise.resolve()
      .then(() =>
        store.updateGenerationProgress({
          taskId: task.id,
          startedAt: task.startedAt!,
          progress: next
        })
      )
      .catch(onError)
      .finally(() => {
        lastWriteAt = Date.now();
        inFlight = undefined;
        schedule();
      });
    return inFlight;
  }

  const report: ReportGenerationProgress = (update, imageStep) => {
    if (closed) return;
    const imageSteps = Array.from({ length: task.quantity }, (_, index) => progress.imageSteps?.[index] ?? 0);
    if (imageStep) imageSteps[imageStep.index] = Math.max(imageSteps[imageStep.index], imageStep.step);
    progress = advanceGenerationProgress(progress, { ...update, imageSteps });
    pending = progress;
    schedule();
  };

  return {
    report,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
      // 终态提交前确保最新计数和有界步骤记录已落库，且没有迟到写入。
      await persist();
    }
  };
}
