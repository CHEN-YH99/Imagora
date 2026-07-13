"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Coins, Sparkles, Wand2 } from "lucide-react";
import { AppFrame, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { GeneratedImageLightbox, GeneratedImagePreviewButton } from "../../components/GeneratedImagePreview";
import {
  ApiRequestError,
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_MODEL_OPTIONS,
  apiFetch,
  formatCredits,
  getSafetyAppeals,
  resolveSelectableImageModel,
  submitSafetyAppeal,
  type CreditAccount,
  type GeneratedImage,
  type SafetyAppeal,
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
  resolveProcessingPlaceholderCount
} from "./generationState";

const DEFAULT_PROMPT = "半透明智能相机的电影感产品摄影，薄荷色轮廓光，黑色台面，高细节";
const DEFAULT_NEGATIVE_PROMPT = "低质量、模糊、水印、变形";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_QUANTITY = 2;
const DEFAULT_QUALITY = "standard";
const taskSyncPollIntervalMs = 2_000;

const qualityOptions = [
  { value: "draft", label: "1K", desc: "512–768px，速度最快" },
  { value: "standard", label: "2K", desc: "1024px，均衡首选" },
  { value: "high", label: "4K", desc: "最高画质，耗时较长" }
];

const aspectRatioOptions = [
  { value: "1:1", label: "1:1 — 方形" },
  { value: "3:4", label: "3:4 — 竖版" },
  { value: "4:3", label: "4:3 — 横版" },
  { value: "9:16", label: "9:16 — 手机竖屏" },
  { value: "16:9", label: "16:9 — 宽屏" }
];

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
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE_PROMPT);
  const [aspectRatio, setAspectRatio] = useState(resolveInitialAspectRatio(searchParams.get("aspectRatio")));
  const [quantity, setQuantity] = useState(resolveInitialQuantity(searchParams.get("quantity")));
  const [quantityInput, setQuantityInput] = useState(String(quantity));
  const [quality, setQuality] = useState(resolveInitialQuality(searchParams.get("quality")));
  const [model, setModel] = useState(resolveInitialModel(searchParams.get("model")));
  const [quote, setQuote] = useState(0);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<GeneratedImage | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "success" | "danger">("danger");
  const [loading, setLoading] = useState(false);
  const [activeGenerationTaskId, setActiveGenerationTaskId] = useState<string | null>(initialTaskId);
  const [appealEventId, setAppealEventId] = useState<string | null>(null);
  const [showAppealForm, setShowAppealForm] = useState(false);
  const [appealReason, setAppealReason] = useState("");
  const [appealStatus, setAppealStatus] = useState<SafetyAppeal | null>(null);
  const [appealLoading, setAppealLoading] = useState(false);
  const [restoringTaskView, setRestoringTaskView] = useState(Boolean(initialTaskId));
  const browserStorageRestoredRef = useRef(false);
  const quoteRequestSequenceRef = useRef(0);
  const restoringTaskIdRef = useRef<string | null>(null);
  const submittedTaskIdRef = useRef<string | null>(null);
  const submittingGenerationRef = useRef(false);
  const taskSyncSequenceRef = useRef(0);
  const generationViewState = resolveGenerationViewState({ loading, restoringTaskView, task, images });
  const isGenerationProcessing = generationViewState === "submitting" || generationViewState === "processing";
  const processingAspectRatio = task ? `${task.width} / ${task.height}` : aspectRatio.replace(":", " / ");
  const hasPrompt = prompt.trim().length > 0;
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
      setPrompt(draft.prompt);
    }
  }, [initialTaskId]);

  useEffect(() => {
    loadAccount();
  }, []);

  useEffect(() => {
    const taskId = searchParams.get("taskId");
    const ar = searchParams.get("aspectRatio");
    const q = searchParams.get("quality");
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
    if (q && qualityOptions.some((o) => o.value === q)) setQuality(q);
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
    let canceled = false;
    void pollActiveGenerationTask(taskId, syncSequence, () => canceled);
    return () => {
      canceled = true;
    };
  }, [activeGenerationTaskId, task?.id, task?.status]);

  useEffect(() => {
    if (!hasPrompt) {
      quoteRequestSequenceRef.current += 1;
      setQuote(0);
      return;
    }

    const requestSequence = quoteRequestSequenceRef.current + 1;
    quoteRequestSequenceRef.current = requestSequence;
    let canceled = false;

    const timeoutId = setTimeout(() => {
      void apiFetch<{ creditCost: number }>("/api/generation/quote", {
        method: "POST",
        body: {
          prompt,
          negativePrompt,
          style: "realistic",
          aspectRatio,
          quantity,
          quality,
          model
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
  }, [aspectRatio, hasPrompt, model, quality, quantity]);

  async function ensureLoggedIn(): Promise<void> {
    if (account) return;
    saveGenerationDraft(prompt);
    const generatePath = buildGeneratePath({
      aspectRatio,
      quality,
      quantity,
      model
    });
    router.push(`/login?next=${encodeURIComponent(generatePath)}`);
    throw new Error("请先登录后再提交生成。");
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
    setLoading(true);
    setMessage("");
    setMessageTone("info");
    if (!options?.preserveVisibleState) {
      setTask(null);
      setImages([]);
      setSelectedPreviewImage(null);
    }
    setAppealEventId(null);
    setAppealStatus(null);
    setShowAppealForm(false);
    setAppealReason("");
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
    setTask(result.task);
    setImages(result.images);
  }

  function applyTaskParameters(nextTask: Task) {
    setPrompt(nextTask.prompt);
    setNegativePrompt(nextTask.negativePrompt ?? "");
    setAspectRatio(nextTask.aspectRatio);
    setClampedQuantity(nextTask.quantity);
    setQuality(nextTask.quality);
    setModel(resolveSelectableImageModel(nextTask.modelName));
  }

  async function pollActiveGenerationTask(
    taskId: string,
    syncSequence: number,
    isCanceled: () => boolean
  ): Promise<void> {
    while (!isCanceled() && taskSyncSequenceRef.current === syncSequence) {
      try {
        const result = await apiFetch<{ task: Task; images: GeneratedImage[] }>(`/api/generation/tasks/${taskId}`);
        if (isCanceled() || taskSyncSequenceRef.current !== syncSequence) {
          return;
        }
        applyTaskResult(result);
        applyTaskParameters(result.task);
        setRestoringTaskView(false);
        setLoading(false);
        if (isTerminalTaskStatus(result.task.status)) {
          await handleTerminalTaskResult(result);
          if (submittedTaskIdRef.current === result.task.id) {
            submittedTaskIdRef.current = null;
          }
          if (activeGenerationTaskId === result.task.id) {
            setActiveGenerationTaskId(null);
          }
          return;
        }
      } catch (error) {
        if (isCanceled() || taskSyncSequenceRef.current !== syncSequence) {
          return;
        }
        if (task?.id === taskId) {
          setLoading(false);
        }
        setMessage(generationTaskSyncErrorMessage(error));
        setMessageTone("info");
      }
      await sleep(taskSyncPollIntervalMs);
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
    const nextQuantity = Math.max(1, Math.min(4, Math.trunc(nextValue)));
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

  function validateForm(): string | null {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return "请输入提示词后再提交生成。";
    }
    if (trimmedPrompt.length < 6) {
      return "提示词至少需要 6 个字符，别拿半句黑话糊弄模型。";
    }
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
    setActiveGenerationTaskId(null);
    clearActiveGenerationTaskId();
    router.replace(buildGeneratePath({ aspectRatio, quality, quantity, model }), { scroll: false });
    setLoading(true);
    setMessage("");
    setMessageTone("danger");
    setTask(null);
    setImages([]);
    setSelectedPreviewImage(null);
    restoringTaskIdRef.current = null;
    setAppealEventId(null);
    setAppealStatus(null);
    setShowAppealForm(false);
    setAppealReason("");
    try {
      await ensureLoggedIn();
      const created = await apiFetch<{ task: Task; balanceAfter: number }>("/api/generation/tasks", {
        method: "POST",
        body: {
          clientRequestId: crypto.randomUUID(),
          prompt,
          negativePrompt,
          style: "realistic",
          aspectRatio,
          quantity,
          quality,
          model
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
    <AppFrame title="图片生成" subtitle="输入提示词，选择模型、比例和画质，提交前确认积分消耗。">
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
                <label className="block text-sm text-white/70">
                  提示词
                  <textarea
                    className="focus-ring mt-2 min-h-52 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </label>

                {/* 负向提示词 */}
                <label className="block text-sm text-white/70">
                  负向提示词
                  <input
                    className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                    value={negativePrompt}
                    onChange={(event) => setNegativePrompt(event.target.value)}
                  />
                </label>

                {/* 模型选择下拉 */}
                <label className="block text-sm text-white/70">
                  模型
                  <select
                    className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {IMAGE_MODEL_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  {/* 画面比例下拉 */}
                  <label className="block text-sm text-white/70">
                    画面比例
                    <select
                      className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white"
                      value={aspectRatio}
                      onChange={(event) => setAspectRatio(event.target.value)}
                    >
                      {aspectRatioOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* 生成数量 */}
                  <label className="block text-sm text-white/70">
                    生成数量
                    <input
                      className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                      type="number"
                      min={1}
                      max={4}
                      value={quantityInput}
                      onFocus={(event) => event.target.select()}
                      onChange={(event) => setQuantityFromInput(event.target.value)}
                      onBlur={() => setQuantityInput(String(quantity))}
                    />
                  </label>
                </div>

                {/* 画质选择 */}
                <fieldset>
                  <legend className="mb-2 text-sm text-white/70">画质</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {qualityOptions.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setQuality(item.value)}
                        className={`focus-ring rounded-2xl border px-3 py-3 text-center transition-colors duration-200 ${
                          quality === item.value
                            ? "border-mint/70 bg-mint/10 text-white"
                            : "border-white/12 bg-black/28 text-white/70 hover:bg-white/8"
                        }`}
                      >
                        <p className="text-base font-bold">{item.label}</p>
                        <p className="mt-0.5 text-xs opacity-60">{item.desc}</p>
                      </button>
                    ))}
                  </div>
                </fieldset>

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

                <button
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
                  type="button"
                  disabled={loading || isGenerationProcessing || !prompt.trim()}
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
                {isGenerationProcessing
                  ? Array.from({ length: processingPlaceholderCount }).map((_, index) => (
                      <GenerationProcessingPlaceholder
                        key={`生成占位-${index}`}
                        index={index}
                        processingAspectRatio={processingAspectRatio}
                      />
                    ))
                  : null}
                {images.map((image, index) => (
                  <GeneratedImagePreviewButton
                    key={image.id}
                    alt="生成图片结果"
                    ariaLabel={`预览第 ${index + 1} 张生成图片`}
                    image={image}
                    onOpen={() => setSelectedPreviewImage(image)}
                  />
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

function resolveInitialQuality(value: string | null): string {
  return value && qualityOptions.some((item) => item.value === value) ? value : DEFAULT_QUALITY;
}

function resolveInitialQuantity(value: string | null): number {
  if (!value) {
    return DEFAULT_QUANTITY;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : DEFAULT_QUANTITY;
}

function resolveInitialModel(value: string | null): string {
  return value ? resolveSelectableImageModel(value) : DEFAULT_IMAGE_MODEL_ID;
}

function GenerationProcessingPlaceholder({
  index,
  processingAspectRatio
}: {
  index: number;
  processingAspectRatio: string;
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
      <span className="pointer-events-none absolute inset-x-5 top-5 h-px bg-gradient-to-r from-transparent via-mint/70 to-transparent motion-safe:animate-pulse motion-reduce:opacity-60" />
      <div
        className={`relative flex h-full justify-center ${isWideFrame ? "items-center px-4 py-4" : "items-center px-5 text-center"}`}
      >
        <div
          className={`flex ${isWideFrame ? "w-full max-w-[17rem] items-center gap-3 rounded-[1.15rem] border border-white/10 bg-black/14 px-3 py-3 text-left" : "flex-col items-center"}`}
        >
          <span
            className={`relative inline-flex items-center justify-center rounded-full border border-mint/36 bg-mint/10 text-mint shadow-glow ${isWideFrame ? "size-11 shrink-0" : "size-14"}`}
          >
            <span className="absolute inset-0 rounded-full border border-mint/40 motion-safe:animate-ping motion-reduce:hidden" />
            <Sparkles className={isWideFrame ? "size-5" : "size-6"} aria-hidden="true" />
          </span>
          <div className={`min-w-0 ${isWideFrame ? "flex-1" : "mt-4"}`}>
            <p className="text-sm font-semibold text-white">正在生成</p>
            <p className={`mt-1 text-xs leading-5 text-white/56 ${isWideFrame ? "max-w-none" : "max-w-48"}`}>
              AI 正在构图、上色并输出图片
            </p>
            <div
              className={
                isWideFrame
                  ? "mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
                  : "mt-5 h-1.5 w-28 overflow-hidden rounded-full bg-white/10"
              }
            >
              <span className="block h-full w-1/2 rounded-full bg-gradient-to-r from-mint via-cyanx to-volt motion-safe:animate-pulse" />
            </div>
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
