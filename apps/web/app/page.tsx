import type { LucideIcon } from "lucide-react";
import { Coins, Gauge, Moon, Palette, ShieldCheck } from "lucide-react";
import { HomeExperience } from "./home/HomeExperience";
import { SectionHeading } from "./home/HomeSectionHeading";

const stageClasses = [
  "stage-cinematic",
  "stage-product",
  "stage-anime",
  "stage-poster",
  "stage-architecture",
  "stage-isometric"
];

export default function HomePage() {
  return (
    <HomeExperience
      heroBackdrop={
        <div className="preview-stage" aria-hidden="true">
          {stageClasses.map((cls) => (
            <div key={cls} className={`stage-card ${cls}`} />
          ))}
        </div>
      }
      heroIntro={
        <>
          <div className="mb-6 inline-flex max-w-full items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white/78 backdrop-blur-xl">
            <Moon className="size-4 text-mint" aria-hidden="true" />
            面向商业创意团队的智能图片生产工作台
          </div>
          <h1 className="max-w-5xl text-balance text-5xl font-semibold leading-[1.04] sm:text-6xl lg:text-7xl">
            Imagora 将清晰提示词转化为可交付视觉资产
          </h1>
          <p className="mt-6 max-w-3xl text-pretty text-base leading-8 text-white/74 sm:text-lg">
            面向创作者、电商运营和内容团队，提供模型选择、比例设置、批量生成和积分预估，让图片生产流程清晰可控。
          </p>
        </>
      }
      workflow={
        <section className="border-y border-white/10 bg-white/[0.035] px-4 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="创作流程"
              title="从提示词到资产交付的完整闭环"
              description="生成入口、积分预估、队列状态、失败退还和资产操作都保持清晰，让创作团队能稳定管理每一次图片生产。"
            />
            <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <FlowCard icon={Palette} title="提示词与模型" text="填写提示词，选择模型、比例和张数，快速开始创作。" />
              <FlowCard
                icon={Coins}
                title="积分预估"
                text="提交前展示预计消耗和账户余额，帮助用户明确预算和生成成本。"
              />
              <FlowCard icon={Gauge} title="异步队列" text="清晰呈现排队、生成中、完成和失败状态，适合批量图片生产。" />
              <FlowCard
                icon={ShieldCheck}
                title="安全与退回"
                text="安全拦截、系统失败和积分退回可追踪，减少资产生产风险。"
              />
            </div>
          </div>
        </section>
      }
      footer={
        <footer className="border-t border-white/10 px-4 py-8 text-sm text-white/52">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>Imagora 智能图片生成平台</p>
            <p>为创作者、电商运营和内容团队提供可管理的图片生产流程。</p>
          </div>
        </footer>
      }
    />
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
