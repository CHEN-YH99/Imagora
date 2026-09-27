"use client";

import type { ImageModelOption, ImageApiChannelOption } from "../lib/api";

interface Props {
  models: ImageModelOption[];
  channels: ImageApiChannelOption[];
  channel: string;
  value: string;
  loading: boolean;
  error: string | null;
  onChange: (id: string) => void;
  onChannelChange: (id: string) => void;
  onRefresh: () => void;
  className?: string;
  label?: string;
}

export function ImageModelSelect({
  models,
  channels,
  channel,
  value,
  loading,
  error,
  onChange,
  onChannelChange,
  onRefresh,
  className,
  label = "模型"
}: Props) {
  const selected = models.find((model) => model.id === value);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-h-6 items-center gap-2">
        <span className="shrink-0 text-sm text-white/70">{label}</span>
        {channels.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="API 线路">
            {channels.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={channel === item.id}
                onClick={() => {
                  if (channel !== item.id) onChannelChange(item.id);
                }}
                className={
                  "focus-ring rounded-full border px-2.5 py-1 text-[11px] leading-4 transition-colors " +
                  (channel === item.id
                    ? "border-mint/70 bg-mint/10 text-mint"
                    : "border-white/12 bg-black/24 text-white/65 hover:border-white/30 hover:text-white")
                }
              >
                {index === 0 ? "主线路" : `备用线路${index}`}
              </button>
            ))}
          </div>
        ) : null}
        {!channels.length && channel && !loading ? (
          <button
            type="button"
            onClick={() => onChannelChange("")}
            className="focus-ring rounded-full border border-white/12 px-2.5 py-1 text-[11px] text-white/65"
          >
            主线路
          </button>
        ) : null}
      </div>
      <select
        className={className}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={loading || !models.length}
        aria-label={label}
      >
        {!selected ? (
          <option value={value} disabled>
            {loading ? "加载模型中…" : models.length && value ? "所选模型不可用，请重新选择" : "该线路暂无可用模型"}
          </option>
        ) : null}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      {selected?.creditMultiplier === 2 ? (
        <p className="text-xs text-amber-200">4K 型号：同等参数按普通 GPT Image 的双倍积分计费。</p>
      ) : null}
      {error ? (
        <p className="text-xs text-amber-200" role="status">
          {error}
        </p>
      ) : null}
      <button type="button" onClick={onRefresh} className="focus-ring rounded text-xs text-white/55 hover:text-white">
        刷新模型列表
      </button>
    </div>
  );
}
