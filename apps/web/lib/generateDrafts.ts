import type { GeneratedImage, Task } from "./api";

export const GENERATION_DRAFT_STORAGE_KEY = "imagora:generation-draft";
export const GENERATION_TASK_SNAPSHOTS_STORAGE_KEY = "imagora:generation-task-snapshots";

export type GenerationDraft = {
  prompt: string;
};

export type GenerationTaskSnapshot = {
  task: Task;
  images: GeneratedImage[];
  savedAt: string;
};

export type GeneratePathParams = {
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
  return `/generate?${searchParams.toString()}`;
}

export function buildGenerateTaskPath(taskId: string): string {
  const searchParams = new URLSearchParams({ taskId });
  return `/generate?${searchParams.toString()}`;
}

export function saveGenerationDraft(prompt: string): void {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || typeof window === "undefined") {
    return;
  }
  sessionStorage.setItem(GENERATION_DRAFT_STORAGE_KEY, JSON.stringify({ prompt: normalizedPrompt }));
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
    return typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt.trim() } : null;
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
