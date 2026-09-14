import { apiFetch } from "./client";
import type { GeneratedImage, Task } from "./types";

const defaultTaskPollIntervalMs = 2_000;
const defaultTaskWaitTimeoutMs = 5 * 60_000;

export const DEFAULT_IMAGE_MODEL_ID = "openai:gpt-image-2";
export const DEFAULT_MOCK_IMAGE_MODEL_ID = "mock:default";

export interface ImageModelOption {
  id: string;
  label: string;
  qualities: string[];
  aspectRatios: string[];
  maxQuantity: number;
}

export interface ImageModelCatalog {
  models: ImageModelOption[];
  defaultModel: string | null;
}

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
  return normalizeImageModel(modelName);
}

export function validateImageModelSelection(
  model: ImageModelOption | undefined,
  input: { quality: string; aspectRatio: string; quantity: number }
): string | null {
  if (!model) return "所选模型未配置或已停用，请重新选择。";
  if (!model.qualities.includes(input.quality)) return "所选模型不支持当前画质，请重新选择。";
  if (!model.aspectRatios.includes(input.aspectRatio)) return "所选模型不支持当前画面比例，请重新选择。";
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > model.maxQuantity) {
    return `所选模型每次最多生成 ${model.maxQuantity} 张图片。`;
  }
  return null;
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
