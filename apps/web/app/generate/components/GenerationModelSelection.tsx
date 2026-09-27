"use client";

import { memo } from "react";
import { ImageModelSelect } from "../../../components/ImageModelSelect";
import type { ImageApiChannelOption, ImageModelCatalog } from "../../../lib/api";

const emptyChannels: ImageApiChannelOption[] = [];

type GenerationModelSelectionProps = {
  modelCatalog: ImageModelCatalog;
  selectedChannel: string;
  model: string;
  modelsLoading: boolean;
  modelsError: string | null;
  modelSelectionError: string | null;
  onChannelChange(channel: string): void;
  selectImageModel(model: string): void;
  refreshModels(): void;
};

export const GenerationModelSelection = memo(function GenerationModelSelection({
  modelCatalog,
  selectedChannel,
  model,
  modelsLoading,
  modelsError,
  modelSelectionError,
  onChannelChange,
  selectImageModel,
  refreshModels
}: GenerationModelSelectionProps) {
  return (
    <div>
      <ImageModelSelect
        models={modelCatalog.models}
        channels={modelCatalog.channels ?? emptyChannels}
        channel={selectedChannel}
        onChannelChange={onChannelChange}
        value={model}
        onChange={selectImageModel}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={refreshModels}
        className="focus-ring mt-2 w-full rounded-2xl border border-white/12 bg-black px-4 py-3 text-white"
      />
      <span
        id="generation-model-help"
        className="mt-2 block text-xs text-white/55"
        role={modelSelectionError && !modelsLoading ? "alert" : undefined}
      >
        {modelSelectionError ?? "切换 API 后会更新可选模型，切换线路或模型会重新计算积分。"}
      </span>
    </div>
  );
});

