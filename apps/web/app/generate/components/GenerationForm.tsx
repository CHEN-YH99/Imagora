"use client";

import { memo, type ComponentProps } from "react";
import { aspectRatioOptions } from "@imagora/shared/image-models";
import { ChevronDown, Coins, Wand2 } from "lucide-react";
import { InlineNotice, Panel } from "../../../components/AppFrame";
import { formatCredits, type ImageModelOption } from "../../../lib/api";
import type { GenerationWorkspace } from "../hooks/useGenerationWorkspace";
import { maxEnhancedPromptLength } from "../promptPresets";
import { GenerationModelSelection } from "./GenerationModelSelection";

type GenerationFormProps = Pick<
  GenerationWorkspace,
  "prompt" | "setPrompt" | "aspectRatio" | "setAspectRatio" | "quantity" | "quantityInput" | "setQuantityInput" | "quote" | "account" | "message" | "messageTone" | "appealEventId" | "showAppealForm" | "setShowAppealForm" | "appealReason" | "setAppealReason" | "appealStatus" | "appealLoading" | "loading"
> & ComponentProps<typeof GenerationModelSelection> & {
  selectedModel: ImageModelOption | undefined;
  generationPromptError: string | null;
  isGenerationProcessing: boolean;
  setQuantityFromInput(value: string): void;
  handleAppeal(): Promise<void>;
  submit(): Promise<void>;
  onHistory(): void;
};

// 表单只接收编辑值、提示和任务是否忙碌；进度快照变化不会穿过这个边界。
export const GenerationForm = memo(function GenerationForm({
  prompt,
  setPrompt,
  aspectRatio,
  setAspectRatio,
  quantity,
  quantityInput,
  setQuantityInput,
  quote,
  account,
  message,
  messageTone,
  appealEventId,
  showAppealForm,
  setShowAppealForm,
  appealReason,
  setAppealReason,
  appealStatus,
  appealLoading,
  loading,
  modelCatalog,
  selectedChannel,
  model,
  modelsLoading,
  modelsError,
  modelSelectionError,
  onChannelChange,
  selectImageModel,
  refreshModels,
  selectedModel,
  generationPromptError,
  isGenerationProcessing,
  setQuantityFromInput,
  handleAppeal,
  submit,
  onHistory
}: GenerationFormProps) {
  const selectedAspectRatioValue = parseAspectRatioValue(aspectRatio.replace(":", "/")) ?? 1;
  const hasPrompt = prompt.trim().length > 0;

  return (
    <Panel>
      <div className="space-y-5">
        {/* 提示词 */}
        <div>
          <div className="text-sm text-white/70">
            <label htmlFor="generation-prompt">提示词</label>
            <textarea
              id="generation-prompt"
              className="focus-ring mt-2 min-h-52 w-full resize-none rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="提示词"
              aria-invalid={Boolean(generationPromptError)}
              aria-describedby="generation-prompt-length"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p
              id="generation-prompt-length"
              className={`text-xs ${generationPromptError ? "text-ember" : "text-white/45"}`}
            >
              {generationPromptError ?? `${prompt.length} / ${maxEnhancedPromptLength} 个字符`}
            </p>
            <span
              className="generation-ratio-control"
              data-disabled={modelsLoading || !selectedModel?.aspectRatios.length}
            >
              <span className="generation-ratio-icon" aria-hidden="true">
                <span
                  className="generation-ratio-frame"
                  style={{
                    transform: `scale(${Math.min(1, selectedAspectRatioValue)}, ${Math.min(1, 1 / selectedAspectRatioValue)})`
                  }}
                />
              </span>
              <select
                className="focus-ring generation-ratio-select"
                value={aspectRatio}
                onChange={(event) => setAspectRatio(event.target.value)}
                aria-label="画面比例"
                disabled={modelsLoading || !selectedModel?.aspectRatios.length}
              >
                {aspectRatioOptions.map((item) => (
                  <option
                    key={item.value}
                    value={item.value}
                    disabled={!selectedModel?.aspectRatios.includes(item.value)}
                  >
                    {item.label}
                    {selectedModel && !selectedModel.aspectRatios.includes(item.value) ? "（不可用）" : ""}
                  </option>
                ))}
              </select>
              <ChevronDown className="generation-ratio-chevron" aria-hidden="true" />
            </span>
          </div>
        </div>

        <GenerationModelSelection
          modelCatalog={modelCatalog}
          selectedChannel={selectedChannel}
          model={model}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          modelSelectionError={modelSelectionError}
          onChannelChange={onChannelChange}
          selectImageModel={selectImageModel}
          refreshModels={refreshModels}
        />

        <label className="block text-sm text-white/70">
          生成数量
          <input
            className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 text-white"
            type="number"
            min={1}
            max={selectedModel?.maxQuantity ?? 4}
            value={quantityInput}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setQuantityFromInput(event.target.value)}
            onBlur={() => setQuantityInput(String(quantity))}
          />
        </label>

        {/* 积分预估 */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/12 bg-black/24 p-4">
          <span className="inline-flex items-center gap-2 text-sm text-white/72">
            <Coins className="size-4 text-volt" aria-hidden="true" />
            预计消耗：{quote ? formatCredits(quote) : "登录后计算"}
          </span>
          <span className="text-sm text-white/72">
            当前余额：{account ? formatCredits(account.balance) : "未登录"}
          </span>
        </div>

        {message ? (
          <InlineNotice tone={messageTone}>
            {message}
            {messageTone === "danger" ? (
              <>
                {" "}
                <button className="underline underline-offset-4" onClick={() => void submit()} type="button">
                  重试提交
                </button>
                {" 或 "}
                <button
                  className="underline underline-offset-4"
                  onClick={() => onHistory()}
                  type="button"
                >
                  去历史查看
                </button>
              </>
            ) : null}
          </InlineNotice>
        ) : null}

        {/* 申诉入口：仅在任务被内容拦截且存在对应安全事件时显示 */}
        {appealEventId && !appealStatus ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/8 p-4">
            <p className="mb-3 text-sm text-amber-300">如认为是误判，可提交申诉，管理员将在审核后回复。</p>
            {showAppealForm ? (
              <div className="space-y-3">
                <label className="block text-sm text-white/70">
                  申诉理由（至少 10 字）
                  <textarea
                    className="focus-ring mt-2 min-h-24 w-full resize-none rounded-xl border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                    value={appealReason}
                    onChange={(event) => setAppealReason(event.target.value)}
                    placeholder="请说明为什么认为此次拦截是误判，或提供更多背景信息..."
                    maxLength={1000}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    className="focus-ring rounded-full bg-amber-500/80 px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-amber-400 disabled:opacity-50"
                    type="button"
                    disabled={appealLoading || appealReason.trim().length < 10}
                    onClick={() => void handleAppeal()}
                  >
                    {appealLoading ? "提交中..." : "提交申诉"}
                  </button>
                  <button
                    className="focus-ring rounded-full border border-white/20 px-4 py-2 text-sm text-white/60 hover:text-white"
                    type="button"
                    onClick={() => setShowAppealForm(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="focus-ring rounded-full bg-amber-500/20 px-4 py-2 text-sm text-amber-300 transition-colors hover:bg-amber-500/30"
                type="button"
                onClick={() => setShowAppealForm(true)}
              >
                发起申诉
              </button>
            )}
          </div>
        ) : null}

        {appealStatus ? (
          <div className="rounded-2xl border border-white/12 bg-white/4 p-4">
            <p className="text-sm text-white/70">
              申诉状态：
              <span
                className={`font-medium ${appealStatus.status === "APPROVED" ? "text-mint" : appealStatus.status === "REJECTED" ? "text-ember" : "text-amber-300"}`}
              >
                {appealStatus.status === "PENDING"
                  ? "待审核"
                  : appealStatus.status === "APPROVED"
                    ? "已通过"
                    : "已驳回"}
              </span>
              {appealStatus.adminNote ? `，备注：${appealStatus.adminNote}` : ""}
            </p>
          </div>
        ) : null}

        {generationPromptError ? <InlineNotice tone="danger">{generationPromptError}</InlineNotice> : null}

        <button
          className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:opacity-60"
          type="button"
          disabled={
            loading ||
            isGenerationProcessing ||
            !hasPrompt ||
            Boolean(generationPromptError) ||
            Boolean(modelSelectionError)
          }
          onClick={submit}
        >
          <Wand2 className="size-4" aria-hidden="true" />
          {isGenerationProcessing ? "生成中..." : "提交生成"}
        </button>
      </div>
    </Panel>
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



