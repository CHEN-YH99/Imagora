import { apiFetch } from "./client";
import type { GeneratedImage, Task } from "./types";

const defaultTaskPollIntervalMs = 2_000;
const defaultTaskWaitTimeoutMs = 5 * 60_000;

export const DEFAULT_IMAGE_MODEL_ID = "openai:gpt-image-2";
export const DEFAULT_MOCK_IMAGE_MODEL_ID = "mock:default";
export const IMAGE_MODEL_OPTIONS = [{ value: DEFAULT_IMAGE_MODEL_ID, label: "GPT Image 2" }] as const;

export function normalizeImageModel(modelName?: string | null): string {
  const normalized = modelName?.trim();
  if (!normalized) {
    return DEFAULT_IMAGE_MODEL_ID;
  }
  if (normalized === "gpt-image-2") {
    return DEFAULT_IMAGE_MODEL_ID;
  }
  if (normalized === "mock") {
    return DEFAULT_MOCK_IMAGE_MODEL_ID;
  }
  return normalized;
}

export function resolveSelectableImageModel(modelName?: string | null): string {
  const normalized = normalizeImageModel(modelName);
  return IMAGE_MODEL_OPTIONS.some((option) => option.value === normalized) ? normalized : DEFAULT_IMAGE_MODEL_ID;
}

export class TaskWaitTimeoutError extends Error {
  constructor(public readonly latestResult: { task: Task; images: GeneratedImage[] } | null) {
    super("生成任务仍在处理中，稍后可在历史记录中查看结果。");
    this.name = "TaskWaitTimeoutError";
  }
}

export async function waitForTask(
  taskId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<{ task: Task; images: GeneratedImage[] }> {
  const timeoutMs = options.timeoutMs ?? defaultTaskWaitTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? defaultTaskPollIntervalMs;
  const startedAt = Date.now();
  let latestResult: { task: Task; images: GeneratedImage[] } | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    const result = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`);
    latestResult = result;
    if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELED"].includes(result.task.status)) {
      return result;
    }
  }
  throw new TaskWaitTimeoutError(latestResult);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
