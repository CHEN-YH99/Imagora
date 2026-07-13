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

export function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED" || status === "CANCELED";
}
