"use client";

import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { aspectRatioOptions } from "@imagora/shared/image-models";
import { ImageModelSelect } from "../../components/ImageModelSelect";
import type { ImageModelOption } from "../../lib/api";

interface Props {
  modelSelection: Omit<ComponentProps<typeof ImageModelSelect>, "className" | "label">;
  activeModel: ImageModelOption | undefined;
  modelsLoading: boolean;
  aspectRatio: string;
  setAspectRatio: (value: string) => void;
  quantity: number;
  setQuantity: Dispatch<SetStateAction<number>>;
}

export function HomeModelControls({
  modelSelection,
  activeModel,
  modelsLoading,
  aspectRatio,
  setAspectRatio,
  quantity,
  setQuantity
}: Props) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ImageModelSelect
        {...modelSelection}
        label="选择模型"
        className="focus-ring w-full rounded-2xl border border-white/12 bg-black/40 px-3 py-2 text-white"
      />
      <select
        className="focus-ring image-ratio-select w-full rounded-2xl border border-white/12 bg-black/40 px-3 py-2 text-white"
        value={aspectRatio}
        onChange={(e) => setAspectRatio(e.target.value)}
        aria-label="选择比例"
        disabled={modelsLoading || !activeModel?.aspectRatios.length}
      >
        {aspectRatioOptions.map((o) => (
          <option key={o.value} value={o.value} disabled={!activeModel?.aspectRatios.includes(o.value)}>
            {o.label}
            {activeModel && !activeModel.aspectRatios.includes(o.value) ? "（不可用）" : ""}
          </option>
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
          >
            -
          </button>
          {quantity}
          <button
            className="focus-ring rounded-full px-2 text-white/70 hover:bg-white/10 hover:text-white"
            type="button"
            aria-label="增加生成数量"
            onClick={() => setQuantity((current) => Math.min(activeModel?.maxQuantity ?? 4, current + 1))}
          >
            +
          </button>
        </span>
      </div>
    </div>
  );
}
