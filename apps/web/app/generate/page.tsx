"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Coins, ImagePlus, X, Wand2 } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  getStoredToken,
  loginDemo,
  setStoredToken,
  waitForTask,
  type CreditAccount,
  type GeneratedImage,
  type ReferenceImage,
  type Task
} from "../../lib/api";

const styles = [
  { value: "realistic", label: "写实" },
  { value: "illustration", label: "插画" },
  { value: "anime", label: "动漫" },
  { value: "product_photography", label: "产品摄影" },
  { value: "poster", label: "海报" }
];

const qualityOptions = [
  { value: "draft", label: "草稿" },
  { value: "standard", label: "标准" },
  { value: "high", label: "高清" }
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
  const searchParams = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("半透明智能相机的电影感产品摄影，薄荷色轮廓光，黑色台面，高细节");
  const [negativePrompt, setNegativePrompt] = useState("低质量、模糊、水印、变形");
  const [style, setStyle] = useState("product_photography");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quantity, setQuantity] = useState(2);
  const [quality, setQuality] = useState("standard");
  const [quote, setQuote] = useState(0);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);

  useEffect(() => {
    const stored = getStoredToken();
    if (stored) {
      setToken(stored);
      loadAccount(stored);
    }
  }, []);

  useEffect(() => {
    const promptFromHistory = searchParams.get("prompt");
    if (promptFromHistory) {
      setPrompt(promptFromHistory);
    }
  }, [searchParams]);

  useEffect(() => {
    const current = token;
    if (!current) {
      return;
    }
    apiFetch<{ creditCost: number }>("/api/generation/quote", {
      method: "POST",
      token: current,
      body: { prompt, negativePrompt, style, aspectRatio, quantity, quality, referenceImageId: referenceImage?.id }
    })
      .then((result) => setQuote(result.creditCost))
      .catch(() => setQuote(0));
  }, [aspectRatio, negativePrompt, prompt, quality, quantity, referenceImage?.id, style, token]);

  async function ensureToken(): Promise<string> {
    if (token) {
      return token;
    }
    const result = await loginDemo();
    setStoredToken(result.token);
    setToken(result.token);
    await loadAccount(result.token);
    return result.token;
  }

  async function loadAccount(currentToken: string) {
    const result = await apiFetch<{ account: CreditAccount }>("/api/users/me/credits", { token: currentToken });
    setAccount(result.account);
  }

  async function uploadReference(file: File) {
    setUploadingReference(true);
    setMessage("");
    try {
      const currentToken = await ensureToken();
      const dataUrl = await readFileAsDataUrl(file);
      const result = await apiFetch<{ referenceImage: ReferenceImage; duplicate: boolean }>("/api/uploads/reference-images", {
        method: "POST",
        token: currentToken,
        body: {
          fileName: file.name,
          mimeType: file.type,
          contentBase64: dataUrl.split(",")[1] ?? ""
        }
      });
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
      const currentToken = await ensureToken();
      const created = await apiFetch<{ task: Task; balanceAfter: number }>("/api/generation/tasks", {
        method: "POST",
        token: currentToken,
        body: {
          clientRequestId: crypto.randomUUID(),
          prompt,
          negativePrompt,
          referenceImageId: referenceImage?.id,
          style,
          aspectRatio,
          quantity,
          quality
        }
      });
      setTask(created.task);
      setAccount((value) => (value ? { ...value, balance: created.balanceAfter } : value));
      const result = await waitForTask(currentToken, created.task.id);
      setTask(result.task);
      setImages(result.images);
      await loadAccount(currentToken);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppFrame title="图片生成" subtitle="配置提示词、参考图、风格、比例、数量和质量，并在提交前确认预计积分消耗。">
      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <Panel>
          <div className="space-y-5">
            <label className="block text-sm text-white/70">
              提示词
              <textarea
                className="focus-ring mt-2 min-h-36 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label className="block text-sm text-white/70">
              负向提示词
              <input
                className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                value={negativePrompt}
                onChange={(event) => setNegativePrompt(event.target.value)}
              />
            </label>
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
                      {referenceImage.width ?? "-"} × {referenceImage.height ?? "-"} · {Math.ceil(referenceImage.fileSize / 1024)} KB
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
                      if (file) {
                        void uploadReference(file);
                      }
                    }}
                  />
                  {uploadingReference ? "上传中..." : "上传 JPG、PNG 或 WebP 格式图片"}
                </label>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-white/70">
                风格
                <select className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white" value={style} onChange={(event) => setStyle(event.target.value)}>
                  {styles.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-white/70">
                画面比例
                <select className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                  {["1:1", "3:4", "4:3", "9:16", "16:9"].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
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
              <label className="block text-sm text-white/70">
                生成质量
                <select className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white" value={quality} onChange={(event) => setQuality(event.target.value)}>
                  {qualityOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/12 bg-black/24 p-4">
              <span className="inline-flex items-center gap-2 text-sm text-white/72">
                <Coins className="size-4 text-volt" aria-hidden="true" />
                预计消耗：{quote ? formatCredits(quote) : "登录后计算"}
              </span>
              <span className="text-sm text-white/72">当前余额：{account ? formatCredits(account.balance) : "未登录"}</span>
            </div>
            {message ? <p className="rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{message}</p> : null}
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
          {task?.failureMessage ? <p className="mb-4 rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{task.failureMessage}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {images.map((image) => (
              <img key={image.id} className="aspect-square w-full rounded-2xl border border-white/12 object-cover" src={image.publicUrl} alt="生成图片结果" />
            ))}
            {images.length === 0 ? <div className="flex min-h-80 items-center justify-center rounded-2xl border border-dashed border-white/14 text-sm text-white/50">生成结果会显示在这里</div> : null}
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
