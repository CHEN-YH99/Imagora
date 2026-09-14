"use client";

import { useEffect, useState } from "react";
import { apiFetch, type ImageModelCatalog } from "../../../lib/api";

export function useImageModelCatalog() {
  const [state, setState] = useState<{
    catalog: ImageModelCatalog;
    loading: boolean;
    error: string | null;
  }>({ catalog: { models: [], defaultModel: null }, loading: true, error: null });

  useEffect(() => {
    let canceled = false;
    void apiFetch<ImageModelCatalog>("/api/generation/models")
      .then((catalog) => {
        if (!canceled) setState({ catalog, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({
            catalog: { models: [], defaultModel: null },
            loading: false,
            error: error instanceof Error ? "模型列表加载失败：" + error.message : "模型列表加载失败，请刷新后重试。"
          });
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  return state;
}
