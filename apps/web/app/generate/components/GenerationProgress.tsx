"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

export const progressTransitionMs = 250;

const GenerationTaskProgress = memo(function GenerationTaskProgress({ percentage }: { percentage: number | null }) {
  const [displayedPercentage, setDisplayedPercentage] = useState(0);
  const displayedPercentageRef = useRef(0);
  const targetPercentage = percentage ?? 0;

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const from = displayedPercentageRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const update = (value: number) => {
      displayedPercentageRef.current = value;
      setDisplayedPercentage(value);
    };
    const animate = (now: number) => {
      const elapsed = reducedMotion.matches ? 1 : Math.min(1, (now - startedAt) / progressTransitionMs);
      update(from + (targetPercentage - from) * elapsed);
      if (elapsed < 1) frame = window.requestAnimationFrame(animate);
    };
    const handleMotionChange = () => {
      if (!reducedMotion.matches) return;
      window.cancelAnimationFrame(frame);
      update(targetPercentage);
    };
    frame = window.requestAnimationFrame(animate);
    reducedMotion.addEventListener("change", handleMotionChange);
    return () => {
      window.cancelAnimationFrame(frame);
      reducedMotion.removeEventListener("change", handleMotionChange);
    };
  }, [targetPercentage]);

  return (
    <div className="mt-2 w-full text-left">
      <div className="flex items-center justify-end text-[10px] leading-4 text-white/64">
        <span className="shrink-0 tabular-nums text-mint">
          {percentage === null ? "—" : `${Math.floor(displayedPercentage)}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="图片生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage ?? undefined}
        aria-valuetext={percentage === null ? "等待进度同步" : `${percentage}%`}
        className="mt-1 h-1 overflow-hidden rounded-full bg-white/10"
      >
        <span
          className="block h-full w-full rounded-full bg-mint"
          style={{ transform: `translateX(${displayedPercentage - 100}%)` }}
        />
      </div>
    </div>
  );
});

export const GenerationProcessingPlaceholder = memo(function GenerationProcessingPlaceholder({
  index,
  processingAspectRatio,
  label,
  percentage
}: {
  index: number;
  processingAspectRatio: string;
  label: string;
  percentage: number | null;
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
      <span className="pointer-events-none absolute inset-x-5 top-3 h-px bg-gradient-to-r from-transparent via-mint/70 to-transparent motion-safe:animate-pulse motion-reduce:opacity-60" />
      <div className={`relative flex h-full items-center justify-center px-5 ${isWideFrame ? "py-3" : "text-center"}`}>
        <div
          className={`flex w-full ${isWideFrame ? "max-w-[17rem] items-center gap-3 text-left" : "max-w-48 flex-col items-center"}`}
        >
          <span
            className={`relative inline-flex items-center justify-center rounded-full border border-mint/36 bg-mint/10 text-mint shadow-glow ${isWideFrame ? "size-9 shrink-0" : "size-14"}`}
          >
            <span className="absolute inset-0 rounded-full border border-mint/40 motion-safe:animate-ping motion-reduce:hidden" />
            <Sparkles className={isWideFrame ? "size-5" : "size-6"} aria-hidden="true" />
          </span>
          <div className={`min-w-0 ${isWideFrame ? "flex-1" : "mt-4 w-full"}`}>
            <p className={`font-semibold text-white ${isWideFrame ? "text-xs leading-4" : "text-sm"}`}>
              {label}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-white/56">第 {index + 1} 张</p>
            <GenerationTaskProgress percentage={percentage} />
          </div>
        </div>
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


