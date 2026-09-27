"use client";

import { useEffect, useState } from "react";
import { apiFetch, type ImageModelCatalog } from "../../../lib/api";
import { Panel } from "../../../components/AppFrame";

type CatalogStatus = ImageModelCatalog & {
  discovery: {
    enabled: boolean;
    primaryChannel: string | null;
    updatedAt: string | null;
    channels: Array<{ name: string; updatedAt: string | null; error: string | null }>;
  };
};

export function AdminImageModelsPanel() {
  const [data, setData] = useState<CatalogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void apiFetch<CatalogStatus>("/api/admin/generation/models")
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setError("模型同步状态加载失败。");
      });
    return () => {
      active = false;
    };
  }, []);

  async function synchronize() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setData(await apiFetch<CatalogStatus>("/api/admin/generation/models/refresh", { method: "POST" }));
    } catch {
      setError("同步请求失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mb-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">生图模型</h2>
        <button
          type="button"
          disabled={busy || data?.discovery.enabled === false}
          onClick={() => void synchronize()}
          className="focus-ring rounded-xl border border-white/15 px-4 py-2 text-sm disabled:opacity-50"
        >
          {busy ? "同步中…" : "从 API 同步模型"}
        </button>
      </div>
      {data ? (
        <p className="text-sm text-white/65">
          {data.discovery.enabled
            ? "主线路：" + data.discovery.primaryChannel + " · 每 10 分钟自动同步"
            : "当前为静态模型配置"}
          {" · " + data.models.length + " 个可选模型"}
          {data.discovery.updatedAt ? " · 最近成功：" + new Date(data.discovery.updatedAt).toLocaleString() : ""}
        </p>
      ) : null}
      {data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-white/55">
              <tr>
                <th className="py-2 pr-4">模型版本</th>
                <th className="py-2 pr-4">可选比例</th>
                <th className="py-2">能力依据</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {data.models.map((model) => (
                <tr key={model.id} className="border-t border-white/10">
                  <td className="py-2 pr-4">{model.label}</td>
                  <td className="py-2 pr-4">{model.aspectRatios.join("、") || "尚未确认，暂不可生成"}</td>
                  <td className="py-2">
                    {
                      {
                        documented: "官方文档",
                        upstream: "线路声明",
                        configured: "明确配置",
                        unverified: "待确认"
                      }[model.aspectRatioSource ?? "configured"]
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data?.discovery.channels
        .filter((channel) => channel.error)
        .map((channel) => (
          <p key={channel.name} className="text-xs text-amber-200">
            {channel.name}：{channel.error}
          </p>
        ))}
      {error ? (
        <p role="alert" className="text-sm text-amber-200">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
