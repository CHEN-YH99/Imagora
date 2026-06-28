"use client";

import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Check,
  Coins,
  Copy,
  Download,
  Gauge,
  Heart,
  Layers,
  LogIn,
  Menu,
  Moon,
  Palette,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Wand2,
  X,
  Zap
} from "lucide-react";
import { formatApiErrorMessage, formatCredits, formatStatusLabel } from "../lib/api";

type StyleOption = {
  id: string;
  name: string;
  label: string;
  description: string;
  cost: number;
  artClass: string;
  accentClass: string;
};

type Quality = "1k" | "2k" | "4k";

type ApiImage = {
  id: string;
  publicUrl: string;
  width: number;
  height: number;
};

type ApiTask = {
  id: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "BLOCKED";
  failureMessage: string | null;
};

const modelOptions = [
  { value: "gpt-image-2", label: "GPT Image 2" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
  { value: "seedream-4.5", label: "Seedream 4.5" }
];

const aspectRatioOptions = [
  { value: "1:1", label: "1:1  方形" },
  { value: "3:4", label: "3:4  竖版" },
  { value: "4:3", label: "4:3  横版" },
  { value: "9:16", label: "9:16  手机竖屏" },
  { value: "16:9", label: "16:9  宽屏" }
];

const styleOptions: StyleOption[] = [
  {
    id: "cinematic",
    name: "电影写实",
    label: "电影写实",
    description: "强调镜头语言、景深层次和叙事氛围",
    cost: 8,
    artClass: "art-cinematic",
    accentClass: "from-ember to-cyanx"
  },
  {
    id: "product",
    name: "产品摄影",
    label: "产品摄影",
    description: "适合电商主图、材质表现和棚拍质感",
    cost: 7,
    artClass: "art-product",
    accentClass: "from-mint to-cyanx"
  },
  {
    id: "anime",
    name: "动漫插画",
    label: "动漫插画",
    description: "适合角色视觉、封面图和社媒头像",
    cost: 6,
    artClass: "art-anime",
    accentClass: "from-plasma to-cyanx"
  },
  {
    id: "poster",
    name: "海报设计",
    label: "海报设计",
    description: "适合活动主视觉、标题空间和高对比排版",
    cost: 9,
    artClass: "art-poster",
    accentClass: "from-volt to-ember"
  },
  {
    id: "architecture",
    name: "空间概念",
    label: "空间概念",
    description: "适合室内、建筑、展陈和光影结构方案",
    cost: 8,
    artClass: "art-architecture",
    accentClass: "from-cyanx to-ember"
  },
  {
    id: "isometric",
    name: "等距图形",
    label: "等距图形",
    description: "适合应用插图、流程说明和品牌素材",
    cost: 5,
    artClass: "art-isometric",
    accentClass: "from-plasma to-volt"
  }
];

const galleryItems = [
  { title: "霓虹雨巷", style: "电影写实", prompt: "雨夜赛博巷道，霓虹反射，35mm 电影镜头", cost: 16, artClass: "art-cinematic" },
  { title: "陶瓷质感耳机", style: "产品摄影", prompt: "白瓷无线耳机，薄荷色光带，干净棚拍", cost: 14, artClass: "art-product" },
  { title: "太阳能信使", style: "动漫插画", prompt: "未来城市信使，明亮发光披风，动画封面", cost: 12, artClass: "art-anime" },
  { title: "音乐节主视觉", style: "海报设计", prompt: "音乐节主视觉，撞色几何，留出标题版位", cost: 18, artClass: "art-poster" },
  { title: "海岸创作室", style: "空间概念", prompt: "海边创作工作室，玻璃立面，晨光进入空间", cost: 16, artClass: "art-architecture" },
  { title: "创作流程图", style: "等距图形", prompt: "智能创作流程等距插图，节点清晰，活力配色", cost: 10, artClass: "art-isometric" }
];

const promptExamples = [
  "半透明智能相机置于黑曜石湿润台面，薄荷色轮廓光，高细节产品摄影",
  "地下电子音乐节活动海报，预留橙色标题空间，几何图形鲜明有冲击力",
  "等距视角创作者工作台，包含图片网格、积分账本和队列状态，深色专业界面",
  "面向海岸的未来创作室，玻璃墙、模块化家具，清晨自然光进入室内",
  "动漫风角色正在设计全息服装，姿态有张力，高饱和高光，封面构图"
];

const pricingPlans = [
  {
    name: "入门版",
    price: "9 美元",
    credits: "220 积分",
    note: "适合灵感探索",
    highlight: false,
    features: ["约 27 张标准写实图", "生成历史保留 30 天", "标准下载与收藏管理"]
  },
  {
    name: "创作者版",
    price: "19 美元",
    credits: "620 积分",
    note: "多数创作者的起点",
    highlight: true,
    features: ["约 77 张标准写实图", "高清下载", "失败任务自动退还积分"]
  },
  {
    name: "团队版",
    price: "49 美元",
    credits: "1,850 积分",
    note: "适合小团队和电商运营",
    highlight: false,
    features: ["并发生成队列", "商用素材工作流", "优先任务处理"]
  }
];

const qualityMultiplier: Record<Quality, number> = { "1k": 0.7, "2k": 1, "4k": 1.65 };

const stageClasses = [
  "stage-cinematic",
  "stage-product",
  "stage-anime",
  "stage-poster",
  "stage-architecture",
  "stage-isometric"
];

export default function HomePage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [selectedModel, setSelectedModel] = useState("gpt-image-2");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quality, setQuality] = useState<Quality>("2k");
  const [quantity, setQuantity] = useState(2);
  const [prompt, setPrompt] = useState(promptExamples[0] ?? "");
  const [apiMessage, setApiMessage] = useState("生成服务已就绪，可以提交预览任务。");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<ApiImage[]>([]);
  const [balance, setBalance] = useState(1240);

  useEffect(() => {
    apiFetch<{ user: { id: string } }>("/api/auth/me", { method: "GET" })
      .then(() => setIsLoggedIn(true))
      .catch(() => setIsLoggedIn(false));
  }, []);

  const creditCost = useMemo(() => Math.ceil(8 * qualityMultiplier[quality] * quantity), [quality, quantity]);

  async function handleGenerate() {
    setIsGenerating(true);
    setGeneratedImages([]);
    setApiMessage("正在连接生成服务...");
    try {
      await loginDemo();
      const created = await apiFetch<{ task: ApiTask; balanceAfter: number }>("/api/generation/tasks", {
        method: "POST",
        body: {
          clientRequestId: crypto.randomUUID(),
          prompt,
          negativePrompt: "低质量、模糊、变形、水印",
          style: "realistic",
          aspectRatio,
          quantity,
          quality: mapQuality(quality),
          model: selectedModel
        }
      });
      setBalance(created.balanceAfter);
      setApiMessage(`任务${formatStatusLabel(created.task.status)}，已预留 ${formatCredits(creditCost)}。`);
      const result = await waitForTask(created.task.id);
      if (result.task.status === "SUCCEEDED") {
        setGeneratedImages(result.images);
        setApiMessage(`生成完成，已交付 ${result.images.length} 张图片。`);
      } else {
        setApiMessage(result.task.failureMessage ?? `任务已结束：${formatStatusLabel(result.task.status)}。`);
      }
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="min-h-screen bg-ink text-white">
      {/* ── 顶部导航 ── */}
      <header className="fixed left-0 right-0 top-0 z-50 px-4 pt-4">
        <nav className="mx-auto flex max-w-7xl items-center justify-between rounded-full border border-white/15 bg-ink/76 px-4 py-3 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <a className="focus-ring flex items-center gap-3 rounded-full" href="#top" aria-label="Imagora">
            <span className="flex size-10 items-center justify-center rounded-full bg-white text-ink">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <span className="text-lg font-semibold">Imagora</span>
          </a>

          <div className="hidden items-center gap-1 md:flex">
            {[
              { id: "gallery", label: "案例" },
              { id: "styles", label: "风格" },
              { id: "prompts", label: "提示词" },
              { id: "pricing", label: "套餐" }
            ].map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="focus-ring rounded-full px-4 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
              >
                {item.label}
              </a>
            ))}
          </div>

          {/* 桌面端右侧按钮：已登录→工作台，未登录→登录+注册 */}
          <div className="hidden items-center gap-2 md:flex">
            {isLoggedIn ? (
              <a
                className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                href="/generate"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                进入工作台
              </a>
            ) : (
              <>
                <a
                  className="focus-ring inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white/78 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                  href="/login"
                >
                  <LogIn className="size-4" aria-hidden="true" />
                  登录
                </a>
                <a
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                  href="/register"
                >
                  <UserPlus className="size-4" aria-hidden="true" />
                  注册
                </a>
              </>
            )}
          </div>

          <button
            className="focus-ring inline-flex size-10 items-center justify-center rounded-full border border-white/15 bg-white/8 text-white transition-colors duration-200 hover:bg-white/14 md:hidden"
            type="button"
            aria-label={menuOpen ? "关闭导航" : "打开导航"}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </button>
        </nav>

        {/* 移动端菜单 */}
        {menuOpen ? (
          <div className="mx-auto mt-2 max-w-7xl rounded-3xl border border-white/15 bg-ink/94 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl md:hidden">
            {[
              { id: "gallery", label: "案例" },
              { id: "styles", label: "风格" },
              { id: "prompts", label: "提示词" },
              { id: "pricing", label: "套餐" }
            ].map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="focus-ring flex rounded-2xl px-4 py-3 text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </a>
            ))}
            <div className="mt-2 border-t border-white/10 pt-2">
              {isLoggedIn ? (
                <a
                  href="/generate"
                  className="focus-ring flex rounded-2xl px-4 py-3 font-semibold text-mint transition-colors duration-200 hover:bg-white/10"
                  onClick={() => setMenuOpen(false)}
                >
                  进入工作台
                </a>
              ) : (
                <>
                  <a
                    href="/login"
                    className="focus-ring flex rounded-2xl px-4 py-3 text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    onClick={() => setMenuOpen(false)}
                  >
                    登录
                  </a>
                  <a
                    href="/register"
                    className="focus-ring flex rounded-2xl px-4 py-3 font-semibold text-mint transition-colors duration-200 hover:bg-white/10"
                    onClick={() => setMenuOpen(false)}
                  >
                    免费注册
                  </a>
                </>
              )}
            </div>
          </div>
        ) : null}
      </header>

      {/* ── Hero ── */}
      <section id="top" className="hero-shell flex items-center px-4 pt-24">
        <div className="preview-stage" aria-hidden="true">
          {stageClasses.map((cls) => (
            <div key={cls} className={`stage-card ${cls}`} />
          ))}
        </div>

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center py-16 text-center sm:py-20">
          <div className="mb-6 inline-flex max-w-full items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white/78 backdrop-blur-xl">
            <Moon className="size-4 text-mint" aria-hidden="true" />
            面向商业创意团队的智能图片生产工作台
          </div>
          <h1 className="max-w-5xl text-balance text-5xl font-semibold leading-[1.04] sm:text-6xl lg:text-7xl">
            Imagora 将清晰提示词转化为可交付视觉资产
          </h1>
          <p className="mt-6 max-w-3xl text-pretty text-base leading-8 text-white/74 sm:text-lg">
            面向创作者、电商运营和内容团队，提供风格选择、比例设置、批量生成、质量控制和积分预估，让图片生产流程清晰可控。
          </p>

          {/* Hero CTA：已登录→工作台，未登录→注册+试用 */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {isLoggedIn ? (
              <a
                href="/generate"
                className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-6 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                进入工作台
              </a>
            ) : (
              <>
                <a
                  href="/register"
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-6 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt"
                >
                  <UserPlus className="size-4" aria-hidden="true" />
                  免费注册
                </a>
                <a
                  href="#generator"
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/14 px-6 py-3 font-semibold text-white transition-colors duration-200 hover:bg-white/10"
                >
                  <Play className="size-4" aria-hidden="true" />
                  先试用
                </a>
              </>
            )}
          </div>

          {/* 内嵌生成器 */}
          <div id="generator" className="glass-panel accent-border mt-9 w-full max-w-4xl rounded-[2rem] p-3 text-left">
            <label className="sr-only" htmlFor="prompt">提示词</label>
            <div className="flex flex-col gap-3 md:flex-row">
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="focus-ring min-h-28 flex-1 resize-none rounded-[1.35rem] border border-white/12 bg-black/34 px-5 py-4 text-base leading-7 text-white placeholder:text-white/40"
                maxLength={420}
                placeholder="描述你想生成的图片内容、主体、风格、光线和用途..."
              />
              <div className="flex min-w-0 flex-col justify-between rounded-[1.35rem] border border-white/12 bg-white/8 p-4 md:w-64">
                <div className="flex flex-col gap-2 text-sm">
                  <select
                    className="focus-ring w-full rounded-2xl border border-white/12 bg-black/40 px-3 py-2 text-white"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    aria-label="选择模型"
                  >
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <select
                    className="focus-ring w-full rounded-2xl border border-white/12 bg-black/40 px-3 py-2 text-white"
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                    aria-label="选择比例"
                  >
                    {aspectRatioOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="rounded-2xl bg-black/28 px-3 py-2 text-white/64">数量</span>
                    <span className="flex items-center justify-between rounded-2xl bg-black/28 px-3 py-2 font-medium text-white">
                      <button
                        className="focus-ring rounded-full px-2 text-white/70 hover:bg-white/10 hover:text-white"
                        type="button"
                        aria-label="减少生成数量"
                        onClick={() => setQuantity((v) => Math.max(1, v - 1))}
                      >-</button>
                      {quantity}
                      <button
                        className="focus-ring rounded-full px-2 text-white/70 hover:bg-white/10 hover:text-white"
                        type="button"
                        aria-label="增加生成数量"
                        onClick={() => setQuantity((v) => Math.min(4, v + 1))}
                      >+</button>
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isGenerating || !prompt.trim()}
                  onClick={handleGenerate}
                  className="focus-ring mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Wand2 className="size-4" aria-hidden="true" />
                  {isGenerating ? "生成中..." : "生成预览"}
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
              <div className="flex flex-wrap gap-2">
                {(["1k", "2k", "4k"] as Quality[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={quality === item}
                    onClick={() => setQuality(item)}
                    className={`focus-ring rounded-full border px-4 py-2 text-sm transition-colors duration-200 ${
                      quality === item
                        ? "border-mint bg-mint text-ink"
                        : "border-white/14 bg-white/8 text-white/72 hover:bg-white/14 hover:text-white"
                    }`}
                  >
                    {item.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 rounded-full border border-white/12 bg-black/28 px-4 py-2 text-sm text-white/78">
                <span className="inline-flex items-center gap-2">
                  <Coins className="size-4 text-volt" aria-hidden="true" />
                  {formatCredits(creditCost)}
                </span>
                <span className="h-4 w-px bg-white/18" aria-hidden="true" />
                <span>余额 {balance.toLocaleString("zh-CN")}</span>
              </div>
            </div>

            <div className="mt-3 rounded-[1.25rem] border border-white/12 bg-black/24 p-4">
              <p className="text-sm text-white/70">{apiMessage}</p>
              {generatedImages.length > 0 ? (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {generatedImages.map((image) => (
                      <img
                        key={image.id}
                        src={image.publicUrl}
                        alt="Imagora 生成结果"
                        className="aspect-square w-full rounded-2xl border border-white/12 object-cover"
                        width={image.width}
                        height={image.height}
                      />
                    ))}
                  </div>
                  {/* 生成后引导：未登录时显示注册提示 */}
                  {!isLoggedIn ? (
                    <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-mint/30 bg-mint/8 p-4 text-center sm:flex-row sm:text-left">
                      <div className="flex-1">
                        <p className="font-semibold text-white">注册账号，永久保存这张图</p>
                        <p className="mt-1 text-sm text-white/60">登录用户可查看历史、收藏、下载原图，并获得 120 欢迎积分。</p>
                      </div>
                      <a
                        href="/register"
                        className="focus-ring shrink-0 inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
                      >
                        <UserPlus className="size-4" aria-hidden="true" />
                        免费注册
                      </a>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ── 提示词跑马灯 ── */}
      <section className="border-b border-white/10 px-4 py-8">
        <div className="mx-auto max-w-7xl overflow-hidden">
          <div className="marquee">
            {[...promptExamples, ...promptExamples].map((item, index) => (
              <button
                key={`${item}-${index}`}
                type="button"
                onClick={() => setPrompt(item)}
                className="focus-ring inline-flex max-w-96 items-center gap-3 rounded-full border border-white/12 bg-white/8 px-5 py-3 text-left text-sm text-white/72 transition-colors duration-200 hover:border-mint/60 hover:bg-white/12 hover:text-white"
              >
                <Copy className="size-4 shrink-0 text-cyanx" aria-hidden="true" />
                <span className="truncate">{item}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── 案例展示 ── */}
      <section id="gallery" className="px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="生成案例"
            title="用真实产出展示创意方向和交付质量"
            description="精选案例呈现提示词摘要、风格标签和积分成本，方便快速判断生成方向、复用表达方式，并规划后续创作预算。"
          />
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {galleryItems.map((item) => (
              <article
                key={item.title}
                className="group rounded-[1.35rem] border border-white/12 bg-white/7 p-3 transition-colors duration-200 hover:border-white/24 hover:bg-white/10"
              >
                <div className={`gallery-art ${item.artClass}`} role="img" aria-label={`${item.title}预览`} />
                <div className="space-y-4 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-lg font-semibold text-white">{item.title}</h3>
                      <p className="mt-1 text-sm text-white/58">{item.style}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm text-volt">{item.cost} 积分</span>
                  </div>
                  <p className="line-clamp-2 min-h-12 text-sm leading-6 text-white/68">{item.prompt}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint">
                      <Download className="size-4" aria-hidden="true" />下载
                    </button>
                    <button type="button" className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white">
                      <Heart className="size-4" aria-hidden="true" />收藏
                    </button>
                    <button
                      type="button"
                      onClick={() => setPrompt(item.prompt)}
                      className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />复用
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── 风格选择 ── */}
      <section id="styles" className="border-y border-white/10 bg-white/[0.035] px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="风格选择"
            title="结构化风格参数让提示词更稳定"
            description="覆盖写实、插画、动漫、产品摄影、海报和空间概念等常见创作场景，减少重复调参成本，并让积分预估更容易理解。"
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {styleOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                className="focus-ring group min-h-56 rounded-[1.35rem] border border-white/12 bg-white/7 p-4 text-left transition-colors duration-200 hover:border-white/24 hover:bg-white/10"
              >
                <div className={`gallery-art ${item.artClass} min-h-28`} role="img" aria-label={`${item.label}风格预览`} />
                <div className="mt-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-white/58">{item.name}</p>
                    <h3 className="mt-1 text-xl font-semibold text-white">{item.label}</h3>
                  </div>
                  <span className={`shrink-0 rounded-full bg-gradient-to-r ${item.accentClass} px-3 py-1 text-sm font-semibold text-ink`}>
                    {item.cost} 积分
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-white/68">{item.description}</p>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── 提示词示例 ── */}
      <section id="prompts" className="px-4 py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-white/70">
              <Sparkles className="size-4 text-plasma" aria-hidden="true" />
              提示词示例
            </p>
            <h2 className="mt-5 text-3xl font-semibold leading-tight text-white sm:text-5xl">
              可直接进入生成表单的专业提示词
            </h2>
            <p className="mt-5 text-base leading-8 text-white/68">
              示例提示词围绕主体、环境、光线、构图和用途组织，便于直接复用，也便于进一步调整风格、数量、质量和积分预算。
            </p>
          </div>
          <div className="grid gap-3">
            {promptExamples.map((item, index) => (
              <button
                key={item}
                type="button"
                onClick={() => setPrompt(item)}
                className="focus-ring group flex items-start gap-4 rounded-[1.25rem] border border-white/12 bg-white/7 p-4 text-left transition-colors duration-200 hover:border-mint/60 hover:bg-white/10"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-ink">{index + 1}</span>
                <span className="min-w-0 flex-1 text-sm leading-7 text-white/74 group-hover:text-white">{item}</span>
                <ArrowRight className="mt-2 size-4 shrink-0 text-white/44 group-hover:text-mint" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── 流程说明 ── */}
      <section className="border-y border-white/10 bg-white/[0.035] px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="创作流程"
            title="从提示词到资产交付的完整闭环"
            description="生成入口、积分预估、队列状态、失败退还和资产操作都保持清晰，让创作团队能稳定管理每一次图片生产。"
          />
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <FlowCard icon={Palette} title="提示词与风格" text="提示词、负向提示词、风格和比例结构化配置，降低参数管理成本。" />
            <FlowCard icon={Coins} title="积分预估" text="提交前展示预计消耗和账户余额，帮助用户明确预算和生成成本。" />
            <FlowCard icon={Gauge} title="异步队列" text="清晰呈现排队、生成中、完成和失败状态，适合批量图片生产。" />
            <FlowCard icon={ShieldCheck} title="安全与退回" text="安全拦截、系统失败和积分退回可追踪，减少资产生产风险。" />
          </div>
        </div>
      </section>

      {/* ── 套餐定价 ── */}
      <section id="pricing" className="px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="积分套餐"
            title="清晰展示积分、权益和适用场景"
            description="套餐围绕积分额度、下载权益、任务优先级和失败退回机制展示，方便个人创作者和团队按需选择。"
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {pricingPlans.map((plan) => (
              <article
                key={plan.name}
                className={`rounded-[1.5rem] border p-6 ${plan.highlight ? "accent-border relative border-mint bg-mint/12 shadow-glow" : "border-white/12 bg-white/7"}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-2xl font-semibold text-white">{plan.name}</h3>
                    <p className="mt-2 text-sm text-white/58">{plan.note}</p>
                  </div>
                  {plan.highlight ? <span className="rounded-full bg-mint px-3 py-1 text-sm font-semibold text-ink">推荐</span> : null}
                </div>
                <div className="mt-8 flex items-end gap-3">
                  <span className="text-5xl font-semibold text-white">{plan.price}</span>
                  <span className="pb-2 text-white/58">/ 套餐</span>
                </div>
                <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-volt">
                  <Coins className="size-4" aria-hidden="true" />
                  {plan.credits}
                </p>
                <ul className="mt-8 space-y-4">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-3 text-sm leading-6 text-white/72">
                      <Check className="mt-1 size-4 shrink-0 text-mint" aria-hidden="true" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                {/* 套餐按钮：已登录→工作台，未登录→注册 */}
                <a
                  href={isLoggedIn ? "/generate" : "/register"}
                  className={`focus-ring mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-colors duration-200 ${plan.highlight ? "bg-mint text-ink hover:bg-volt" : "bg-white text-ink hover:bg-mint"}`}
                >
                  {isLoggedIn ? "进入工作台" : `注册使用${plan.name}`}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── 底部 CTA ── */}
      <section className="px-4 pb-8">
        <div className="mx-auto max-w-7xl rounded-[2rem] border border-white/12 bg-white/7 p-6 sm:p-10">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p className="text-sm text-white/58">Imagora 工作台</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-5xl">
                开始一次可追踪、可复用的专业图片生成流程
              </h2>
            </div>
            <div className="flex flex-wrap gap-3">
              {isLoggedIn ? (
                <a
                  href="/generate"
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                >
                  <Sparkles className="size-4" aria-hidden="true" />
                  进入工作台
                </a>
              ) : (
                <a
                  href="/register"
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                >
                  <Play className="size-4" aria-hidden="true" />
                  免费注册
                </a>
              )}
              <a
                href="#pricing"
                className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/14 px-5 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-white/10"
              >
                <Layers className="size-4" aria-hidden="true" />
                查看套餐
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 px-4 py-8 text-sm text-white/52">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p>Imagora 智能图片生成平台</p>
          <p>为创作者、电商运营和内容团队提供可管理的图片生产流程。</p>
        </div>
      </footer>
    </main>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="max-w-3xl">
      <p className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-white/70">
        <Zap className="size-4 text-ember" aria-hidden="true" />
        {eyebrow}
      </p>
      <h2 className="mt-5 text-3xl font-semibold leading-tight text-white sm:text-5xl">{title}</h2>
      <p className="mt-5 text-base leading-8 text-white/68">{description}</p>
    </div>
  );
}

function FlowCard({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <article className="rounded-[1.35rem] border border-white/12 bg-white/7 p-5">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-white text-ink">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h3 className="mt-5 text-xl font-semibold text-white">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-white/66">{text}</p>
    </article>
  );
}

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4100";

async function loginDemo(): Promise<void> {
  await apiFetch<{ user: { id: string } }>("/api/auth/login", {
    method: "POST",
    body: { email: "demo@imagora.local", password: "Demo123!" }
  });
}

async function waitForTask(taskId: string): Promise<{ task: ApiTask; images: ApiImage[] }> {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await sleep(1200);
    const result = await apiFetch<{ task: ApiTask; images: ApiImage[] }>(`/api/generation/tasks/${taskId}`, { method: "GET" });
    if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELED"].includes(result.task.status)) {
      return result;
    }
  }
  throw new Error("生成任务等待超时，请稍后在历史记录中查看结果。");
}

async function apiFetch<T>(
  path: string,
  options: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = (await response.json()) as { data?: T; error?: { code?: string; message: string } };
  if (!response.ok || !payload.data) {
    throw new Error(formatApiErrorMessage(payload.error?.code, payload.error?.message, response.status));
  }
  return payload.data;
}

function mapQuality(value: Quality): "draft" | "standard" | "high" {
  switch (value) {
    case "1k": return "draft";
    case "4k": return "high";
    default: return "standard";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
