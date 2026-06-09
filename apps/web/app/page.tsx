"use client";

import { useMemo, useState } from "react";
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

type StyleOption = {
  id: string;
  name: string;
  label: string;
  description: string;
  cost: number;
  artClass: string;
  accentClass: string;
};

type Quality = "Draft" | "Studio" | "Ultra";

const styleOptions: StyleOption[] = [
  {
    id: "cinematic",
    name: "Cinematic",
    label: "写实电影",
    description: "镜头光、景深和强叙事画面",
    cost: 8,
    artClass: "art-cinematic",
    accentClass: "from-ember to-cyanx"
  },
  {
    id: "product",
    name: "Product",
    label: "产品摄影",
    description: "电商主图、材质和棚拍质感",
    cost: 7,
    artClass: "art-product",
    accentClass: "from-mint to-cyanx"
  },
  {
    id: "anime",
    name: "Anime",
    label: "动漫插画",
    description: "角色视觉、封面和社媒头像",
    cost: 6,
    artClass: "art-anime",
    accentClass: "from-plasma to-cyanx"
  },
  {
    id: "poster",
    name: "Poster",
    label: "海报设计",
    description: "活动视觉、标题空间和高对比",
    cost: 9,
    artClass: "art-poster",
    accentClass: "from-volt to-ember"
  },
  {
    id: "architecture",
    name: "Architecture",
    label: "空间概念",
    description: "室内、建筑、展陈和光影结构",
    cost: 8,
    artClass: "art-architecture",
    accentClass: "from-cyanx to-ember"
  },
  {
    id: "isometric",
    name: "Isometric",
    label: "等距图形",
    description: "应用插图、流程图和品牌素材",
    cost: 5,
    artClass: "art-isometric",
    accentClass: "from-plasma to-volt"
  }
];

const galleryItems = [
  {
    title: "Neon market alley",
    style: "Cinematic",
    prompt: "雨夜赛博巷道，霓虹反射，35mm 电影镜头",
    cost: 16,
    artClass: "art-cinematic"
  },
  {
    title: "Ceramic headphones",
    style: "Product",
    prompt: "白瓷无线耳机，薄荷色光带，干净棚拍",
    cost: 14,
    artClass: "art-product"
  },
  {
    title: "Solar courier",
    style: "Anime",
    prompt: "未来城市信使，明亮发光披风，动画封面",
    cost: 12,
    artClass: "art-anime"
  },
  {
    title: "Festival launch key art",
    style: "Poster",
    prompt: "音乐节主视觉，撞色几何，留出标题版位",
    cost: 18,
    artClass: "art-poster"
  },
  {
    title: "Coastal studio interior",
    style: "Architecture",
    prompt: "海边创作工作室，玻璃立面，晨光进入空间",
    cost: 16,
    artClass: "art-architecture"
  },
  {
    title: "Creator workflow map",
    style: "Isometric",
    prompt: "AI 创作流程等距插图，节点清晰，活力配色",
    cost: 10,
    artClass: "art-isometric"
  }
];

const promptExamples = [
  "A cinematic product shot of a translucent smart camera on a wet obsidian table, mint rim light, high detail",
  "A bold event poster for an underground synth festival, orange typography space, vivid geometric shapes",
  "An isometric creator dashboard with image tiles, credit ledger, queue status, clean dark UI",
  "A cozy futuristic studio overlooking the coast, glass walls, modular furniture, early sunrise",
  "A stylized anime character designing holographic fashion, energetic pose, saturated highlights"
];

const pricingPlans = [
  {
    name: "Starter",
    price: "$9",
    credits: "220 credits",
    note: "适合灵感探索",
    highlight: false,
    features: ["约 27 张标准写实图", "生成历史保留 30 天", "低清下载与收藏"]
  },
  {
    name: "Creator",
    price: "$19",
    credits: "620 credits",
    note: "多数创作者的起点",
    highlight: true,
    features: ["约 77 张标准写实图", "高清下载", "失败任务自动退还积分"]
  },
  {
    name: "Studio",
    price: "$49",
    credits: "1,850 credits",
    note: "适合小团队和电商运营",
    highlight: false,
    features: ["并发生成队列", "商用素材工作流", "优先任务处理"]
  }
];

const qualityMultiplier: Record<Quality, number> = {
  Draft: 0.7,
  Studio: 1,
  Ultra: 1.65
};

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
  const [selectedStyle, setSelectedStyle] = useState(styleOptions[0]);
  const [quality, setQuality] = useState<Quality>("Studio");
  const [quantity, setQuantity] = useState(2);
  const [prompt, setPrompt] = useState(promptExamples[0]);

  const creditCost = useMemo(() => {
    return Math.ceil(selectedStyle.cost * qualityMultiplier[quality] * quantity);
  }, [quality, quantity, selectedStyle]);

  return (
    <main className="min-h-screen bg-ink text-white">
      <header className="fixed left-0 right-0 top-0 z-50 px-4 pt-4">
        <nav className="mx-auto flex max-w-7xl items-center justify-between rounded-full border border-white/15 bg-ink/76 px-4 py-3 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <a className="focus-ring flex items-center gap-3 rounded-full" href="#top" aria-label="Imagora">
            <span className="flex size-10 items-center justify-center rounded-full bg-white text-ink">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <span className="text-lg font-semibold">Imagora</span>
          </a>

          <div className="hidden items-center gap-1 md:flex">
            {["Gallery", "Styles", "Prompts", "Pricing"].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="focus-ring rounded-full px-4 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
              >
                {item}
              </a>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <a
              className="focus-ring inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white/78 transition-colors duration-200 hover:bg-white/10 hover:text-white"
              href="#signin"
            >
              <LogIn className="size-4" aria-hidden="true" />
              Sign in
            </a>
            <a
              className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
              href="#generator"
            >
              <UserPlus className="size-4" aria-hidden="true" />
              Start free
            </a>
          </div>

          <button
            className="focus-ring inline-flex size-10 items-center justify-center rounded-full border border-white/15 bg-white/8 text-white transition-colors duration-200 hover:bg-white/14 md:hidden"
            type="button"
            aria-label={menuOpen ? "关闭导航" : "打开导航"}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </button>
        </nav>

        {menuOpen ? (
          <div className="mx-auto mt-2 max-w-7xl rounded-3xl border border-white/15 bg-ink/94 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl md:hidden">
            {["Gallery", "Styles", "Prompts", "Pricing"].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="focus-ring flex rounded-2xl px-4 py-3 text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                onClick={() => setMenuOpen(false)}
              >
                {item}
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <section id="top" className="hero-shell flex items-center px-4 pt-24">
        <div className="preview-stage" aria-hidden="true">
          {stageClasses.map((className) => (
            <div key={className} className={`stage-card ${className}`} />
          ))}
        </div>

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center py-16 text-center sm:py-20">
          <div className="mb-6 inline-flex max-w-full items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white/78 backdrop-blur-xl">
            <Moon className="size-4 text-mint" aria-hidden="true" />
            Dark workspace for prompt driven image production
          </div>
          <h1 className="max-w-5xl text-balance text-5xl font-semibold leading-[1.04] sm:text-6xl lg:text-7xl">
            Imagora turns sharp prompts into ready to use visual assets.
          </h1>
          <p className="mt-6 max-w-3xl text-pretty text-base leading-8 text-white/74 sm:text-lg">
            面向创作者、电商运营和内容团队的 AI 图片生成平台。风格、比例、数量、质量和积分消耗在提交前讲清楚，别让用户生成完才发现额度没了。
          </p>

          <div id="generator" className="glass-panel accent-border mt-9 w-full max-w-4xl rounded-[2rem] p-3 text-left">
            <label className="sr-only" htmlFor="prompt">
              Prompt
            </label>
            <div className="flex flex-col gap-3 md:flex-row">
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="focus-ring min-h-28 flex-1 resize-none rounded-[1.35rem] border border-white/12 bg-black/34 px-5 py-4 text-base leading-7 text-white placeholder:text-white/40"
                maxLength={420}
                placeholder="Describe the image you want to generate..."
              />
              <div className="flex min-w-0 flex-col justify-between rounded-[1.35rem] border border-white/12 bg-white/8 p-4 md:w-64">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="rounded-2xl bg-black/28 px-3 py-2 text-white/64">Style</span>
                  <span className="rounded-2xl bg-black/28 px-3 py-2 font-medium text-white">{selectedStyle.name}</span>
                  <span className="rounded-2xl bg-black/28 px-3 py-2 text-white/64">Quality</span>
                  <span className="rounded-2xl bg-black/28 px-3 py-2 font-medium text-white">{quality}</span>
                  <span className="rounded-2xl bg-black/28 px-3 py-2 text-white/64">Images</span>
                  <span className="rounded-2xl bg-black/28 px-3 py-2 font-medium text-white">{quantity}</span>
                </div>
                <a
                  href="#gallery"
                  className="focus-ring mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
                >
                  <Wand2 className="size-4" aria-hidden="true" />
                  Generate preview
                </a>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
              <div className="flex flex-wrap gap-2">
                {(["Draft", "Studio", "Ultra"] as Quality[]).map((item) => (
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
                    {item}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-full border border-white/12 bg-black/28 px-4 py-2 text-sm text-white/78">
                <span className="inline-flex items-center gap-2">
                  <Coins className="size-4 text-volt" aria-hidden="true" />
                  {creditCost} credits
                </span>
                <span className="h-4 w-px bg-white/18" aria-hidden="true" />
                <span>Balance 1,240</span>
              </div>
            </div>
          </div>
        </div>
      </section>

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

      <section id="gallery" className="px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="Generation Preview Gallery"
            title="A gallery that sells the outcome, not the model name."
            description="精选案例配置化展示，包含提示词摘要、风格标签和积分成本，贴合首页 FR-001/FR-002 以及图片列表性能要求。"
          />

          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {galleryItems.map((item) => (
              <article
                key={item.title}
                className="group rounded-[1.35rem] border border-white/12 bg-white/7 p-3 transition-colors duration-200 hover:border-white/24 hover:bg-white/10"
              >
                <div className={`gallery-art ${item.artClass}`} role="img" aria-label={`${item.title} preview`} />
                <div className="space-y-4 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-lg font-semibold text-white">{item.title}</h3>
                      <p className="mt-1 text-sm text-white/58">{item.style}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm text-volt">{item.cost} cr</span>
                  </div>
                  <p className="line-clamp-2 min-h-12 text-sm leading-6 text-white/68">{item.prompt}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                    >
                      <Download className="size-4" aria-hidden="true" />
                      Download
                    </button>
                    <button
                      type="button"
                      className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    >
                      <Heart className="size-4" aria-hidden="true" />
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setPrompt(item.prompt)}
                      className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Reuse
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="styles" className="border-y border-white/10 bg-white/[0.035] px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="Style Options"
            title="Structured style choices keep prompts powerful without making users hand-roll parameters."
            description="覆盖写实、插画、动漫、产品摄影、海报和空间概念，满足需求文档 FR-012，同时让积分预估可解释。"
          />

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {styleOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selectedStyle.id === item.id}
                onClick={() => setSelectedStyle(item)}
                className={`focus-ring group min-h-56 rounded-[1.35rem] border p-4 text-left transition-colors duration-200 ${
                  selectedStyle.id === item.id
                    ? "border-mint bg-mint/12"
                    : "border-white/12 bg-white/7 hover:border-white/24 hover:bg-white/10"
                }`}
              >
                <div className={`gallery-art ${item.artClass} min-h-28`} role="img" aria-label={`${item.label} style preview`} />
                <div className="mt-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-white/58">{item.name}</p>
                    <h3 className="mt-1 text-xl font-semibold text-white">{item.label}</h3>
                  </div>
                  <span className={`shrink-0 rounded-full bg-gradient-to-r ${item.accentClass} px-3 py-1 text-sm font-semibold text-ink`}>
                    {item.cost} cr
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-white/68">{item.description}</p>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section id="prompts" className="px-4 py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-white/70">
              <Sparkles className="size-4 text-plasma" aria-hidden="true" />
              Prompt Examples
            </p>
            <h2 className="mt-5 text-3xl font-semibold leading-tight text-white sm:text-5xl">
              Prompt samples that map directly into the generation form.
            </h2>
            <p className="mt-5 text-base leading-8 text-white/68">
              文档说得很直白：别让用户一上来就被高级参数吓到。示例 Prompt 可以直接填入输入框，并保留风格、数量、质量和积分估算。
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
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-ink">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-7 text-white/74 group-hover:text-white">{item}</span>
                <ArrowRight className="mt-2 size-4 shrink-0 text-white/44 group-hover:text-mint" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-white/[0.035] px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="MVP Flow"
            title="The landing page hints at the real product workflow."
            description="生成入口、积分预估、队列状态、失败退还和资产操作都在前台语言中露出，后续接 API 时不用推翻交互。"
          />

          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <FlowCard icon={Palette} title="Prompt + Style" text="提示词、负向提示词、风格和比例结构化，不把一切塞进一段文本。" />
            <FlowCard icon={Coins} title="Quote Credits" text="提交前预估积分，余额不足就引导购买，前端价格不作为真实扣费依据。" />
            <FlowCard icon={Gauge} title="Async Queue" text="任务排队、生成中、成功、失败状态清晰，HTTP 请求不直接等模型。" />
            <FlowCard icon={ShieldCheck} title="Refund + Safety" text="违规不扣分，系统失败触发退款补偿，内容安全事件可追踪。" />
          </div>
        </div>
      </section>

      <section id="pricing" className="px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="Credit Based Pricing"
            title="Credits are the business model, so the pricing cannot be vague."
            description="套餐围绕积分、有效权益和失败退款说明展开，承接需求 FR-034 到 FR-038。"
          />

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {pricingPlans.map((plan) => (
              <article
                key={plan.name}
                className={`rounded-[1.5rem] border p-6 ${
                  plan.highlight
                    ? "accent-border relative border-mint bg-mint/12 shadow-glow"
                    : "border-white/12 bg-white/7"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-2xl font-semibold text-white">{plan.name}</h3>
                    <p className="mt-2 text-sm text-white/58">{plan.note}</p>
                  </div>
                  {plan.highlight ? (
                    <span className="rounded-full bg-mint px-3 py-1 text-sm font-semibold text-ink">Popular</span>
                  ) : null}
                </div>
                <div className="mt-8 flex items-end gap-3">
                  <span className="text-5xl font-semibold text-white">{plan.price}</span>
                  <span className="pb-2 text-white/58">/ pack</span>
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
                <a
                  href="#generator"
                  className={`focus-ring mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-colors duration-200 ${
                    plan.highlight ? "bg-mint text-ink hover:bg-volt" : "bg-white text-ink hover:bg-mint"
                  }`}
                >
                  Choose {plan.name}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 pb-8">
        <div className="mx-auto max-w-7xl rounded-[2rem] border border-white/12 bg-white/7 p-6 sm:p-10">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p className="text-sm text-white/58">Imagora MVP</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-5xl">
                Start with the landing page, keep the architecture ready for the full generation loop.
              </h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href="#generator"
                className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
              >
                <Play className="size-4" aria-hidden="true" />
                Try prompt
              </a>
              <a
                href="#pricing"
                className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/14 px-5 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-white/10"
              >
                <Layers className="size-4" aria-hidden="true" />
                View credits
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 px-4 py-8 text-sm text-white/52">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p>Imagora - AI image generation platform</p>
          <p>Built from the MVP landing milestone in the development checkpoint plan.</p>
        </div>
      </footer>
    </main>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
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

function FlowCard({
  icon: Icon,
  title,
  text
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}) {
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
