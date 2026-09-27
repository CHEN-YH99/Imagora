"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { aspectRatioOptions } from "@imagora/shared/image-models";
import { ImageModelSelect } from "../../components/ImageModelSelect";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Coins, Copy, Download, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { AppFrame, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { GeneratedImageLightbox, GeneratedImagePreviewButton } from "../../components/GeneratedImagePreview";
import {
  ApiRequestError,
  apiFetch,
  formatCredits,
  getSafetyAppeals,
  downloadGeneratedImage,
  resolveSelectableImageModel,
  validateImageModelSelection,
  submitSafetyAppeal,
  subscribeGenerationTask,
  type CreditAccount,
  type GeneratedImage,
  type GenerationMetadata,
  type SafetyEvent,
  type Task
} from "../../lib/api";
import {
  buildGeneratePath,
  buildGenerateTaskPath,
  clearActiveGenerationTaskId,
  consumeGenerationDraft,
  readActiveGenerationTaskId,
  readGenerationTaskSnapshot,
  saveActiveGenerationTaskId,
  saveGenerationDraft,
  saveGenerationTaskSnapshot
} from "../../lib/generateDrafts";
import {
  hasTerminalGenerationFailure,
  isTerminalTaskStatus,
  resolveGenerationViewState,
  resolveGenerationProgress,
  resolveImageProgressLabel,
  resolveProcessingPlaceholderCount
} from "./generationState";
import { useGenerationWorkspace } from "./hooks/useGenerationWorkspace";
import { useImageModelCatalog } from "./hooks/useImageModelCatalog";
import { maxEnhancedPromptLength, validateGenerationPromptLengths } from "./promptPresets";

const DEFAULT_PROMPT = "半透明智能相机的电影感产品摄影，薄荷色轮廓光，黑色台面，高细节";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_QUANTITY = 2;
const taskSyncPollIntervalMs = 2_000;
const progressTransitionMs = 250;

export default function GeneratePage() {
  return (
    <Suspense
      fallback={
        <AppFrame title="图片生成" subtitle="正在加载生成工作台...">
          <Panel>正在加载...</Panel>
        </AppFrame>
      }
    >
      <GenerateExperience />
    </Suspense>
  );
}

function GenerateExperience() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTaskId = searchParams.get("taskId");
  const initialQuantity = resolveInitialQuantity(searchParams.get("quantity"));
  const {
    prompt,
    setPrompt,
    aspectRatio,
    setAspectRatio,
    quantity,
    setQuantity,
    quantityInput,
    setQuantityInput,
    model: requestedModel,
    setModel,
    quote,
    setQuote,
    account,
    setAccount,
    task,
    setTask,
    images,
    selectedPreviewImage,
    setSelectedPreviewImage,
    message,
    setMessage,
    messageTone,
    setMessageTone,
    loading,
    setLoading,
    activeGenerationTaskId,
    setActiveGenerationTaskId,
    appealEventId,
    setAppealEventId,
    showAppealForm,
    setShowAppealForm,
    appealReason,
    setAppealReason,
    appealStatus,
    setAppealStatus,
    appealLoading,
    setAppealLoading,
    restoringTaskView,
    setRestoringTaskView,
    applyTaskResult: applyWorkspaceTaskResult,
    beginRestore,
    beginSubmission
  } = useGenerationWorkspace({
    prompt: DEFAULT_PROMPT,
    aspectRatio: resolveInitialAspectRatio(searchParams.get("aspectRatio")),
    quantity: initialQuantity,
    model: resolveInitialModel(searchParams.get("model")),
    activeGenerationTaskId: initialTaskId,
    restoringTaskView: Boolean(initialTaskId)
  });
  const {
    catalog: modelCatalog,
    loading: modelsLoading,
    error: modelsError,
    selectedChannel,
    selectChannel,
    preferredModel,
    rememberModel,
    refresh: refreshModels
  } = useImageModelCatalog(searchParams.get("channel"));
  const model = requestedModel || preferredModel || modelCatalog.defaultModel || modelCatalog.models[0]?.id || "";
  const selectedModel = modelCatalog.models.find((option) => option.id === model);
  const quality = selectedModel?.qualities.includes("standard")
    ? "standard"
    : (selectedModel?.qualities[0] ?? "standard");
  const modelSelectionError = modelsLoading
    ? "正在加载可用模型，请稍候。"
    : ((!modelCatalog.models.length ? modelsError : null) ??
      (modelCatalog.models.length
        ? validateImageModelSelection(selectedModel, { quality, aspectRatio, quantity })
        : "暂无可用的生图模型，请联系管理员配置模型及通道。"));
  useEffect(() => {
    if (!selectedModel || modelsLoading) return;
    if (selectedModel.aspectRatios.length && !selectedModel.aspectRatios.includes(aspectRatio)) {
      setAspectRatio(selectedModel.aspectRatios[0]);
    }
    if (quantity > selectedModel.maxQuantity) {
      setQuantity(selectedModel.maxQuantity);
      setQuantityInput(String(selectedModel.maxQuantity));
    }
  }, [selectedModel, modelsLoading, aspectRatio, quantity]);
  const browserStorageRestoredRef = useRef(false);
  const quoteRequestSequenceRef = useRef(0);
  const restoringTaskIdRef = useRef<string | null>(null);
  const submittedTaskIdRef = useRef<string | null>(null);
  const submittingGenerationRef = useRef(false);
  const taskSyncSequenceRef = useRef(0);
  const generationViewState = resolveGenerationViewState({ loading, restoringTaskView, task, images });
  const isGenerationProcessing = generationViewState === "submitting" || generationViewState === "processing";
  const [finishingTaskId, setFinishingTaskId] = useState<string | null>(null);
  const showProcessingPlaceholders =
    isGenerationProcessing || (task?.status === "SUCCEEDED" && finishingTaskId === task.id);

  useEffect(() => {
    if (isGenerationProcessing) {
      setFinishingTaskId(task?.id ?? null);
      return;
    }
    if (task?.status !== "SUCCEEDED") {
      setFinishingTaskId(null);
      return;
    }
    // 已在本页显示的进度先走到 100%，再交接给结果；恢复已完成任务时直接显示图片。
    const timeout = window.setTimeout(() => setFinishingTaskId(null), progressTransitionMs + 50);
    return () => window.clearTimeout(timeout);
  }, [isGenerationProcessing, task?.id, task?.status]);

  const processingAspectRatio = task ? `${task.width} / ${task.height}` : aspectRatio.replace(":", " / ");
  const selectedAspectRatioValue = parseAspectRatioValue(aspectRatio.replace(":", "/")) ?? 1;
  const hasPrompt = prompt.trim().length > 0;
  const promptValidation = validateGenerationPromptLengths(prompt, "");
  const generationPromptError = promptValidation.prompt;
  const terminalGenerationFailureMessage =
    task && hasTerminalGenerationFailure(task, images) ? generationFailureMessage(task) : "";
  const resultStatus =
    generationViewState === "processing" || generationViewState === "submitting" || generationViewState === "restoring"
      ? (task?.status ?? "RUNNING")
      : (task?.status ?? "IDLE");
  const processingPlaceholderCount = resolveProcessingPlaceholderCount(task, quantity);

  useEffect(() => {
    if (browserStorageRestoredRef.current || initialTaskId) {
      return;
    }
    browserStorageRestoredRef.current = true;
    const draft = consumeGenerationDraft();
    if (draft) {
      applyGenerationDraft(draft);
    }
  }, [initialTaskId]);

  useEffect(() => {
    loadAccount();
  }, []);

  useEffect(() => {
    const taskId = searchParams.get("taskId");
    const ar = searchParams.get("aspectRatio");
    const qty = searchParams.get("quantity");
    const m = searchParams.get("model");
    if (taskId && submittedTaskIdRef.current === taskId) {
      submittingGenerationRef.current = false;
      setActiveGenerationTaskId(taskId);
      setRestoringTaskView(false);
      return;
    }
    if (submittingGenerationRef.current && taskId) {
      setRestoringTaskView(false);
      return;
    }
    if (submittingGenerationRef.current && !taskId) {
      setRestoringTaskView(false);
      return;
    }
    if (taskId && task?.id === taskId) {
      setActiveGenerationTaskId(taskId);
      setRestoringTaskView(false);
      return;
    }
    if (taskId && restoringTaskIdRef.current !== taskId) {
      const cachedSnapshot = readGenerationTaskSnapshot(taskId);
      if (cachedSnapshot) {
        applyTaskResult(cachedSnapshot);
        applyTaskParameters(cachedSnapshot.task);
        setRestoringTaskView(false);
        void restoreTask(taskId, { preserveVisibleState: true });
        return;
      }
      setRestoringTaskView(true);
      void restoreTask(taskId);
      return;
    }
    if (!taskId) {
      if (task && isTerminalTaskStatus(task.status) && submittedTaskIdRef.current === task.id) {
        submittedTaskIdRef.current = null;
      }
      if (!task || isTerminalTaskStatus(task.status)) {
        // URL 丢失 taskId（如通过导航切走再回来）时，用活跃任务指针兜底恢复正在进行的任务，
        // 避免正在生成的任务在界面上"消失"。指针只在任务进行中存在，终态时已被清除。
        const activeTaskId = readActiveGenerationTaskId();
        if (activeTaskId && restoringTaskIdRef.current !== activeTaskId) {
          const cachedSnapshot = readGenerationTaskSnapshot(activeTaskId);
          if (cachedSnapshot) {
            applyTaskResult(cachedSnapshot);
            applyTaskParameters(cachedSnapshot.task);
            setRestoringTaskView(false);
            void restoreTask(activeTaskId, { preserveVisibleState: true });
            return;
          }
          setRestoringTaskView(true);
          void restoreTask(activeTaskId);
          return;
        }
        setActiveGenerationTaskId(null);
        restoringTaskIdRef.current = null;
      }
      setRestoringTaskView(false);
    }
    if (ar && aspectRatioOptions.some((o) => o.value === ar)) setAspectRatio(ar);
    if (qty) {
      const n = Number(qty);
      if (Number.isInteger(n) && n >= 1 && n <= 4) setClampedQuantity(n);
    }
    if (m) {
      setModel(resolveSelectableImageModel(m));
    }
  }, [searchParams, task?.id, task?.status]);

  useEffect(() => {
    if (!task) {
      return;
    }
    saveGenerationTaskSnapshot(task, images);
  }, [images, task]);

  useEffect(() => {
    if (!activeGenerationTaskId) {
      return;
    }
    if (task?.id === activeGenerationTaskId && isTerminalTaskStatus(task.status)) {
      return;
    }
    const taskId = activeGenerationTaskId;
    const syncSequence = taskSyncSequenceRef.current + 1;
    taskSyncSequenceRef.current = syncSequence;
    const controller = new AbortController();
    void pollActiveGenerationTask(taskId, syncSequence, controller.signal);
    return () => controller.abort();
  }, [activeGenerationTaskId, task?.id, task?.status]);

  useEffect(() => {
    if (!hasPrompt || generationPromptError || modelSelectionError) {
      quoteRequestSequenceRef.current += 1;
      setQuote(0);
      return;
    }

    const requestSequence = quoteRequestSequenceRef.current + 1;
    quoteRequestSequenceRef.current = requestSequence;
    setQuote(0);
    let canceled = false;

    const timeoutId = setTimeout(() => {
      void apiFetch<{ creditCost: number }>("/api/generation/quote", {
        method: "POST",
        body: {
          prompt,
          style: "none",
          aspectRatio,
          quantity,
          quality,
          model,
          channel: selectedChannel || undefined
        }
      })
        .then((result) => {
          if (!canceled && quoteRequestSequenceRef.current === requestSequence) {
            setQuote(result.creditCost);
          }
        })
        .catch(() => {
          if (!canceled && quoteRequestSequenceRef.current === requestSequence) {
            setQuote(0);
          }
        });
    }, 280);

    return () => {
      canceled = true;
      clearTimeout(timeoutId);
    };
  }, [aspectRatio, generationPromptError, hasPrompt, model, modelSelectionError, selectedChannel, quality, quantity]);

  async function ensureLoggedIn(): Promise<void> {
    if (account) return;
    saveGenerationDraft(currentGenerationDraft());
    const generatePath = buildGeneratePath({
      style: "none",
      aspectRatio,
      quality,
      quantity,
      model,
      channel: selectedChannel || undefined
    });
    router.push(`/login?next=${encodeURIComponent(generatePath)}`);
    throw new Error("请先登录后再提交生成。");
  }

  function currentGenerationDraft() {
    return {
      prompt,
      style: "none",
      aspectRatio,
      quality,
      quantity,
      model,
      channel: selectedChannel || undefined
    };
  }

  async function loadAccount() {
    try {
      const result = await apiFetch<{ account: CreditAccount }>("/api/users/me/credits");
      setAccount(result.account);
    } catch {
      setAccount(null);
    }
  }

  async function loadLatestSafetyAppeal() {
    try {
      const eventsResult = await apiFetch<{ events: SafetyEvent[] }>("/api/users/me/safety-events?limit=5");
      const latestBlocked = eventsResult.events.find(
        (event) => event.status === "BLOCKED" || event.status === "REVIEW_REQUIRED"
      );
      if (!latestBlocked) {
        return;
      }
      setAppealEventId(latestBlocked.id);
      setShowAppealForm(false);
      const appealsResult = await getSafetyAppeals();
      const existing = appealsResult.appeals.find((appeal) => appeal.safetyEventId === latestBlocked.id);
      setAppealStatus(existing ?? null);
    } catch {
      // 安全事件只用于恢复入口，查询失败不应覆盖主错误提示。
    }
  }

  async function restoreTask(taskId: string, options?: { preserveVisibleState?: boolean }) {
    restoringTaskIdRef.current = taskId;
    setActiveGenerationTaskId(taskId);
    beginRestore(Boolean(options?.preserveVisibleState));
    try {
      const initialResult = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`);
      applyTaskResult(initialResult);
      applyTaskParameters(initialResult.task);
      if (isTerminalTaskStatus(initialResult.task.status)) {
        setMessage(restoreTaskMessage(initialResult.task, initialResult.images));
        setMessageTone(initialResult.task.status === "SUCCEEDED" ? "success" : "danger");
        setActiveGenerationTaskId(null);
        clearActiveGenerationTaskId();
        if (initialResult.task.status === "BLOCKED") {
          await loadLatestSafetyAppeal();
        }
        await loadAccount();
        return;
      }
      await loadAccount();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成任务恢复失败，请到历史记录查看结果。");
      setMessageTone("danger");
    } finally {
      setRestoringTaskView(false);
      setLoading(false);
    }
  }

  function applyTaskResult(result: { task: Task; images: GeneratedImage[] }) {
    applyWorkspaceTaskResult(result);
  }

  function applyTaskParameters(nextTask: Task) {
    setPrompt(nextTask.prompt);
    setAspectRatio(nextTask.aspectRatio);
    setClampedQuantity(nextTask.quantity);
    if (nextTask.channel) selectChannel(nextTask.channel);
    setModel(resolveSelectableImageModel(nextTask.modelName));
  }

  function applyGenerationDraft(draft: {
    prompt: string;
    negativePrompt?: string;
    style?: string;
    aspectRatio?: string;
    quality?: string;
    quantity?: number;
    model?: string;
    channel?: string;
    mode?: "reuse" | "variation";
  }) {
    setPrompt(draft.prompt);
    if (draft.aspectRatio && aspectRatioOptions.some((item) => item.value === draft.aspectRatio)) {
      setAspectRatio(draft.aspectRatio);
    }
    if (draft.quantity) {
      setClampedQuantity(draft.quantity);
    }
    if (draft.channel) selectChannel(draft.channel);
    if (draft.model) {
      setModel(resolveSelectableImageModel(draft.model));
    }
    if (draft.mode === "variation") {
      setMessage("已载入图片参数，可在提示词中微调后生成变体。");
      setMessageTone("info");
    } else if (draft.mode === "reuse") {
      setMessage("已复用历史参数，可直接提交生成。");
      setMessageTone("info");
    }
  }

  function applyGenerationMetadata(metadata: GenerationMetadata, mode: "reuse" | "variation") {
    const nextPrompt =
      mode === "variation" ? `${metadata.prompt}，保持主体一致，生成新的构图与细节变化` : metadata.prompt;
    setPrompt(nextPrompt);
    setAspectRatio(metadata.aspectRatio);
    setClampedQuantity(mode === "variation" ? 1 : metadata.quantity);
    if (metadata.channel) selectChannel(metadata.channel);
    setModel(resolveSelectableImageModel(metadata.modelName));
    setMessage(mode === "variation" ? "已套用图片参数并准备生成变体。" : "已复用该图片的生成参数。");
    setMessageTone("info");
  }

  async function downloadImage(image: GeneratedImage) {
    try {
      await downloadGeneratedImage(image.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下载链接获取失败，请稍后重试。");
      setMessageTone("danger");
    }
  }

  async function pollActiveGenerationTask(taskId: string, syncSequence: number, signal: AbortSignal): Promise<void> {
    let lastHeartbeat = 0;
    let terminalHandled = false;
    let latestTask: Task | null = null;
    const isCanceled = () => signal.aborted || taskSyncSequenceRef.current !== syncSequence;
    const receive = async (result: { task: Task; images: GeneratedImage[] }) => {
      if (isCanceled() || terminalHandled) return;
      if (
        latestTask &&
        (Date.parse(result.task.updatedAt) < Date.parse(latestTask.updatedAt) ||
          (result.task.progress?.sequence ?? 0) < (latestTask.progress?.sequence ?? 0))
      )
        return;
      latestTask = result.task;
      applyTaskResult(result);
      applyTaskParameters(result.task);
      setRestoringTaskView(false);
      setLoading(false);
      if (isTerminalTaskStatus(result.task.status)) {
        terminalHandled = true;
        await handleTerminalTaskResult(result);
        if (isCanceled()) return;
        if (submittedTaskIdRef.current === result.task.id) submittedTaskIdRef.current = null;
        if (activeGenerationTaskId === result.task.id) setActiveGenerationTaskId(null);
      }
    };
    const unsubscribe = subscribeGenerationTask(
      taskId,
      (result) => {
        void receive(result);
      },
      () => {
        lastHeartbeat = Date.now();
      }
    );
    signal.addEventListener("abort", unsubscribe, { once: true });
    try {
      while (!isCanceled() && !terminalHandled) {
        // 推送正常时不重复查询；不支持 SSE、断线或心跳中断时保留轮询恢复。
        if (Date.now() - lastHeartbeat > 20_000) {
          try {
            const result = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`);
            await receive(result);
          } catch (error) {
            if (isCanceled() || terminalHandled) return;
            if (task?.id === taskId) setLoading(false);
            setMessage(generationTaskSyncErrorMessage(error));
            setMessageTone("info");
          }
        }
        if (!terminalHandled) await sleep(taskSyncPollIntervalMs);
      }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", unsubscribe);
    }
  }

  async function handleTerminalTaskResult(result: { task: Task; images: GeneratedImage[] }) {
    clearActiveGenerationTaskId();
    if (result.task.status === "SUCCEEDED" && result.images.length > 0) {
      setMessage(generationSuccessMessage(result.task));
      setMessageTone("success");
    } else if (isTerminalTaskStatus(result.task.status)) {
      setMessage(generationFailureMessage(result.task));
      setMessageTone("danger");
      if (result.task.status === "BLOCKED") {
        await loadLatestSafetyAppeal();
      }
    }
    await loadAccount();
  }

  function setClampedQuantity(nextValue: number) {
    const nextQuantity = Math.max(1, Math.min(selectedModel?.maxQuantity ?? 4, Math.trunc(nextValue)));
    setQuantity(nextQuantity);
    setQuantityInput(String(nextQuantity));
  }

  function setQuantityFromInput(rawValue: string) {
    const trimmedValue = rawValue.trim();
    if (!trimmedValue) {
      setQuantityInput("");
      return;
    }
    const nextValue = Number(trimmedValue);
    if (!Number.isFinite(nextValue)) {
      return;
    }
    setClampedQuantity(nextValue);
  }

  function selectImageModel(modelId: string) {
    const nextModel = modelCatalog.models.find((option) => option.id === modelId);
    if (!nextModel) return;
    setModel(nextModel.id);
    rememberModel(nextModel.id);
    if (nextModel.aspectRatios.length && !nextModel.aspectRatios.includes(aspectRatio)) {
      setAspectRatio(nextModel.aspectRatios[0]);
    }
    const nextQuantity = Math.min(quantity, nextModel.maxQuantity);
    setQuantity(nextQuantity);
    setQuantityInput(String(nextQuantity));
  }

  function validateForm(): string | null {
    if (modelSelectionError) return modelSelectionError;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return "请输入提示词后再提交生成。";
    }
    if (trimmedPrompt.length < 6) {
      return "提示词至少需要 6 个字符，别拿半句黑话糊弄模型。";
    }
    if (generationPromptError) return generationPromptError;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) {
      return "生成数量仅支持 1 到 4 张，请调整后重试。";
    }
    return null;
  }

  async function handleAppeal() {
    if (!appealEventId || appealReason.trim().length < 10) return;
    setAppealLoading(true);
    try {
      const result = await submitSafetyAppeal(appealEventId, appealReason.trim());
      setAppealStatus(result.appeal);
      setShowAppealForm(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "申诉提交失败，请稍后重试。");
      setMessageTone("danger");
    } finally {
      setAppealLoading(false);
    }
  }

  async function submit() {
    const validationError = validateForm();
    if (validationError) {
      setMessage(validationError);
      setMessageTone("danger");
      return;
    }
    submittingGenerationRef.current = true;
    submittedTaskIdRef.current = null;
    taskSyncSequenceRef.current += 1;
    beginSubmission();
    clearActiveGenerationTaskId();
    router.replace(
      buildGeneratePath({
        style: "none",
        aspectRatio,
        quality,
        quantity,
        model,
        channel: selectedChannel || undefined
      }),
      {
        scroll: false
      }
    );
    restoringTaskIdRef.current = null;
    try {
      await ensureLoggedIn();
      const created = await apiFetch<{ task: Task; balanceAfter: number }>("/api/generation/tasks", {
        method: "POST",
        body: {
          clientRequestId: crypto.randomUUID(),
          prompt,
          style: "none",
          aspectRatio,
          quantity,
          quality,
          model,
          channel: selectedChannel || undefined
        }
      });
      restoringTaskIdRef.current = created.task.id;
      submittedTaskIdRef.current = created.task.id;
      setActiveGenerationTaskId(created.task.id);
      saveActiveGenerationTaskId(created.task.id);
      saveGenerationTaskSnapshot(created.task, []);
      setTask(created.task);
      router.replace(buildGenerateTaskPath(created.task.id), { scroll: false });
      setAccount((value) => (value ? { ...value, balance: created.balanceAfter } : value));
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        (error.code === "CONTENT_BLOCKED" || error.code === "CONTENT_REVIEW_REQUIRED")
      ) {
        await loadLatestSafetyAppeal();
      }
      setMessage(generationSubmitErrorMessage(error));
      setMessageTone("danger");
    } finally {
      if (!submittedTaskIdRef.current) {
        submittingGenerationRef.current = false;
      }
      setLoading(false);
    }
  }

  return (
    <AppFrame title="图片生成" subtitle="输入提示词，选择 API、模型和画面比例，提交前确认积分消耗。">
      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        {restoringTaskView ? (
          <>
            <Panel>
              <div className="space-y-5">
                <div>
                  <div className="h-4 w-20 rounded-full bg-white/10" />
                  <div className="mt-3 min-h-52 rounded-2xl border border-white/12 bg-black/28 p-4">
                    <div className="h-5 w-40 rounded-full bg-white/10" />
                    <div className="mt-3 h-4 w-full rounded-full bg-white/10" />
                    <div className="mt-2 h-4 w-5/6 rounded-full bg-white/10" />
                    <div className="mt-2 h-4 w-3/4 rounded-full bg-white/10" />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="h-14 rounded-2xl border border-white/12 bg-black/28" />
                  <div className="h-14 rounded-2xl border border-white/12 bg-black/28" />
                </div>
                <div className="h-24 rounded-2xl border border-white/12 bg-black/24" />
                <InlineNotice tone="info">正在恢复生成结果，马上回来，别急着怀疑人生。</InlineNotice>
              </div>
            </Panel>
            <Panel>
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">生成结果</h2>
                <StatusPill>RESTORING</StatusPill>
              </div>
              <div className="rounded-3xl border border-white/12 bg-black/24 p-4">
                <div
                  className="flex items-center justify-center rounded-[1.75rem] border border-dashed border-white/14 bg-black/32"
                  style={{ aspectRatio: "1 / 1" }}
                >
                  <div className="flex flex-col items-center gap-3 py-14 text-center">
                    <Sparkles className="size-8 animate-pulse text-mint" aria-hidden="true" />
                    <p className="text-sm text-white/72">正在恢复上一次生成结果...</p>
                  </div>
                </div>
              </div>
            </Panel>
          </>
        ) : (
          <>
            <Panel>
              <div className="space-y-5">
                {/* 提示词 */}
                <div>
                  <div className="text-sm text-white/70">
                    <label htmlFor="generation-prompt">提示词</label>
                    <textarea
                      id="generation-prompt"
                      className="focus-ring mt-2 min-h-52 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      aria-label="提示词"
                      aria-invalid={Boolean(promptValidation.prompt)}
                      aria-describedby="generation-prompt-length"
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p
                      id="generation-prompt-length"
                      className={`text-xs ${promptValidation.prompt ? "text-ember" : "text-white/45"}`}
                    >
                      {promptValidation.prompt ?? `${prompt.length} / ${maxEnhancedPromptLength} 个字符`}
                    </p>
                    <span
                      className="generation-ratio-control"
                      data-disabled={modelsLoading || !selectedModel?.aspectRatios.length}
                    >
                      <span className="generation-ratio-icon" aria-hidden="true">
                        <span
                          className="generation-ratio-frame"
                          style={{
                            transform: `scale(${Math.min(1, selectedAspectRatioValue)}, ${Math.min(1, 1 / selectedAspectRatioValue)})`
                          }}
                        />
                      </span>
                      <select
                        className="focus-ring generation-ratio-select"
                        value={aspectRatio}
                        onChange={(event) => setAspectRatio(event.target.value)}
                        aria-label="画面比例"
                        disabled={modelsLoading || !selectedModel?.aspectRatios.length}
                      >
                        {aspectRatioOptions.map((item) => (
                          <option
                            key={item.value}
                            value={item.value}
                            disabled={!selectedModel?.aspectRatios.includes(item.value)}
                          >
                            {item.label}
                            {selectedModel && !selectedModel.aspectRatios.includes(item.value) ? "（不可用）" : ""}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="generation-ratio-chevron" aria-hidden="true" />
                    </span>
                  </div>
                </div>

                <div>
                  <ImageModelSelect
                    models={modelCatalog.models}
                    channels={modelCatalog.channels ?? []}
                    channel={selectedChannel}
                    onChannelChange={(channel) => {
                      setModel("");
                      selectChannel(channel);
                    }}
                    value={model}
                    onChange={selectImageModel}
                    loading={modelsLoading}
                    error={modelsError}
                    onRefresh={refreshModels}
                    className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white"
                  />
                  <span
                    id="generation-model-help"
                    className="mt-2 block text-xs text-white/55"
                    role={modelSelectionError && !modelsLoading ? "alert" : undefined}
                  >
                    {modelSelectionError ?? "切换 API 后会更新可选模型，切换线路或模型会重新计算积分。"}
                  </span>
                </div>

                <label className="block text-sm text-white/70">
                  生成数量
                  <input
                    className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                    type="number"
                    min={1}
                    max={selectedModel?.maxQuantity ?? 4}
                    value={quantityInput}
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => setQuantityFromInput(event.target.value)}
                    onBlur={() => setQuantityInput(String(quantity))}
                  />
                </label>

                {/* 积分预估 */}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/12 bg-black/24 p-4">
                  <span className="inline-flex items-center gap-2 text-sm text-white/72">
                    <Coins className="size-4 text-volt" aria-hidden="true" />
                    预计消耗：{quote ? formatCredits(quote) : "登录后计算"}
                  </span>
                  <span className="text-sm text-white/72">
                    当前余额：{account ? formatCredits(account.balance) : "未登录"}
                  </span>
                </div>

                {message ? (
                  <InlineNotice tone={messageTone}>
                    {message}
                    {messageTone === "danger" ? (
                      <>
                        {" "}
                        <button className="underline underline-offset-4" onClick={() => void submit()} type="button">
                          重试提交
                        </button>
                        {" 或 "}
                        <button
                          className="underline underline-offset-4"
                          onClick={() => router.push("/history")}
                          type="button"
                        >
                          去历史查看
                        </button>
                      </>
                    ) : null}
                  </InlineNotice>
                ) : null}

                {/* 申诉入口：仅在任务被内容拦截且存在对应安全事件时显示 */}
                {appealEventId && !appealStatus ? (
                  <div className="rounded-2xl border border-amber-500/30 bg-amber-500/8 p-4">
                    <p className="mb-3 text-sm text-amber-300">如认为是误判，可提交申诉，管理员将在审核后回复。</p>
                    {showAppealForm ? (
                      <div className="space-y-3">
                        <label className="block text-sm text-white/70">
                          申诉理由（至少 10 字）
                          <textarea
                            className="focus-ring mt-2 min-h-24 w-full resize-none rounded-xl border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                            value={appealReason}
                            onChange={(event) => setAppealReason(event.target.value)}
                            placeholder="请说明为什么认为此次拦截是误判，或提供更多背景信息..."
                            maxLength={1000}
                          />
                        </label>
                        <div className="flex gap-2">
                          <button
                            className="focus-ring rounded-full bg-amber-500/80 px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-amber-400 disabled:opacity-50"
                            type="button"
                            disabled={appealLoading || appealReason.trim().length < 10}
                            onClick={() => void handleAppeal()}
                          >
                            {appealLoading ? "提交中..." : "提交申诉"}
                          </button>
                          <button
                            className="focus-ring rounded-full border border-white/20 px-4 py-2 text-sm text-white/60 hover:text-white"
                            type="button"
                            onClick={() => setShowAppealForm(false)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="focus-ring rounded-full bg-amber-500/20 px-4 py-2 text-sm text-amber-300 transition-colors hover:bg-amber-500/30"
                        type="button"
                        onClick={() => setShowAppealForm(true)}
                      >
                        发起申诉
                      </button>
                    )}
                  </div>
                ) : null}

                {appealStatus ? (
                  <div className="rounded-2xl border border-white/12 bg-white/4 p-4">
                    <p className="text-sm text-white/70">
                      申诉状态：
                      <span
                        className={`font-medium ${appealStatus.status === "APPROVED" ? "text-mint" : appealStatus.status === "REJECTED" ? "text-ember" : "text-amber-300"}`}
                      >
                        {appealStatus.status === "PENDING"
                          ? "待审核"
                          : appealStatus.status === "APPROVED"
                            ? "已通过"
                            : "已驳回"}
                      </span>
                      {appealStatus.adminNote ? `，备注：${appealStatus.adminNote}` : ""}
                    </p>
                  </div>
                ) : null}

                {generationPromptError ? <InlineNotice tone="danger">{generationPromptError}</InlineNotice> : null}

                <button
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
                  type="button"
                  disabled={
                    loading ||
                    isGenerationProcessing ||
                    !hasPrompt ||
                    Boolean(generationPromptError) ||
                    Boolean(modelSelectionError)
                  }
                  onClick={submit}
                >
                  <Wand2 className="size-4" aria-hidden="true" />
                  {isGenerationProcessing ? "生成中..." : "提交生成"}
                </button>
              </div>
            </Panel>

            <Panel>
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">生成结果</h2>
                <StatusPill>{resultStatus}</StatusPill>
              </div>
              {terminalGenerationFailureMessage ? (
                <div className="mb-4 rounded-2xl border border-ember/40 bg-ember/10 p-4">
                  <p className="text-sm font-semibold text-ember">生成失败</p>
                  <p className="mt-1 text-sm leading-6 text-ember/90">{terminalGenerationFailureMessage}</p>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {showProcessingPlaceholders
                  ? Array.from({ length: processingPlaceholderCount }).map((_, index) => (
                      <GenerationProcessingPlaceholder
                        key={`生成占位-${task?.id ?? "submitting"}-${index}`}
                        index={index}
                        processingAspectRatio={processingAspectRatio}
                        task={task}
                        progress={resolveGenerationProgress(task, images, quantity, index)}
                      />
                    ))
                  : null}
                {(showProcessingPlaceholders ? [] : images).map((image, index) => (
                  <article
                    key={image.id}
                    className="relative overflow-hidden rounded-2xl border border-white/12 bg-black/18"
                  >
                    <GeneratedImagePreviewButton
                      alt="生成图片结果"
                      ariaLabel={`预览第 ${index + 1} 张生成图片`}
                      className="rounded-none border-0 border-b border-white/10 bg-transparent hover:translate-y-0"
                      image={image}
                      onOpen={() => setSelectedPreviewImage(image)}
                    />
                    <button
                      className="focus-ring group/download absolute right-3 top-3 z-10 inline-flex size-9 items-center justify-center rounded-full border border-white/16 bg-ink/70 text-white/80 backdrop-blur-md transition duration-200 motion-reduce:transform-none motion-reduce:transition-none hover:-translate-y-0.5 hover:scale-105 hover:border-mint/70 hover:bg-ink/85 hover:text-mint hover:shadow-glow"
                      type="button"
                      aria-label={`下载第 ${index + 1} 张生成图片`}
                      title="下载图片"
                      onClick={() => void downloadImage(image)}
                    >
                      <Download
                        className="size-4 transition-transform duration-200 motion-reduce:transform-none group-hover/download:translate-y-0.5"
                        aria-hidden="true"
                      />
                    </button>
                    <div className="space-y-3 p-3">
                      <dl className="grid gap-2 text-xs text-white/52 sm:grid-cols-2">
                        <div>
                          <dt>比例</dt>
                          <dd className="mt-0.5 text-white/78">{image.generationMetadata.aspectRatio}</dd>
                        </div>
                        <div>
                          <dt>模型</dt>
                          <dd className="mt-0.5 truncate text-white/78">{image.generationMetadata.modelName}</dd>
                        </div>
                      </dl>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-2 text-xs text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                          type="button"
                          onClick={() => applyGenerationMetadata(image.generationMetadata, "reuse")}
                        >
                          <Copy className="size-3.5" aria-hidden="true" />
                          复用参数
                        </button>
                        <button
                          className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-mint/36 px-3 py-2 text-xs text-mint transition-colors duration-200 hover:bg-mint/10"
                          type="button"
                          onClick={() => applyGenerationMetadata(image.generationMetadata, "variation")}
                        >
                          <RefreshCw className="size-3.5" aria-hidden="true" />
                          生成变体
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
                {!terminalGenerationFailureMessage && !isGenerationProcessing && images.length === 0 ? (
                  <div className="sm:col-span-2">
                    <EmptyState
                      title="生成结果会显示在这里"
                      description="填写提示词并提交生成后，图片会按固定比例展示，成功后可进入详情、下载或再次生成。"
                      actionLabel="提交生成"
                      onAction={() => void submit()}
                    />
                  </div>
                ) : null}
              </div>
            </Panel>
          </>
        )}
      </div>
      <GeneratedImageLightbox image={selectedPreviewImage} onClose={() => setSelectedPreviewImage(null)} />
    </AppFrame>
  );
}

function resolveInitialAspectRatio(value: string | null): string {
  return value && aspectRatioOptions.some((item) => item.value === value) ? value : DEFAULT_ASPECT_RATIO;
}

function resolveInitialQuantity(value: string | null): number {
  if (!value) {
    return DEFAULT_QUANTITY;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : DEFAULT_QUANTITY;
}

function resolveInitialModel(value: string | null): string {
  return value ? resolveSelectableImageModel(value) : "";
}

function GenerationTaskProgress({ progress }: { progress: ReturnType<typeof resolveGenerationProgress> }) {
  const [displayedPercentage, setDisplayedPercentage] = useState(0);
  const displayedPercentageRef = useRef(0);
  const targetPercentage = progress.percentage ?? 0;

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const from = displayedPercentageRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const update = (value: number) => {
      displayedPercentageRef.current = value;
      setDisplayedPercentage(value);
    };
    const animate = (now: number) => {
      const elapsed = reducedMotion.matches ? 1 : Math.min(1, (now - startedAt) / progressTransitionMs);
      update(from + (targetPercentage - from) * elapsed);
      if (elapsed < 1) frame = window.requestAnimationFrame(animate);
    };
    const handleMotionChange = () => {
      if (!reducedMotion.matches) return;
      window.cancelAnimationFrame(frame);
      update(targetPercentage);
    };
    frame = window.requestAnimationFrame(animate);
    reducedMotion.addEventListener("change", handleMotionChange);
    return () => {
      window.cancelAnimationFrame(frame);
      reducedMotion.removeEventListener("change", handleMotionChange);
    };
  }, [targetPercentage]);

  return (
    <div className="mt-2 w-full text-left">
      <div className="flex items-center justify-end text-[10px] leading-4 text-white/64">
        <span className="shrink-0 tabular-nums text-mint">
          {progress.percentage === null ? "—" : `${Math.floor(displayedPercentage)}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="图片生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percentage ?? undefined}
        aria-valuetext={progress.percentage === null ? "等待进度同步" : `${progress.percentage}%`}
        className="mt-1 h-1 overflow-hidden rounded-full bg-white/10"
      >
        <span
          className="block h-full w-full rounded-full bg-mint"
          style={{ transform: `translateX(${displayedPercentage - 100}%)` }}
        />
      </div>
    </div>
  );
}

function GenerationProcessingPlaceholder({
  index,
  processingAspectRatio,
  task,
  progress
}: {
  index: number;
  processingAspectRatio: string;
  task: Task | null;
  progress: ReturnType<typeof resolveGenerationProgress>;
}) {
  const aspectRatioValue = parseAspectRatioValue(processingAspectRatio);
  const isWideFrame = (aspectRatioValue ?? 1) >= 1.5;

  return (
    <div
      aria-label={`第 ${index + 1} 张图片正在生成`}
      className="relative w-full overflow-hidden rounded-2xl border border-mint/24 bg-black/28 shadow-glow motion-reduce:transition-none"
      role="status"
      style={{ aspectRatio: processingAspectRatio }}
    >
      <span className="pointer-events-none absolute -inset-16 bg-[conic-gradient(from_130deg,transparent,rgba(88,240,182,0.42),rgba(37,216,255,0.28),transparent)] opacity-70 blur-2xl motion-safe:animate-spin motion-reduce:animate-none" />
      <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_24%,rgba(217,248,91,0.18),transparent_32%),radial-gradient(circle_at_72%_68%,rgba(37,216,255,0.16),transparent_38%)] motion-safe:animate-pulse motion-reduce:opacity-70" />
      <span className="pointer-events-none absolute inset-3 rounded-[1.25rem] border border-white/10 bg-ink/72 backdrop-blur-md" />
      <span className="pointer-events-none absolute inset-x-5 top-3 h-px bg-gradient-to-r from-transparent via-mint/70 to-transparent motion-safe:animate-pulse motion-reduce:opacity-60" />
      <div className={`relative flex h-full items-center justify-center px-5 ${isWideFrame ? "py-3" : "text-center"}`}>
        <div
          className={`flex w-full ${isWideFrame ? "max-w-[17rem] items-center gap-3 text-left" : "max-w-48 flex-col items-center"}`}
        >
          <span
            className={`relative inline-flex items-center justify-center rounded-full border border-mint/36 bg-mint/10 text-mint shadow-glow ${isWideFrame ? "size-9 shrink-0" : "size-14"}`}
          >
            <span className="absolute inset-0 rounded-full border border-mint/40 motion-safe:animate-ping motion-reduce:hidden" />
            <Sparkles className={isWideFrame ? "size-5" : "size-6"} aria-hidden="true" />
          </span>
          <div className={`min-w-0 ${isWideFrame ? "flex-1" : "mt-4 w-full"}`}>
            <p className={`font-semibold text-white ${isWideFrame ? "text-xs leading-4" : "text-sm"}`}>
              {resolveImageProgressLabel(task, index)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-white/56">第 {index + 1} 张</p>
            <GenerationTaskProgress progress={progress} />
          </div>
        </div>
      </div>
    </div>
  );
}

function parseAspectRatioValue(value: string): number | null {
  const [widthText, heightText] = value.split("/").map((segment) => segment.trim());
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return width / height;
}

function generationFailureMessage(task: Task): string {
  const refundedCredits = task.refundedCredits ?? 0;
  if (task.failureCode === "PROVIDER_AUTH_FAILED") {
    const requestId = extractProviderRequestId(task.failureMessage);
    const baseMessage = requestId
      ? `图像供应商鉴权失败，当前配置的令牌或网关不可用，请检查 OPENAI_API_KEY 与 OPENAI_BASE_URL。上游 request id: ${requestId}。`
      : "图像供应商鉴权失败，当前配置的令牌或网关不可用，请检查 OPENAI_API_KEY 与 OPENAI_BASE_URL。";
    return appendRefundHint(baseMessage, refundedCredits);
  }
  const baseMessage = task.failureMessage ?? "生成未成功，请调整提示词或稍后重试。";
  return appendRefundHint(baseMessage, refundedCredits);
}

function restoreTaskMessage(task: Task, images: GeneratedImage[]): string {
  if (task.status === "SUCCEEDED" && images.length > 0) {
    return "已恢复上一次生成结果。";
  }
  return generationFailureMessage(task);
}

function appendRefundHint(baseMessage: string, refundedCredits: number): string {
  if (refundedCredits > 0) {
    if (baseMessage.includes("自动返还")) {
      return `${baseMessage.replace(/。$/, "")}（${formatCredits(refundedCredits)}）。`;
    }
    return `${baseMessage} 已自动返还 ${formatCredits(refundedCredits)}。`;
  }
  return `${baseMessage} 如已扣除积分，系统会自动补偿，请稍后刷新余额。`;
}

function extractProviderRequestId(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  const match = /request id:\s*([^)。\s]+)/i.exec(message);
  return match?.[1] ?? null;
}

function generationSuccessMessage(task: Task): string {
  const refundedCredits = task.refundedCredits ?? 0;
  if (refundedCredits > 0) {
    return `生成完成，未交付图片的差额已自动返还 ${formatCredits(refundedCredits)}。`;
  }
  return "生成完成，可进入详情继续下载、收藏或再次生成。";
}

function generationSubmitErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.apiMessage?.includes("Credits were refunded")) {
    return "生成任务无法进入队列，本次扣除的积分已自动返还。";
  }
  if (error instanceof ApiRequestError && error.code === "PROVIDER_AUTH_FAILED") {
    const requestId = extractProviderRequestId(error.apiMessage ?? error.message);
    return requestId
      ? `图像供应商鉴权失败，请检查 OPENAI_API_KEY 与 OPENAI_BASE_URL。上游 request id: ${requestId}。`
      : "图像供应商鉴权失败，请检查 OPENAI_API_KEY 与 OPENAI_BASE_URL。";
  }
  return error instanceof Error ? error.message : "生成失败，请稍后重试。";
}

function generationTaskSyncErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 404) {
    return "生成任务暂时无法读取，请到历史记录查看结果。";
  }
  return "生成状态同步暂时中断，页面会继续自动刷新结果。";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
