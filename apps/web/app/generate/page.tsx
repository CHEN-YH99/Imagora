"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Coins, ImagePlus, Sparkles, X, Wand2 } from "lucide-react";
import { AppFrame, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { GeneratedImageLightbox, GeneratedImagePreviewButton } from "../../components/GeneratedImagePreview";
import {
  ApiRequestError,
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_MODEL_OPTIONS,
  TaskWaitTimeoutError,
  apiFetch,
  formatCredits,
  getSafetyAppeals,
  resolveSelectableImageModel,
  submitSafetyAppeal,
  waitForTask,
  type CreditAccount,
  type GeneratedImage,
  type ReferenceImage,
  type SafetyAppeal,
  type SafetyEvent,
  type Task
} from "../../lib/api";

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
  const [prompt, setPrompt] = useState("半透明智能相机的电影感产品摄影，薄荷色轮廓光，黑色台面，高细节");
  const [negativePrompt, setNegativePrompt] = useState("低质量、模糊、水印、变形");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quantity, setQuantity] = useState(2);
  const [quality, setQuality] = useState("standard");
  const [model, setModel] = useState(DEFAULT_IMAGE_MODEL_ID);
  const [quote, setQuote] = useState(0);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<GeneratedImage | null>(null);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "success" | "danger">("danger");
  const [loading, setLoading] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [appealEventId, setAppealEventId] = useState<string | null>(null);
  const [showAppealForm, setShowAppealForm] = useState(false);
  const [appealReason, setAppealReason] = useState("");
  const [appealStatus, setAppealStatus] = useState<SafetyAppeal | null>(null);
  const [appealLoading, setAppealLoading] = useState(false);
  const isGenerationProcessing =
    images.length === 0 && (loading || task?.status === "PENDING" || task?.status === "RUNNING");
  const processingAspectRatio = task ? `${task.width} / ${task.height}` : aspectRatio.replace(":", " / ");
  const terminalGenerationFailureMessage =
    images.length === 0 &&
    task &&
    (task.status === "FAILED" || task.status === "BLOCKED" || task.status === "CANCELED" || Boolean(task?.failureMessage))
      ? generationFailureMessage(task)
      : "";
  const resultStatus = isGenerationProcessing ? (task?.status ?? "RUNNING") : (task?.status ?? "IDLE");

  useEffect(() => {
    loadAccount();
  }, []);

  useEffect(() => {
    const p = searchParams.get("prompt");
    const ar = searchParams.get("aspectRatio");
    const q = searchParams.get("quality");
    const qty = searchParams.get("quantity");
    const m = searchParams.get("model");
    if (p) setPrompt(p);
    if (ar && aspectRatioOptions.some((o) => o.value === ar)) setAspectRatio(ar);
    if (q && qualityOptions.some((o) => o.value === q)) setQuality(q);
    if (qty) {
      const n = Number(qty);
      if (Number.isInteger(n) && n >= 1 && n <= 4) setQuantity(n);
    }
    if (m) {
      setModel(resolveSelectableImageModel(m));
    }
  }, [searchParams]);

  useEffect(() => {
    apiFetch<{ creditCost: number }>("/api/generation/quote", {
      method: "POST",
      body: {
        prompt,
        negativePrompt,
        style: "realistic",
        aspectRatio,
        quantity,
        quality,
        model,
        referenceImageId: referenceImage?.id
      }
    })
      .then((result) => setQuote(result.creditCost))
      .catch(() => setQuote(0));
  }, [aspectRatio, negativePrompt, prompt, quality, quantity, referenceImage?.id, model]);

  async function ensureLoggedIn(): Promise<void> {
    if (account) return;
    const params = new URLSearchParams({
      prompt,
      aspectRatio,
      quality,
      quantity: String(quantity),
      model
    });
    router.push(`/login?next=${encodeURIComponent(`/generate?${params.toString()}`)}`);
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

  async function uploadReference(file: File) {
    setUploadingReference(true);
    setMessage("");
    setMessageTone("danger");
    try {
      await ensureLoggedIn();
      const dataUrl = await readFileAsDataUrl(file);
      const result = await apiFetch<{ referenceImage: ReferenceImage; duplicate: boolean }>(
        "/api/uploads/reference-images",
        {
          method: "POST",
          body: { fileName: file.name, mimeType: file.type, contentBase64: dataUrl.split(",")[1] ?? "" }
        }
      );
      setReferenceImage(result.referenceImage);
      setMessage("参考图上传完成，提交生成时会一并参与创作。");
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "参考图上传失败，请重新选择图片。");
      setMessageTone("danger");
    } finally {
      setUploadingReference(false);
    }
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
    setLoading(true);
    setMessage("");
    setMessageTone("danger");
    setTask(null);
    setImages([]);
    setSelectedPreviewImage(null);
    setAppealEventId(null);
    setAppealStatus(null);
    setShowAppealForm(false);
    setAppealReason("");
    let submittedTask: Task | null = null;
    try {
      await ensureLoggedIn();
      const created = await apiFetch<{ task: Task; balanceAfter: number }>("/api/generation/tasks", {
        method: "POST",
        body: {
          clientRequestId: crypto.randomUUID(),
          prompt,
          negativePrompt,
          referenceImageId: referenceImage?.id,
          style: "realistic",
          aspectRatio,
          quantity,
          quality,
          model
        }
      });
      submittedTask = created.task;
      setTask(created.task);
      setAccount((value) => (value ? { ...value, balance: created.balanceAfter } : value));
      const result = await waitForTask(created.task.id);
      setTask(result.task);
      setImages(result.images);
      if (result.task.status === "SUCCEEDED" && result.images.length > 0) {
        setMessage(generationSuccessMessage(result.task));
        setMessageTone("success");
      } else if (
        result.task.status === "FAILED" ||
        result.task.status === "BLOCKED" ||
        result.task.status === "CANCELED"
      ) {
        setMessage(generationFailureMessage(result.task));
        setMessageTone("danger");
        if (result.task.status === "BLOCKED") {
          await loadLatestSafetyAppeal();
        }
      }
      await loadAccount();
    } catch (error) {
      if (error instanceof TaskWaitTimeoutError) {
        if (error.latestResult) {
          setTask(error.latestResult.task);
          setImages(error.latestResult.images);
        } else if (submittedTask) {
          setTask(submittedTask);
        }
        setMessage(generationWaitTimeoutMessage(error.latestResult?.task ?? submittedTask));
        setMessageTone("info");
        await loadAccount();
        return;
      }
      if (
        error instanceof ApiRequestError &&
        (error.code === "CONTENT_BLOCKED" || error.code === "CONTENT_REVIEW_REQUIRED")
      ) {
        await loadLatestSafetyAppeal();
      }
      setMessage(generationSubmitErrorMessage(error));
      setMessageTone("danger");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppFrame title="图片生成" subtitle="输入提示词，选择模型、比例和画质，提交前确认积分消耗。">
      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <Panel>
          <div className="space-y-5">
            {/* 提示词 */}
            <label className="block text-sm text-white/70">
              提示词
              <textarea
                className="focus-ring mt-2 min-h-36 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
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

            {/* 参考图 */}
            <div className="rounded-2xl border border-white/12 bg-black/20 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-sm text-white/70">
                  <ImagePlus className="size-4 text-mint" aria-hidden="true" />
                  参考图
                </span>
                {referenceImage ? (
                  <button
                    className="focus-ring inline-flex size-8 items-center justify-center rounded-full border border-white/10 text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    type="button"
                    onClick={() => setReferenceImage(null)}
                    aria-label="清除参考图"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {referenceImage ? (
                <div className="flex items-center gap-3">
                  <img
                    className="size-20 shrink-0 rounded-xl border border-white/12 object-cover"
                    src={referenceImage.publicUrl}
                    alt="参考图预览"
                    loading="lazy"
                    decoding="async"
                    width={80}
                    height={80}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{referenceImage.originalFileName}</p>
                    <p className="mt-1 text-xs text-white/50">
                      {referenceImage.width ?? "-"} × {referenceImage.height ?? "-"} ·{" "}
                      {Math.ceil(referenceImage.fileSize / 1024)} KB
                    </p>
                  </div>
                </div>
              ) : (
                <label className="focus-ring flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/16 px-4 py-5 text-sm text-white/54 transition-colors duration-200 hover:border-mint/60 hover:text-white">
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={uploadingReference}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadReference(file);
                    }}
                  />
                  {uploadingReference ? "上传中..." : "上传 JPG、PNG 或 WebP 格式图片"}
                </label>
              )}
            </div>

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
                  value={quantity}
                  onChange={(event) => {
                    const rawValue = event.target.value.trim();
                    if (!rawValue) {
                      setQuantity(1);
                      return;
                    }
                    const nextValue = Number(rawValue);
                    if (!Number.isFinite(nextValue)) {
                      return;
                    }
                    setQuantity(Math.max(1, Math.min(4, Math.trunc(nextValue))));
                  }}
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
              disabled={loading || !prompt.trim()}
              onClick={submit}
            >
              <Wand2 className="size-4" aria-hidden="true" />
              {loading ? "生成中..." : "提交生成"}
            </button>
          </div>
        </Panel>

        <Panel>
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">生成结果</h2>
            <StatusPill>{resultStatus}</StatusPill>
          </div>
          {terminalGenerationFailureMessage ? (
            <div className="mb-4 rounded-2xl border border-ember/40 bg-ember/10 p-4" role="alert">
              <p className="text-sm font-semibold text-ember">生成失败</p>
              <p className="mt-1 text-sm leading-6 text-ember/90">{terminalGenerationFailureMessage}</p>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {isGenerationProcessing
              ? Array.from({ length: Math.max(1, quantity) }).map((_, index) => (
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
      </div>
      <GeneratedImageLightbox image={selectedPreviewImage} onClose={() => setSelectedPreviewImage(null)} />
    </AppFrame>
  );
}

function GenerationProcessingPlaceholder({
  index,
  processingAspectRatio
}: {
  index: number;
  processingAspectRatio: string;
}) {
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
      <div className="relative flex h-full flex-col items-center justify-center px-5 text-center">
        <span className="relative inline-flex size-14 items-center justify-center rounded-full border border-mint/36 bg-mint/10 text-mint shadow-glow">
          <span className="absolute inset-0 rounded-full border border-mint/40 motion-safe:animate-ping motion-reduce:hidden" />
          <Sparkles className="size-6" aria-hidden="true" />
        </span>
        <p className="mt-4 text-sm font-semibold text-white">正在生成</p>
        <p className="mt-1 max-w-48 text-xs leading-5 text-white/56">AI 正在构图、上色并输出图片</p>
        <div className="mt-5 h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full w-1/2 rounded-full bg-gradient-to-r from-mint via-cyanx to-volt motion-safe:animate-pulse" />
        </div>
      </div>
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择图片。"));
    reader.readAsDataURL(file);
  });
}

function generationFailureMessage(task: Task): string {
  const baseMessage = task.failureMessage ?? "生成未成功，请调整提示词或稍后重试。";
  const refundedCredits = task.refundedCredits ?? 0;
  if (refundedCredits > 0) {
    if (baseMessage.includes("自动返还")) {
      return `${baseMessage.replace(/。$/, "")}（${formatCredits(refundedCredits)}）。`;
    }
    return `${baseMessage} 已自动返还 ${formatCredits(refundedCredits)}。`;
  }
  return `${baseMessage} 如已扣除积分，系统会自动补偿，请稍后刷新余额。`;
}

function generationWaitTimeoutMessage(task: Task | null): string {
  if (task?.status === "PENDING") {
    return "任务已提交，但当前仍在排队。系统会继续处理，若队列超时会自动返还积分，可稍后到历史记录查看结果。";
  }
  if (task?.status === "RUNNING") {
    return "任务已提交，模型仍在生成中。真实生图可能需要数分钟，完成后会出现在历史记录里。";
  }
  return "任务已提交，生成仍在处理中。稍后可到历史记录查看结果，系统失败会自动返还积分。";
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
  return error instanceof Error ? error.message : "生成失败，请稍后重试。";
}
