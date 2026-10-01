"use client";

import { memo } from "react";
import { Copy, Download, RefreshCw } from "lucide-react";
import { EmptyState, Panel, StatusPill } from "../../../components/AppFrame";
import { GeneratedImagePreviewButton } from "../../../components/GeneratedImagePreview";
import type { GeneratedImage, GenerationMetadata, Task } from "../../../lib/api";
import { GenerationProcessingPlaceholder, GenerationTaskActivity } from "./GenerationProgress";

type Props = {
  task: Task | null;
  images: GeneratedImage[];
  quantity: number;
  resultStatus: string;
  terminalGenerationFailureMessage: string;
  isGenerationProcessing: boolean;
  processingPlaceholderCount: number;
  processingAspectRatio: string;
  onPreview(image: GeneratedImage): void;
  downloadImage(image: GeneratedImage): Promise<void>;
  applyGenerationMetadata(metadata: GenerationMetadata, mode: "reuse" | "variation"): void;
  submit(): Promise<void>;
};

export const GenerationResults = memo(function GenerationResults({
  task,
  images,
  quantity,
  resultStatus,
  terminalGenerationFailureMessage,
  isGenerationProcessing,
  processingPlaceholderCount,
  processingAspectRatio,
  onPreview,
  downloadImage,
  applyGenerationMetadata,
  submit
}: Props) {
  return (
    <Panel>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">生成结果</h2>
        <StatusPill>{resultStatus}</StatusPill>
      </div>
      {isGenerationProcessing || task?.status === "SUCCEEDED" ? (
        <GenerationTaskActivity task={task} images={images} quantity={quantity} />
      ) : null}
      {terminalGenerationFailureMessage ? (
        <div className="mb-4 rounded-2xl border border-ember/40 bg-ember/10 p-4">
          <p className="text-sm font-semibold text-ember">生成失败</p>
          <p className="mt-1 text-sm leading-6 text-ember/90">{terminalGenerationFailureMessage}</p>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {isGenerationProcessing
          ? Array.from({ length: processingPlaceholderCount }).map((_, index) => (
              <GenerationProcessingPlaceholder
                key={`生成占位-${task?.id ?? "submitting"}-${index}`}
                index={index}
                processingAspectRatio={processingAspectRatio}
                task={task}
              />
            ))
          : null}
        {(isGenerationProcessing ? [] : images).map((image, index) => (
          <article key={image.id} className="relative overflow-hidden rounded-2xl border border-white/12 bg-black/18">
            <GeneratedImagePreviewButton
              alt="生成图片结果"
              ariaLabel={`预览第 ${index + 1} 张生成图片`}
              className="rounded-none border-0 border-b border-white/10 bg-transparent hover:translate-y-0"
              image={image}
              onOpen={() => onPreview(image)}
            />
            <button
              className="focus-ring group/download absolute right-3 top-3 z-10 inline-flex size-9 items-center justify-center rounded-full border border-white/16 bg-ink/70 text-white/80 backdrop-blur-md transition duration-200 motion-reduce:transform-none motion-reduce:transition-none hover:-translate-y-0.5 hover:scale-105 hover:border-mint/70 hover:bg-ink/85 hover:text-mint hover:shadow-glow"
              type="button"
              aria-label={`下载第 ${index + 1} 张生成图片`}
              title="下载图片"
              onClick={() => void downloadImage(image)}
            >
              <Download
                className="size-4 transition-transform duration-200 motion-reduce:transform-none group-hover/download:translate-y-0.5"
                aria-hidden="true"
              />
            </button>
            <div className="space-y-3 p-3">
              <dl className="grid gap-2 text-xs text-white/52 sm:grid-cols-2">
                <div>
                  <dt>比例</dt>
                  <dd className="mt-0.5 text-white/78">{image.generationMetadata.aspectRatio}</dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd className="mt-0.5 truncate text-white/78">{image.generationMetadata.modelName}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <button
                  className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-2 text-xs text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                  type="button"
                  onClick={() => applyGenerationMetadata(image.generationMetadata, "reuse")}
                >
                  <Copy className="size-3.5" aria-hidden="true" />
                  复用参数
                </button>
                <button
                  className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-mint/36 px-3 py-2 text-xs text-mint transition-colors duration-200 hover:bg-mint/10"
                  type="button"
                  onClick={() => applyGenerationMetadata(image.generationMetadata, "variation")}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  生成变体
                </button>
              </div>
            </div>
          </article>
        ))}
        {!terminalGenerationFailureMessage && !isGenerationProcessing && images.length === 0 ? (
          <div className="sm:col-span-2">
            <EmptyState
              title="生成结果会显示在这里"
              description="填写提示词并提交生成后，图片会按固定比例展示，成功后可进入详情、下载或再次生成。"
              actionLabel="提交生成"
              onAction={() => void submit()}
            />
          </div>
        ) : null}
      </div>
    </Panel>
  );
});
