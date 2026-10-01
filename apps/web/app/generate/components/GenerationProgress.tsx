"use client";

import { memo, useEffect, useState } from "react";
import { Check, Circle, Clock3, LoaderCircle, Sparkles } from "lucide-react";
import type { GeneratedImage, Task } from "../../../lib/api";
import {
  isTerminalTaskStatus,
  resolveGenerationElapsedSeconds,
  resolveGenerationProgress,
  resolveImageProgressLabel,
  resolveImageProgressStages
} from "../generationState";

export const GenerationTaskActivity = memo(function GenerationTaskActivity({
  task,
  images,
  quantity
}: {
  task: Task | null;
  images: GeneratedImage[];
  quantity: number;
}) {
  const [now, setNow] = useState<number | null>(null);
  const active = Boolean(task && !isTerminalTaskStatus(task.status));
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    if (!active) return;
    const interval = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
    };
  }, [task?.id, active]);

  const progress = resolveGenerationProgress(task, images, quantity);
  const seconds = now === null ? null : resolveGenerationElapsedSeconds(task, now);
  const duration =
    seconds === null
      ? null
      : `${Math.floor(seconds / 60)
          .toString()
          .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <section aria-label="任务进度" className="mb-4 space-y-2 border-b border-white/10 pb-4 text-xs leading-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="font-medium text-mint" role="status">
          {progress.label}
        </p>
        {duration ? (
          <span
            aria-label="任务已用时间"
            aria-live="off"
            className="inline-flex items-center gap-1.5 tabular-nums text-white/60"
          >
            <Clock3 className="size-3.5" aria-hidden="true" />
            {task?.status === "PENDING" ? "已等待" : "已用时"} {duration}
          </span>
        ) : null}
      </div>
      <p className="text-white/60">{progress.detail}</p>
      {active ? (
        <p aria-live="polite" aria-atomic="true" className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-white/75">
          <span>
            {progress.generatedImages === null
              ? "接收数量待同步"
              : `已接收 ${progress.generatedImages} / ${progress.totalImages} 张`}
          </span>
          {progress.savedImages !== null ? (
            <span>
              已保存 {progress.savedImages} / {progress.totalImages} 张
            </span>
          ) : null}
        </p>
      ) : null}
    </section>
  );
});

const stageStateLabels = { pending: "未开始", active: "进行中", complete: "已完成", unknown: "待同步" };

export const GenerationProcessingPlaceholder = memo(function GenerationProcessingPlaceholder({
  index,
  processingAspectRatio,
  task
}: {
  index: number;
  processingAspectRatio: string;
  task: Task | null;
}) {
  const aspectRatioValue = parseAspectRatioValue(processingAspectRatio);
  const isWideFrame = (aspectRatioValue ?? 1) >= 1.5;
  const label = resolveImageProgressLabel(task, index);
  const stages = resolveImageProgressStages(task, index);
  const waiting = stages.every((stage) => stage.state === "pending");
  const processing = stages.some((stage) => stage.state === "active");
  const Icon = waiting ? Clock3 : Sparkles;

  return (
    <div
      aria-label={`第 ${index + 1} 张图片正在生成`}
      className="generation-processing-card relative flex w-full items-center justify-center overflow-hidden rounded-lg"
      data-processing={processing ? "active" : waiting ? "waiting" : "settling"}
      role="status"
      style={{ aspectRatio: processingAspectRatio }}
    >
      <span className="generation-processing-scan" aria-hidden="true" />
      <div className={`relative z-10 w-full max-w-64 px-3 ${isWideFrame ? "py-2" : "py-5"}`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="generation-processing-emblem" aria-hidden="true">
            <Icon className="relative z-10 size-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] leading-4 text-white/55">第 {index + 1} 张</p>
            <p className="break-words text-xs font-medium leading-5 text-white">{label}</p>
          </div>
        </div>
        <ol aria-label="图片处理阶段" className={`grid grid-cols-4 gap-1.5 ${isWideFrame ? "mt-2" : "mt-4"}`}>
          {stages.map(({ label: stageLabel, state }) => {
            const StageIcon = state === "complete" ? Check : state === "active" ? LoaderCircle : Circle;
            const description = `${stageLabel}：${stageStateLabels[state]}`;
            return (
              <li
                key={stageLabel}
                aria-label={description}
                title={description}
                aria-current={state === "active" ? "step" : undefined}
                data-state={state}
                className="generation-stage min-w-0 text-[10px] leading-4"
              >
                <span className="generation-stage-track" aria-hidden="true">
                  <span className="generation-stage-sheen" />
                </span>
                <span className="mt-1.5 flex items-center justify-center gap-1">
                  <StageIcon
                    className={`size-3 shrink-0 ${state === "active" ? "motion-safe:animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  {stageLabel}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
});

function parseAspectRatioValue(value: string): number | null {
  const [widthText, heightText] = value.split("/").map((segment) => segment.trim());
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return width / height;
}
