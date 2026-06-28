"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Coins, ImagePlus, X, Wand2 } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  waitForTask,
  type CreditAccount,
  type GeneratedImage,
  type ReferenceImage,
  type Task
} from "../../lib/api";

const qualityOptions = [
  { value: "draft", label: "1K", desc: "512–768px，速度最快" },
  { value: "standard", label: "2K", desc: "1024px，均衡首选" },
  { value: "high", label: "4K", desc: "最高画质，耗时较长" }
];

const modelOptions = [
  { value: "gpt-image-2", label: "GPT Image 2" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
  { value: "seedream-4.5", label: "Seedream 4.5" }
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
  const [model, setModel] = useState("gpt-image-2");
  const [quote, setQuote] = useState(0);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);

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
    if (m && modelOptions.some((o) => o.value === m)) setModel(m);
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

  async function uploadReference(file: File) {
    setUploadingReference(true);
    setMessage("");
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "参考图上传失败，请重新选择图片。");
    } finally {
      setUploadingReference(false);
    }
  }

  async function submit() {
    setLoading(true);
    setMessage("");
    setImages([]);
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
      setTask(created.task);
      setAccount((value) => (value ? { ...value, balance: created.balanceAfter } : value));
      const result = await waitForTask(created.task.id);
      setTask(result.task);
      setImages(result.images);
      await loadAccount();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
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
                {modelOptions.map((item) => (
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
                  onChange={(event) => setQuantity(Number(event.target.value))}
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
              <p className="rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{message}</p>
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
            <StatusPill>{task?.status ?? "IDLE"}</StatusPill>
          </div>
          {task?.failureMessage ? (
            <p className="mb-4 rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">
              {task.failureMessage}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {images.map((image) => (
              <img
                key={image.id}
                className="aspect-square w-full rounded-2xl border border-white/12 object-cover"
                src={image.publicUrl}
                alt="生成图片结果"
              />
            ))}
            {images.length === 0 ? (
              <div className="flex min-h-80 items-center justify-center rounded-2xl border border-dashed border-white/14 text-sm text-white/50">
                生成结果会显示在这里
              </div>
            ) : null}
          </div>
        </Panel>
      </div>
    </AppFrame>
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
