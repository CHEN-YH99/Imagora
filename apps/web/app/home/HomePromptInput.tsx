"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { promptExamples } from "./homeContent";

type PromptLoopPhase = "typing" | "holding" | "deleting";

export type HomePromptPreset = { value: string; revision: number };

interface Props {
  preset: HomePromptPreset | null;
  onPromptChange: (prompt: string) => void;
  onEdit: () => void;
}

export function HomePromptInput({ preset, onPromptChange, onEdit }: Props) {
  const [prompt, setPrompt] = useState("");
  const [promptMode, setPromptMode] = useState<"auto" | "manual">("auto");
  const [promptLoopIndex, setPromptLoopIndex] = useState(0);
  const [promptLoopLength, setPromptLoopLength] = useState(0);
  const [promptLoopPhase, setPromptLoopPhase] = useState<PromptLoopPhase>("typing");
  const activePromptTemplate = promptExamples[promptLoopIndex] ?? promptExamples[0] ?? "";
  const promptValue = promptMode === "auto" ? activePromptTemplate.slice(0, Math.max(promptLoopLength, 0)) : prompt;
  const effectivePrompt = (promptMode === "auto" ? activePromptTemplate : prompt).trim();
  const promptHint =
    promptMode === "auto"
      ? "示例提示词正在自动演示，点一下输入框就能接管编辑。"
      : "当前为手动编辑内容，点击右侧按钮可恢复自动演示。";

  useEffect(() => {
    if (!preset) return;
    setPromptMode("manual");
    setPrompt(preset.value);
    setPromptLoopPhase("typing");
    setPromptLoopLength(0);
    onEdit();
  }, [preset, onEdit]);

  // 只同步完整提示词。逐字显示与删除留在本组件，不触发生成器或页面更新。
  useEffect(() => {
    onPromptChange(effectivePrompt);
  }, [effectivePrompt, onPromptChange]);

  useEffect(() => {
    if (promptMode !== "auto" || !activePromptTemplate) return;

    let timeoutId: ReturnType<typeof setTimeout>;
    if (promptLoopPhase === "typing") {
      if (promptLoopLength < activePromptTemplate.length) {
        timeoutId = setTimeout(() => setPromptLoopLength((current) => current + 1), 42);
      } else {
        timeoutId = setTimeout(() => setPromptLoopPhase("holding"), 1400);
      }
    } else if (promptLoopPhase === "holding") {
      timeoutId = setTimeout(() => setPromptLoopPhase("deleting"), 120);
    } else if (promptLoopLength > 0) {
      timeoutId = setTimeout(() => setPromptLoopLength((current) => Math.max(0, current - 1)), 22);
    } else {
      timeoutId = setTimeout(() => {
        setPromptLoopIndex((current) => (current + 1) % promptExamples.length);
        setPromptLoopPhase("typing");
      }, 240);
    }

    return () => clearTimeout(timeoutId);
  }, [activePromptTemplate, promptLoopLength, promptLoopPhase, promptMode]);

  function switchToManualPrompt() {
    setPromptMode("manual");
    setPrompt(activePromptTemplate);
    setPromptLoopPhase("typing");
    setPromptLoopLength(0);
    onEdit();
  }

  function resumePromptLoop() {
    setPromptMode("auto");
    setPrompt("");
    setPromptLoopLength(0);
    setPromptLoopPhase("typing");
    onEdit();
  }

  return (
    <div className="flex flex-1 flex-col gap-2 md:min-h-full">
      <textarea
        id="prompt"
        value={promptValue}
        onFocus={() => {
          if (promptMode === "auto") switchToManualPrompt();
        }}
        onChange={(event) => {
          if (promptMode === "auto") setPromptMode("manual");
          setPrompt(event.target.value);
          onEdit();
        }}
        className="focus-ring min-h-28 flex-1 resize-none rounded-[1.35rem] border border-white/12 bg-black/34 px-5 py-4 text-base leading-7 text-white placeholder:text-white/40"
        maxLength={420}
        placeholder="描述你想生成的图片内容、主体、风格、光线和用途..."
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="inline-flex items-center gap-2 text-xs text-white/48">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              promptMode === "auto"
                ? "bg-cyanx shadow-[0_0_0_4px_rgba(37,216,255,0.12)]"
                : "bg-mint shadow-[0_0_0_4px_rgba(88,240,182,0.12)]"
            }`}
            aria-hidden="true"
          />
          <span>{promptHint}</span>
        </div>
        {promptMode === "manual" ? (
          <button
            type="button"
            onClick={resumePromptLoop}
            className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/68 transition-colors duration-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            恢复示例演示
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-white/40">
            <span className="inline-block h-4 w-px bg-white/14" aria-hidden="true" />
            <span className="motion-safe:animate-pulse">输入光标</span>
          </span>
        )}
      </div>
    </div>
  );
}
