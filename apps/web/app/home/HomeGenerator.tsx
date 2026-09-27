"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Coins, Wand2 } from "lucide-react";
import { getCurrentUser, peekCurrentUser, validateImageModelSelection } from "../../lib/api";
import { buildGeneratePath, saveGenerationDraft, type GenerationDraft } from "../../lib/generateDrafts";
import { useImageModelCatalog } from "../generate/hooks/useImageModelCatalog";
import { HomeModelControls } from "./HomeModelControls";
import { HomePromptInput, type HomePromptPreset } from "./HomePromptInput";
import { promptExamples } from "./homeContent";

interface Props {
  isLoggedIn: boolean;
  onLoginChange: (loggedIn: boolean) => void;
  promptPreset: HomePromptPreset | null;
}

export function HomeGenerator({ isLoggedIn, onLoginChange, promptPreset }: Props) {
  const router = useRouter();
  const [requestedModel, setSelectedModel] = useState("");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quantity, setQuantity] = useState(2);
  const [authCheckState, setAuthCheckState] = useState<"idle" | "checking">("idle");
  const [entryNotice, setEntryNotice] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const {
    catalog: modelCatalog,
    loading: modelsLoading,
    error: modelsError,
    selectedChannel,
    selectChannel,
    preferredModel,
    rememberModel,
    refresh: refreshModels
  } = useImageModelCatalog();
  const selectedModel = requestedModel || preferredModel || modelCatalog.defaultModel || "";
  const activeModel = modelCatalog.models.find((model) => model.id === selectedModel);
  const quality = activeModel?.qualities.includes("standard") ? "standard" : (activeModel?.qualities[0] ?? "standard");
  const modelSelectionError = modelsLoading
    ? "正在加载可用模型，请稍候。"
    : ((!modelCatalog.models.length ? modelsError : null) ??
      validateImageModelSelection(activeModel, {
        quality,
        aspectRatio,
        quantity
      }));

  useEffect(() => {
    if (!activeModel || modelsLoading) return;
    if (activeModel.aspectRatios.length && !activeModel.aspectRatios.includes(aspectRatio)) {
      setAspectRatio(activeModel.aspectRatios[0]);
    }
    if (quantity > activeModel.maxQuantity) setQuantity(activeModel.maxQuantity);
  }, [activeModel, modelsLoading, aspectRatio, quantity]);

  const effectivePromptRef = useRef(promptExamples[0] ?? "");
  const [hasPrompt, setHasPrompt] = useState(Boolean(effectivePromptRef.current));
  const clearEntryNotice = useCallback(() => setEntryNotice(null), []);
  const handlePromptChange = useCallback((nextPrompt: string) => {
    const hadPrompt = Boolean(effectivePromptRef.current);
    effectivePromptRef.current = nextPrompt;
    if (hadPrompt !== Boolean(nextPrompt)) setHasPrompt(Boolean(nextPrompt));
  }, []);

  const generatePath = useMemo(() => {
    return buildGeneratePath({
      aspectRatio,
      quality,
      quantity,
      model: selectedModel,
      channel: selectedChannel || undefined
    });
  }, [aspectRatio, quality, quantity, selectedModel, selectedChannel]);
  const actionHint =
    authCheckState === "checking"
      ? "正在检查登录状态，马上带你进入对应页面。"
      : isLoggedIn
        ? "已登录，点击后会直接进入生成工作台，并保留当前提示词和参数。"
        : "未登录会先跳转到登录页，登录成功后会自动带回当前预设。";
  const actionHintToneClass =
    authCheckState === "checking"
      ? "border-cyanx/30 bg-cyanx/10 text-cyanx"
      : isLoggedIn
        ? "border-mint/30 bg-mint/10 text-mint"
        : "border-white/12 bg-black/28 text-white/72";

  async function enterGenerateWorkspace(path: string, draft: string | GenerationDraft) {
    if (authCheckState === "checking") {
      return;
    }

    setEntryNotice(null);
    saveGenerationDraft(draft);
    const cachedUser = peekCurrentUser();
    if (cachedUser !== undefined) {
      onLoginChange(Boolean(cachedUser));
      router.push(cachedUser ? path : `/login?next=${encodeURIComponent(path)}`);
      return;
    }

    setAuthCheckState("checking");
    try {
      const user = await getCurrentUser();
      onLoginChange(Boolean(user));
      router.push(user ? path : `/login?next=${encodeURIComponent(path)}`);
    } catch (error) {
      setEntryNotice({
        tone: "danger",
        text: error instanceof Error ? error.message : "登录状态检查失败，请刷新页面后重试。"
      });
    } finally {
      setAuthCheckState("idle");
    }
  }

  async function handleGenerate() {
    const effectivePrompt = effectivePromptRef.current;
    if (modelSelectionError) {
      setEntryNotice({ tone: "danger", text: modelSelectionError });
      return;
    }
    if (!effectivePrompt) {
      return;
    }

    await enterGenerateWorkspace(generatePath, effectivePrompt);
  }

  function selectImageModel(modelId: string) {
    const nextModel = modelCatalog.models.find((model) => model.id === modelId);
    if (!nextModel) return;
    setSelectedModel(nextModel.id);
    rememberModel(nextModel.id);
    if (nextModel.aspectRatios.length && !nextModel.aspectRatios.includes(aspectRatio)) {
      setAspectRatio(nextModel.aspectRatios[0]);
    }
    setQuantity((current) => Math.min(current, nextModel.maxQuantity));
  }

  return (
    <div id="generator" className="glass-panel accent-border mt-9 w-full max-w-4xl rounded-[2rem] p-3 text-left">
      <label className="sr-only" htmlFor="prompt">
        提示词
      </label>
      <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
        <HomePromptInput preset={promptPreset} onPromptChange={handlePromptChange} onEdit={clearEntryNotice} />
        <div className="flex min-w-0 flex-col justify-between rounded-[1.35rem] border border-white/12 bg-white/8 p-4 md:w-64">
          <HomeModelControls
            modelSelection={{
              models: modelCatalog.models,
              channels: modelCatalog.channels ?? [],
              channel: selectedChannel,
              onChannelChange: (channel) => {
                setSelectedModel("");
                selectChannel(channel);
              },
              value: selectedModel,
              onChange: selectImageModel,
              loading: modelsLoading,
              error: modelsError,
              onRefresh: refreshModels
            }}
            activeModel={activeModel}
            modelsLoading={modelsLoading}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            quantity={quantity}
            setQuantity={setQuantity}
          />
          <button
            type="button"
            disabled={authCheckState === "checking" || !hasPrompt || Boolean(modelSelectionError)}
            onClick={() => void handleGenerate()}
            className="focus-ring mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-mint px-5 py-3 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Wand2 className="size-4" aria-hidden="true" />
            {authCheckState === "checking" ? "正在检查登录..." : "生成预览"}
          </button>
        </div>
      </div>

      {/* 积分 */}
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
        <div className={`flex items-center gap-3 rounded-full border px-4 py-2 text-sm ${actionHintToneClass}`}>
          <span className="inline-flex items-center gap-2">
            <Coins className="size-4 text-volt" aria-hidden="true" />
            积分以工作台报价为准
          </span>
          <span className="h-4 w-px bg-white/18" aria-hidden="true" />
          <span>{authCheckState === "checking" ? "检查中" : isLoggedIn ? "已登录直达" : "登录后保留预设"}</span>
        </div>
      </div>

      {/* 状态区：登录分流与当前提示 */}
      <div className="mt-3 rounded-[1.25rem] border border-white/12 bg-black/24 p-4">
        <div className="grid gap-3 md:grid-cols-[1.15fr_0.85fr] md:items-start">
          <div>
            <p className="text-sm font-medium text-white">进入路径</p>
            <p className="mt-2 text-sm leading-6 text-white/70">{actionHint}</p>
            <p className="mt-2 text-xs leading-5 text-white/48">
              当前会带入 {aspectRatio} 比例、{quantity} 张、
              {quality === "standard" ? "标准" : quality === "high" ? "精细" : "草稿"}{" "}
              画质和已选模型，省得你进去再点一轮。
            </p>
          </div>
          <div className="rounded-[1.05rem] border border-white/10 bg-white/6 p-3">
            <p className="text-sm font-medium text-white">当前预设</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/62">
              <span className="rounded-xl bg-black/28 px-3 py-2">比例 {aspectRatio}</span>
              <span className="rounded-xl bg-black/28 px-3 py-2">数量 {quantity} 张</span>
              <span className="rounded-xl bg-black/28 px-3 py-2">
                画质 {quality === "standard" ? "标准" : quality === "high" ? "精细" : "草稿"}
              </span>
              <span className="rounded-xl bg-black/28 px-3 py-2">模型已同步</span>
            </div>
          </div>
        </div>
        {modelSelectionError ? (
          <p className="mt-3 text-sm text-ember" role={modelsLoading ? "status" : "alert"}>
            {modelSelectionError}
          </p>
        ) : null}
        {entryNotice ? (
          <p
            className={`mt-3 rounded-2xl border px-3 py-2 text-sm ${
              entryNotice.tone === "danger"
                ? "border-ember/40 bg-ember/10 text-ember"
                : "border-cyanx/30 bg-cyanx/10 text-cyanx"
            }`}
            role="status"
          >
            {entryNotice.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
