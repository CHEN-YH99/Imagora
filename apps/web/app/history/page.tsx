"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Copy, Download, Heart, RefreshCw, Trash2 } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  formatQualityLabel,
  formatStyleLabel,
  type GeneratedImage,
  type Task
} from "../../lib/api";

type TaskDetail = {
  task: Task;
  images: GeneratedImage[];
};

export default function HistoryPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    apiFetch<TaskDetail>(`/api/generation/tasks/${selectedTaskId}`)
      .then((result) => setDetail(result))
      .catch((error) => setMessage(error instanceof Error ? error.message : "任务详情加载失败，请稍后重试。"));
  }, [selectedTaskId]);

  const selectedTask = useMemo(
    () => detail?.task ?? tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [detail?.task, selectedTaskId, tasks]
  );

  async function loadHistory() {
    setMessage("");
    try {
      const [taskResult, imageResult] = await Promise.all([
        apiFetch<{ tasks: Task[] }>("/api/generation/tasks?limit=50"),
        apiFetch<{ images: GeneratedImage[] }>("/api/images?limit=50")
      ]);
      setTasks(taskResult.tasks);
      setImages(imageResult.images);
      setSelectedTaskId((value) => value ?? taskResult.tasks[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成历史加载失败，请稍后重试。");
    }
  }

  async function copyPrompt(prompt: string) {
    await navigator.clipboard.writeText(prompt);
    setMessage("提示词已复制。");
  }

  async function toggleFavorite(image: GeneratedImage) {
    await apiFetch<{ imageId: string; favorite: boolean }>(`/api/images/${image.id}/favorite`, {
      method: image.favorite ? "DELETE" : "POST"
    });
    setImages((items) => items.map((item) => (item.id === image.id ? { ...item, favorite: !image.favorite } : item)));
    setDetail((value) =>
      value
        ? {
            ...value,
            images: value.images.map((item) => (item.id === image.id ? { ...item, favorite: !image.favorite } : item))
          }
        : value
    );
  }

  async function downloadImage(image: GeneratedImage) {
    const result = await apiFetch<{ url: string; fileName: string }>(`/api/images/${image.id}/download-url`, {
      method: "POST",
      body: {}
    });
    const anchor = document.createElement("a");
    anchor.href = result.url;
    anchor.download = result.fileName;
    anchor.rel = "noreferrer";
    anchor.click();
  }

  async function deleteImage(image: GeneratedImage) {
    if (!window.confirm("确定从历史记录中删除这张生成图片？")) {
      return;
    }
    await apiFetch<{ imageId: string; deleted: boolean }>(`/api/images/${image.id}`, {
      method: "DELETE"
    });
    setImages((items) => items.filter((item) => item.id !== image.id));
    setDetail((value) => (value ? { ...value, images: value.images.filter((item) => item.id !== image.id) } : value));
  }

  return (
    <AppFrame title="生成历史" subtitle="集中管理生成任务、图片资产、下载、收藏和再次生成，方便复用高质量创意结果。">
      {message ? (
        <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <Panel>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">任务列表</h2>
            <button
              className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/10"
              type="button"
              onClick={() => void loadHistory()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              刷新
            </button>
          </div>
          <div className="space-y-3">
            {tasks.map((task) => (
              <button
                key={task.id}
                className={`focus-ring w-full rounded-2xl border p-4 text-left transition-colors duration-200 ${
                  selectedTask?.id === task.id
                    ? "border-mint/70 bg-mint/10"
                    : "border-white/10 bg-black/20 hover:bg-white/8"
                }`}
                type="button"
                onClick={() => setSelectedTaskId(task.id)}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm leading-6 text-white/74">{task.prompt}</p>
                  <StatusPill>{task.status}</StatusPill>
                </div>
                <p className="mt-3 text-xs text-white/46">
                  {formatStyleLabel(task.style)} · {task.aspectRatio} · {task.quantity} 张 ·{" "}
                  {formatCredits(task.creditCost)}
                </p>
              </button>
            ))}
            {tasks.length === 0 ? <p className="text-sm text-white/50">暂无生成任务。</p> : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">任务详情</h2>
              <p className="mt-1 text-sm text-white/50">{selectedTask?.id ?? "未选择任务"}</p>
            </div>
            {selectedTask ? <StatusPill>{selectedTask.status}</StatusPill> : null}
          </div>

          {selectedTask ? (
            <div className="mb-5 rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm leading-6 text-white/76">{selectedTask.prompt}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/10"
                  type="button"
                  onClick={() => void copyPrompt(selectedTask.prompt)}
                >
                  <Copy className="size-4" aria-hidden="true" />
                  复制提示词
                </button>
                <Link
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-3 py-2 text-sm font-semibold text-ink hover:bg-volt"
                  href={`/generate?prompt=${encodeURIComponent(selectedTask.prompt)}&aspectRatio=${encodeURIComponent(selectedTask.aspectRatio)}&quality=${encodeURIComponent(selectedTask.quality)}&quantity=${selectedTask.quantity}&model=${encodeURIComponent(selectedTask.modelName ?? "gpt-image-2")}`}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  再次生成
                </Link>
              </div>
              <dl className="mt-4 grid gap-3 text-xs text-white/52 sm:grid-cols-4">
                <div>
                  <dt>风格</dt>
                  <dd className="mt-1 text-white/80">{formatStyleLabel(selectedTask.style)}</dd>
                </div>
                <div>
                  <dt>比例</dt>
                  <dd className="mt-1 text-white/80">{selectedTask.aspectRatio}</dd>
                </div>
                <div>
                  <dt>质量</dt>
                  <dd className="mt-1 text-white/80">{formatQualityLabel(selectedTask.quality)}</dd>
                </div>
                <div>
                  <dt>积分</dt>
                  <dd className="mt-1 text-white/80">{formatCredits(selectedTask.creditCost)}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            {(detail?.images.length ? detail.images : images.filter((image) => image.taskId === selectedTask?.id)).map(
              (image) => (
                <article key={image.id} className="overflow-hidden rounded-2xl border border-white/12 bg-black/20">
                  <Link className="focus-ring block" href={`/images/${image.id}`}>
                    <img className="aspect-square w-full object-cover" src={image.publicUrl} alt="历史生成图片" />
                  </Link>
                  <div className="flex flex-wrap gap-2 p-3">
                    <button
                      className="icon-action"
                      type="button"
                      onClick={() => void toggleFavorite(image)}
                      aria-label="切换收藏"
                    >
                      <Heart
                        className={`size-4 ${image.favorite ? "fill-current text-ember" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                    <button
                      className="icon-action"
                      type="button"
                      onClick={() => void downloadImage(image)}
                      aria-label="下载图片"
                    >
                      <Download className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      className="icon-action"
                      type="button"
                      onClick={() => void deleteImage(image)}
                      aria-label="删除图片"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </article>
              )
            )}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}
