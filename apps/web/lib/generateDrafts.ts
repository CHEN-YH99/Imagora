import type { GeneratedImage, Task } from "./api";

export const GENERATION_DRAFT_STORAGE_KEY = "imagora:generation-draft";
export const GENERATION_TASK_SNAPSHOTS_STORAGE_KEY = "imagora:generation-task-snapshots";
export const ACTIVE_GENERATION_TASK_STORAGE_KEY = "imagora:active-generation-task";

export type GenerationDraft = {
  prompt: string;
  negativePrompt?: string;
  style?: string;
  aspectRatio?: string;
  quality?: string;
  quantity?: number;
  model?: string;
  mode?: "reuse" | "variation";
};

export type GenerationTaskSnapshot = {
  task: Task;
  images: GeneratedImage[];
  savedAt: string;
};

export type GeneratePathParams = {
  style?: string;
  aspectRatio: string;
  quality: string;
  quantity: number | string;
  model: string;
};

export function buildGeneratePath(params: GeneratePathParams): string {
  const searchParams = new URLSearchParams({
    aspectRatio: params.aspectRatio,
    quality: params.quality,
    quantity: String(params.quantity),
    model: params.model
  });
  if (params.style) {
    searchParams.set("style", params.style);
  }
  return `/generate?${searchParams.toString()}`;
}

export function buildGenerateTaskPath(taskId: string): string {
  const searchParams = new URLSearchParams({ taskId });
  return `/generate?${searchParams.toString()}`;
}

export function saveGenerationDraft(input: string | GenerationDraft): void {
  const draft = typeof input === "string" ? { prompt: input } : input;
  const normalizedPrompt = draft.prompt.trim();
  if (!normalizedPrompt || typeof window === "undefined") {
    return;
  }
  sessionStorage.setItem(
    GENERATION_DRAFT_STORAGE_KEY,
    JSON.stringify({
      ...draft,
      prompt: normalizedPrompt,
      negativePrompt: draft.negativePrompt?.trim()
    })
  );
}

export function consumeGenerationDraft(): GenerationDraft | null {
  if (typeof window === "undefined") {
    return null;
  }
  const rawDraft = sessionStorage.getItem(GENERATION_DRAFT_STORAGE_KEY);
  sessionStorage.removeItem(GENERATION_DRAFT_STORAGE_KEY);
  if (!rawDraft) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawDraft) as Partial<GenerationDraft>;
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
      return null;
    }
    return {
      ...parsed,
      prompt: parsed.prompt.trim(),
      negativePrompt: parsed.negativePrompt?.trim()
    };
  } catch {
    return null;
  }
}

export function saveGenerationTaskSnapshot(task: Task, images: GeneratedImage[]): void {
  if (typeof window === "undefined") {
    return;
  }
  const snapshots = readGenerationTaskSnapshots();
  snapshots[task.id] = {
    task,
    images,
    savedAt: new Date().toISOString()
  };
  const trimmedSnapshots = Object.fromEntries(
    Object.entries(snapshots)
      .sort(([, left], [, right]) => Date.parse(right.savedAt) - Date.parse(left.savedAt))
      .slice(0, 12)
  );
  sessionStorage.setItem(GENERATION_TASK_SNAPSHOTS_STORAGE_KEY, JSON.stringify(trimmedSnapshots));
}

export function readGenerationTaskSnapshot(taskId: string): GenerationTaskSnapshot | null {
  if (!taskId || typeof window === "undefined") {
    return null;
  }
  const snapshots = readGenerationTaskSnapshots();
  return snapshots[taskId] ?? null;
}

function readGenerationTaskSnapshots(): Record<string, GenerationTaskSnapshot> {
  const rawSnapshots = sessionStorage.getItem(GENERATION_TASK_SNAPSHOTS_STORAGE_KEY);
  if (!rawSnapshots) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawSnapshots) as Record<string, GenerationTaskSnapshot>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 活跃生成任务指针：独立于 URL 持久化"当前正在跑的任务 id"。
 * 用于在用户切走再回到生成页、且 URL 丢失 taskId 时兜底恢复正在进行的任务。
 */
export function saveActiveGenerationTaskId(taskId: string): void {
  if (!taskId || typeof window === "undefined") {
    return;
  }
  sessionStorage.setItem(ACTIVE_GENERATION_TASK_STORAGE_KEY, taskId);
}

export function readActiveGenerationTaskId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = sessionStorage.getItem(ACTIVE_GENERATION_TASK_STORAGE_KEY);
  return value && value.trim() ? value : null;
}

export function clearActiveGenerationTaskId(): void {
  if (typeof window === "undefined") {
    return;
  }
  sessionStorage.removeItem(ACTIVE_GENERATION_TASK_STORAGE_KEY);
}
