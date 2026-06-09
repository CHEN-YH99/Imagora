"use client";

import { useEffect, useState } from "react";
import { Coins, Wand2 } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  getStoredToken,
  loginDemo,
  setStoredToken,
  waitForTask,
  type CreditAccount,
  type GeneratedImage,
  type Task
} from "../../lib/api";

const styles = [
  { value: "realistic", label: "写实" },
  { value: "illustration", label: "插画" },
  { value: "anime", label: "动漫" },
  { value: "product_photography", label: "产品摄影" },
  { value: "poster", label: "海报" }
];

export default function GeneratePage() {
  const [token, setToken] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("A cinematic product shot of a translucent smart camera, mint rim light");
  const [negativePrompt, setNegativePrompt] = useState("low quality, blurry, watermark");
  const [style, setStyle] = useState("product_photography");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quantity, setQuantity] = useState(2);
  const [quality, setQuality] = useState("standard");
  const [quote, setQuote] = useState(0);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = getStoredToken();
    if (stored) {
      setToken(stored);
      loadAccount(stored);
    }
  }, []);

  useEffect(() => {
    const current = token;
    if (!current) {
      return;
    }
    apiFetch<{ creditCost: number }>("/api/generation/quote", {
      method: "POST",
      token: current,
      body: { prompt, negativePrompt, style, aspectRatio, quantity, quality }
    })
      .then((result) => setQuote(result.creditCost))
      .catch(() => setQuote(0));
  }, [aspectRatio, negativePrompt, prompt, quality, quantity, style, token]);

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
      setMessage(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppFrame title="Generate Images" subtitle="结构化参数、积分预估、异步状态和结果网格都在这里，别再让用户手搓一大串玄学 prompt。">
      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <Panel>
          <div className="space-y-5">
            <label className="block text-sm text-white/70">
              Prompt
              <textarea
                className="focus-ring mt-2 min-h-36 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label className="block text-sm text-white/70">
              Negative prompt
              <input
                className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
                value={negativePrompt}
                onChange={(event) => setNegativePrompt(event.target.value)}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-white/70">
                Style
                <select className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white" value={style} onChange={(event) => setStyle(event.target.value)}>
                  {styles.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-white/70">
                Aspect ratio
                <select className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                  {["1:1", "3:4", "4:3", "9:16", "16:9"].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-white/70">
                Quantity
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
                Quality
                <select className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white" value={quality} onChange={(event) => setQuality(event.target.value)}>
                  <option value="draft">Draft</option>
                  <option value="standard">Standard</option>
                  <option value="high">High</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/12 bg-black/24 p-4">
              <span className="inline-flex items-center gap-2 text-sm text-white/72">
                <Coins className="size-4 text-volt" aria-hidden="true" />
                Estimated cost: {quote || "login to quote"} credits
              </span>
              <span className="text-sm text-white/72">Balance: {account?.balance ?? "not signed in"}</span>
            </div>
            {message ? <p className="rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{message}</p> : null}
            <button
              className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
              type="button"
              disabled={loading || !prompt.trim()}
              onClick={submit}
            >
              <Wand2 className="size-4" aria-hidden="true" />
              {loading ? "Generating..." : "Generate"}
            </button>
          </div>
        </Panel>

        <Panel>
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Task result</h2>
            <StatusPill>{task?.status ?? "IDLE"}</StatusPill>
          </div>
          {task?.failureMessage ? <p className="mb-4 rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">{task.failureMessage}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {images.map((image) => (
              <img key={image.id} className="aspect-square w-full rounded-2xl border border-white/12 object-cover" src={image.publicUrl} alt="Generated image result" />
            ))}
            {images.length === 0 ? <div className="flex min-h-80 items-center justify-center rounded-2xl border border-dashed border-white/14 text-sm text-white/50">Generated images will appear here</div> : null}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}
