"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type ImageModelCatalog } from "../../../lib/api";

const pending = new Map<string, Promise<ImageModelCatalog>>();
const preferenceKey = "imagora.image-model";
const channelPreferenceKey = "imagora.image-channel";
function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function fetchCatalog(channel: string): Promise<ImageModelCatalog> {
  const current = pending.get(channel);
  if (current) return current;
  const request = apiFetch<ImageModelCatalog>(
    "/api/generation/models" + (channel ? "?channel=" + encodeURIComponent(channel) : "")
  ).finally(() => {
    pending.delete(channel);
  });
  pending.set(channel, request);
  return request;
}

export function useImageModelCatalog(initialChannel?: string | null) {
  const [requestedChannel, setRequestedChannel] = useState(initialChannel ?? "");
  const [state, setState] = useState<{
    requestKey: string;
    catalog: ImageModelCatalog;
    loading: boolean;
    error: string | null;
  }>({ requestKey: initialChannel ?? "", catalog: { models: [], defaultModel: null }, loading: true, error: null });
  const [preferredModel, setPreferredModel] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    setRefreshVersion((value) => value + 1);
  }, []);
  const selectedChannel = requestedChannel || state.catalog.channel || "";

  const selectionRef = useRef(selectedChannel);
  selectionRef.current = selectedChannel;

  const selectChannel = useCallback((channel: string) => {
    if (channel === selectionRef.current) return;
    selectionRef.current = channel;
    setRequestedChannel(channel);
    setPreferredModel("");
    setState((previous) => ({
      requestKey: channel,
      catalog: { ...previous.catalog, models: [], defaultModel: null, channel },
      loading: true,
      error: null
    }));
    try {
      localStorage.setItem(channelPreferenceKey, channel);
    } catch {
      /* 本次选择仍有效。 */
    }
  }, []);

  const rememberModel = useCallback(
    (model: string) => {
      setPreferredModel(model);
      try {
        localStorage.setItem(preferenceKey + ":" + selectedChannel, model);
        localStorage.setItem(preferenceKey, model);
      } catch {
        /* 隐私模式仍允许本次选择。 */
      }
    },
    [selectedChannel]
  );

  useEffect(() => {
    const channel = initialChannel || stored(channelPreferenceKey);
    if (channel) selectChannel(channel);
  }, [initialChannel, selectChannel]);

  useEffect(() => {
    let canceled = false;
    let requestSequence = 0;
    const update = () => {
      const sequence = ++requestSequence;
      void fetchCatalog(requestedChannel)
        .then((catalog) => {
          if (canceled || sequence !== requestSequence) return;
          const saved =
            stored(preferenceKey + ":" + (catalog.channel ?? "")) ||
            (catalog.channel === catalog.defaultChannel ? stored(preferenceKey) : "");
          setPreferredModel(catalog.models.some((model) => model.id === saved) ? saved : "");
          setState({ requestKey: requestedChannel, catalog, loading: false, error: catalog.error ?? null });
        })
        .catch(() => {
          if (canceled || sequence !== requestSequence) return;
          setState((previous) => {
            const sameChannel = previous.requestKey === requestedChannel;
            return {
              requestKey: requestedChannel,
              catalog: sameChannel
                ? previous.catalog
                : { ...previous.catalog, channel: requestedChannel, models: [], defaultModel: null },
              loading: false,
              error:
                sameChannel && previous.catalog.models.length
                  ? "该线路模型目录暂时无法更新，正在使用上次结果。"
                  : "该线路模型列表加载失败，请重试。"
            };
          });
        });
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") update();
    };
    update();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, 60_000);
    return () => {
      canceled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshVersion, requestedChannel]);

  // 切换后、旧请求完成前也不能显示或提交上一条 API 的型号。
  const current =
    state.requestKey === requestedChannel
      ? state
      : {
          ...state,
          loading: true,
          error: null,
          catalog: { ...state.catalog, models: [], defaultModel: null, channel: requestedChannel }
        };
  return { ...current, selectedChannel, selectChannel, preferredModel, rememberModel, refresh };
}
