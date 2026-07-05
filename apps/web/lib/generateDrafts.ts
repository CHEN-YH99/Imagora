export const GENERATION_DRAFT_STORAGE_KEY = "imagora:generation-draft";

export type GenerationDraft = {
  prompt: string;
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
