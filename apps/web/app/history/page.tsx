"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Copy, Download, Heart, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppFrame, ConfirmDialog, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { GeneratedImageLightbox, GeneratedImagePreviewButton } from "../../components/GeneratedImagePreview";
import {
  apiFetch,
  formatCredits,
  formatQualityLabel,
  formatStyleLabel,
  resolveSelectableImageModel,
  type GeneratedImage,
  type Task
} from "../../lib/api";
import { buildGeneratePath, saveGenerationDraft } from "../../lib/generateDrafts";

type TaskDetail = {
  task: Task;
  images: GeneratedImage[];
};

const historyTaskPollIntervalMs = 2_000;

export default function HistoryPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [message, setMessage] = useState("");
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<GeneratedImage | null>(null);
  const [pendingDeleteImage, setPendingDeleteImage] = useState<GeneratedImage | null>(null);
  const [deletingImage, setDeletingImage] = useState(false);

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    let canceled = false;
    void loadTaskDetail(selectedTaskId, { isCanceled: () => canceled });
    return () => {
      canceled = true;
    };
  }, [selectedTaskId]);

  const selectedTask = useMemo(
    () => detail?.task ?? tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [detail?.task, selectedTaskId, tasks]
  );
  const activeTaskIds = useMemo(
    () => tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id),
    [tasks]
  );
  const activeTaskIdsKey = activeTaskIds.join("|");

  useEffect(() => {
    const activeSelectedTaskId =
      selectedTask && isActiveTaskStatus(selectedTask.status) ? selectedTask.id : null;
    const activeBackgroundTaskIds = activeTaskIds.filter((taskId) => taskId !== activeSelectedTaskId);
    if (!activeSelectedTaskId && activeBackgroundTaskIds.length === 0) {
      return;
    }

    let canceled = false;
    const refreshActiveTasks = async () => {
      if (activeSelectedTaskId) {
        await loadTaskDetail(activeSelectedTaskId, { quiet: true, isCanceled: () => canceled });
      }
      if (!canceled && activeBackgroundTaskIds.length > 0) {
        await loadHistory({ quiet: true });
      }
    };
    void refreshActiveTasks();
    const intervalId = window.setInterval(() => {
      void refreshActiveTasks();
    }, historyTaskPollIntervalMs);

    return () => {
      canceled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTaskIdsKey, selectedTask?.id, selectedTask?.status]);

  async function loadHistory(options: { quiet?: boolean } = {}) {
    if (!options.quiet) {
      setMessage("");
    }
    try {
      const [taskResult, imageResult] = await Promise.all([
        apiFetch<{ tasks: Task[] }>("/api/generation/tasks?limit=50"),
        apiFetch<{ images: GeneratedImage[] }>("/api/images?limit=50")
      ]);
      setTasks(taskResult.tasks);
      setImages(imageResult.images);
      setSelectedTaskId((value) => value ?? taskResult.tasks[0]?.id ?? null);
    } catch (error) {
      if (!options.quiet) {
        setMessage(error instanceof Error ? error.message : "生成历史加载失败，请稍后重试。");
      }
    }
  }

  async function loadTaskDetail(
    taskId: string,
    options: { quiet?: boolean; isCanceled?: () => boolean } = {}
  ): Promise<TaskDetail | null> {
    try {
      const result = await apiFetch<TaskDetail>(`/api/generation/tasks/${taskId}`);
      if (options.isCanceled?.()) {
        return null;
      }
      setDetail(result);
      setTasks((items) => mergeTaskIntoList(items, result.task));
      setImages((items) => mergeImagesIntoList(items, result.images));
      return result;
    } catch (error) {
      if (!options.quiet && !options.isCanceled?.()) {
        setMessage(error instanceof Error ? error.message : "任务详情加载失败，请稍后重试。");
      }
      return null;
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

  async function confirmDeleteImage() {
    if (!pendingDeleteImage) {
      return;
    }
    setDeletingImage(true);
    try {
      await apiFetch<{ imageId: string; deleted: boolean }>(`/api/images/${pendingDeleteImage.id}`, {
        method: "DELETE"
      });
      setImages((items) => items.filter((item) => item.id !== pendingDeleteImage.id));
      setDetail((value) =>
        value ? { ...value, images: value.images.filter((item) => item.id !== pendingDeleteImage.id) } : value
      );
      setSelectedPreviewImage((value) => (value?.id === pendingDeleteImage.id ? null : value));
      setPendingDeleteImage(null);
      setMessage("图片已删除。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setDeletingImage(false);
    }
  }

  function regenerateTask(task: Task) {
    saveGenerationDraft(task.prompt);
    router.push(
      buildGeneratePath({
        aspectRatio: task.aspectRatio,
        quality: task.quality,
        quantity: task.quantity,
        model: resolveSelectableImageModel(task.modelName)
      })
    );
  }

  return (
    <AppFrame title="生成历史" subtitle="集中管理生成任务、图片资产、下载、收藏和再次生成，方便复用高质量创意结果。">
      {message ? (
        <div className="mb-5">
          <InlineNotice tone={message.includes("失败") ? "danger" : "success"}>
            {message}{" "}
            {message.includes("失败") ? (
              <button className="underline underline-offset-4" onClick={() => void loadHistory()} type="button">
                重新加载历史
              </button>
            ) : null}
          </InlineNotice>
        </div>
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
                <div className="flex items-start justify-between gap-4">
                  <p className="min-w-0 flex-1 line-clamp-2 text-sm leading-6 text-white/74">{task.prompt}</p>
                  <StatusPill className="min-w-[4.75rem]">{task.status}</StatusPill>
                </div>
                <p className="mt-3 text-xs text-white/46">
                  {formatStyleLabel(task.style)} · {task.aspectRatio} · {task.quantity} 张 ·{" "}
                  {formatCredits(task.creditCost)}
                </p>
              </button>
            ))}
            {tasks.length === 0 ? (
              <EmptyState
                title="暂无生成任务"
                description="提交图片生成后，任务状态、消耗积分和提示词会显示在这里。"
                actionLabel="去生成图片"
                actionHref="/generate"
              />
            ) : null}
          </div>
        </Panel>

        <Panel>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">任务详情</h2>
              <p className="mt-1 text-sm text-white/50">{selectedTask?.id ?? "未选择任务"}</p>
            </div>
            {selectedTask ? <StatusPill className="min-w-[4.75rem]">{selectedTask.status}</StatusPill> : null}
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
                <button
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-3 py-2 text-sm font-semibold text-ink hover:bg-volt"
                  onClick={() => regenerateTask(selectedTask)}
                  type="button"
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  再次生成
                </button>
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
              (image, index) => (
                <article key={image.id} className="overflow-hidden rounded-2xl border border-white/12 bg-black/20">
                  <GeneratedImagePreviewButton
                    alt="历史生成图片"
                    ariaLabel={`预览历史第 ${index + 1} 张生成图片`}
                    className="rounded-none border-0 border-b border-white/10 bg-transparent hover:translate-y-0 hover:border-b-mint/60"
                    image={image}
                    onOpen={() => setSelectedPreviewImage(image)}
                  />
                  <div className="flex flex-wrap gap-2 p-3">
                    <Link
                      className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-2 text-xs text-white/68 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                      href={`/images/${image.id}`}
                    >
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      详情
                    </Link>
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
                      onClick={() => setPendingDeleteImage(image)}
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
      <ConfirmDialog
        open={Boolean(pendingDeleteImage)}
        title="确认删除图片？"
        description="删除后这张图片会从历史记录中移除，后续需要重新生成或从备份恢复。"
        confirmLabel="删除图片"
        loading={deletingImage}
        onCancel={() => setPendingDeleteImage(null)}
        onConfirm={() => void confirmDeleteImage()}
      />
      <GeneratedImageLightbox image={selectedPreviewImage} onClose={() => setSelectedPreviewImage(null)} />
    </AppFrame>
  );
}

function isActiveTaskStatus(status: Task["status"]): boolean {
  return status === "PENDING" || status === "RUNNING";
}

function mergeTaskIntoList(tasks: Task[], task: Task): Task[] {
  if (!tasks.some((item) => item.id === task.id)) {
    return [task, ...tasks];
  }
  return tasks.map((item) => (item.id === task.id ? task : item));
}

function mergeImagesIntoList(images: GeneratedImage[], nextImages: GeneratedImage[]): GeneratedImage[] {
  if (nextImages.length === 0) {
    return images;
  }
  const nextImageIds = new Set(nextImages.map((image) => image.id));
  return [...nextImages, ...images.filter((image) => !nextImageIds.has(image.id))];
}
