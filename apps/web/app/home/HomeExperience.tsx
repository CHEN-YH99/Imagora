"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Coins,
  Copy,
  Download,
  Heart,
  Layers,
  LogIn,
  Menu,
  Play,
  RefreshCw,
  Sparkles,
  UserPlus,
  X
} from "lucide-react";
import { getCurrentUser, peekCurrentUser } from "../../lib/api";
import { HomeGenerator } from "./HomeGenerator";
import type { HomePromptPreset } from "./HomePromptInput";
import { SectionHeading } from "./HomeSectionHeading";
import { galleryItems, pricingPlans, promptExamples } from "./homeContent";

interface Props {
  heroBackdrop: ReactNode;
  heroIntro: ReactNode;
  workflow: ReactNode;
  footer: ReactNode;
}

export function HomeExperience({ heroBackdrop, heroIntro, workflow, footer }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [promptPreset, setPromptPreset] = useState<HomePromptPreset | null>(null);

  useEffect(() => {
    const cachedUser = peekCurrentUser();
    if (cachedUser !== undefined) {
      setIsLoggedIn(Boolean(cachedUser));
    }

    getCurrentUser()
      .then((user) => {
        setIsLoggedIn(Boolean(user));
      })
      .catch(() => {
        if (cachedUser === undefined) {
          setIsLoggedIn(false);
        }
      });
  }, []);

  function switchToManualPrompt(nextPrompt: string) {
    setPromptPreset((previous) => ({ value: nextPrompt, revision: (previous?.revision ?? 0) + 1 }));
  }

  function applyPromptPreset(nextPrompt: string) {
    switchToManualPrompt(nextPrompt);
    window.scrollTo({ top: 0, behavior: "smooth" });
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

          <div className="hidden items-center gap-2 md:flex">
            {isLoggedIn ? (
              <Link
                className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                href="/generate"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                进入工作台
              </Link>
            ) : (
              <>
                <Link
                  className="focus-ring inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white/78 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                  href="/login"
                >
                  <LogIn className="size-4" aria-hidden="true" />
                  登录
                </Link>
                <Link
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                  href="/register"
                >
                  <UserPlus className="size-4" aria-hidden="true" />
                  注册
                </Link>
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

        {menuOpen ? (
          <div className="mx-auto mt-2 max-w-7xl rounded-3xl border border-white/15 bg-ink/94 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl md:hidden">
            {[
              { id: "gallery", label: "案例" },
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
                <Link
                  href="/generate"
                  className="focus-ring flex rounded-2xl px-4 py-3 font-semibold text-mint transition-colors duration-200 hover:bg-white/10"
                  onClick={() => setMenuOpen(false)}
                >
                  进入工作台
                </Link>
              ) : (
                <>
                  <Link
                    href="/login"
                    className="focus-ring flex rounded-2xl px-4 py-3 text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    onClick={() => setMenuOpen(false)}
                  >
                    登录
                  </Link>
                  <Link
                    href="/register"
                    className="focus-ring flex rounded-2xl px-4 py-3 font-semibold text-mint transition-colors duration-200 hover:bg-white/10"
                    onClick={() => setMenuOpen(false)}
                  >
                    免费注册
                  </Link>
                </>
              )}
            </div>
          </div>
        ) : null}
      </header>

      {/* ── Hero ── */}
      <section id="top" className="hero-shell flex items-center px-4 pt-24">
        {heroBackdrop}

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center py-16 text-center sm:py-20">
          {heroIntro}

          {/* Hero CTA */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {isLoggedIn ? (
              <Link
                href="/generate"
                className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-6 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                进入工作台
              </Link>
            ) : (
              <>
                <Link
                  href="/register"
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-6 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt"
                >
                  <UserPlus className="size-4" aria-hidden="true" />
                  免费注册
                </Link>
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

          {/* ── 内嵌 Demo 生成器 ── */}
          <HomeGenerator isLoggedIn={isLoggedIn} onLoginChange={setIsLoggedIn} promptPreset={promptPreset} />
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
                onClick={() => switchToManualPrompt(item)}
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
                    <span className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm text-volt">
                      {item.cost} 积分
                    </span>
                  </div>
                  <p className="line-clamp-2 min-h-12 text-sm leading-6 text-white/68">{item.prompt}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                    >
                      <Download className="size-4" aria-hidden="true" />
                      下载
                    </button>
                    <button
                      type="button"
                      className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    >
                      <Heart className="size-4" aria-hidden="true" />
                      收藏
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPromptPreset(item.prompt)}
                      className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/76 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      复用
                    </button>
                  </div>
                </div>
              </article>
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
              示例提示词围绕主体、环境、光线、构图和用途组织，便于直接复用，也便于进一步调整模型、比例、数量和积分预算。
            </p>
          </div>
          <div className="grid gap-3">
            {promptExamples.map((item, index) => (
              <button
                key={item}
                type="button"
                onClick={() => applyPromptPreset(item)}
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

      {workflow}

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
                  {plan.highlight ? (
                    <span className="rounded-full bg-mint px-3 py-1 text-sm font-semibold text-ink">推荐</span>
                  ) : null}
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
                <Link
                  href={isLoggedIn ? "/generate" : "/register"}
                  className={`focus-ring mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-colors duration-200 ${plan.highlight ? "bg-mint text-ink hover:bg-volt" : "bg-white text-ink hover:bg-mint"}`}
                >
                  {isLoggedIn ? "进入工作台" : `注册使用${plan.name}`}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
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
                <Link
                  href="/generate"
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                >
                  <Sparkles className="size-4" aria-hidden="true" />
                  进入工作台
                </Link>
              ) : (
                <Link
                  href="/register"
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-mint"
                >
                  <Play className="size-4" aria-hidden="true" />
                  免费注册
                </Link>
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

      {footer}
    </main>
  );
}
