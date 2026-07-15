"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowUpRight, Copy, Download, FolderPlus, Heart, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppFrame, ConfirmDialog, EmptyState, InlineNotice, Panel, StatusPill } from "../../components/AppFrame";
import { GeneratedImageLightbox, GeneratedImagePreviewButton } from "../../components/GeneratedImagePreview";
import {
  apiFetch,
  downloadGeneratedImage,
  formatCredits,
  formatQualityLabel,
  formatStyleLabel,
  resolveSelectableImageModel,
  type GeneratedImage,
  type ImageProject,
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
  const [projects, setProjects] = useState<ImageProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingArchiveProject, setPendingArchiveProject] = useState<ImageProject | null>(null);
  const [archivingProject, setArchivingProject] = useState(false);
  const [deletingImage, setDeletingImage] = useState(false);

  useEffect(() => {
    void loadHistory();
  }, [selectedProjectId]);

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
    const activeSelectedTaskId = selectedTask && isActiveTaskStatus(selectedTask.status) ? selectedTask.id : null;
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
      const imagesPath = selectedProjectId
        ? `/api/images?projectId=${encodeURIComponent(selectedProjectId)}&limit=50`
        : "/api/images?limit=50";
      const [taskResult, imageResult, projectResult] = await Promise.all([
        apiFetch<{ tasks: Task[] }>("/api/generation/tasks?limit=50"),
        apiFetch<{ images: GeneratedImage[] }>(imagesPath),
        apiFetch<{ projects: ImageProject[] }>("/api/image-projects")
      ]);
      setTasks(taskResult.tasks);
      setImages(imageResult.images);
      setProjects(projectResult.projects);
      if (selectedProjectId && !projectResult.projects.some((project) => project.id === selectedProjectId)) {
        setSelectedProjectId(null);
      }
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
    try {
      const fileName = await downloadGeneratedImage(image.id);
      setMessage(`已开始下载 ${fileName}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下载失败，请稍后重试。");
    }
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

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) {
      setMessage("请输入项目名称。");
      return;
    }
    setCreatingProject(true);
    try {
      const result = await apiFetch<{ project: ImageProject }>("/api/image-projects", {
        method: "POST",
        body: { name, description: "从历史资产工作台创建" }
      });
      setProjects((items) => [result.project, ...items]);
      setSelectedProjectId(result.project.id);
      setNewProjectName("");
      setMessage("项目已创建。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目创建失败，请稍后重试。");
    } finally {
      setCreatingProject(false);
    }
  }

  async function assignImageProject(image: GeneratedImage, projectId: string | null) {
    try {
      const result = await apiFetch<{ image: GeneratedImage }>(`/api/images/${image.id}/project`, {
        method: "POST",
        body: { projectId }
      });
      setImages((items) =>
        selectedProjectId && projectId !== selectedProjectId
          ? items.filter((item) => item.id !== image.id)
          : items.map((item) => (item.id === image.id ? result.image : item))
      );
      setDetail((value) =>
        value
          ? {
              ...value,
              images: value.images.map((item) => (item.id === image.id ? result.image : item))
            }
          : value
      );
      await loadProjectsQuietly();
      setMessage(projectId ? "图片已保存到项目。" : "图片已移出项目。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目移动失败，请稍后重试。");
    }
  }

  async function loadProjectsQuietly() {
    try {
      const result = await apiFetch<{ projects: ImageProject[] }>("/api/image-projects");
      setProjects(result.projects);
    } catch {
      // 项目计数刷新失败不应覆盖刚完成的图片操作提示。
    }
  }

  async function confirmArchiveProject() {
    if (!pendingArchiveProject) {
      return;
    }
    setArchivingProject(true);
    try {
      await apiFetch<{ projectId: string; archived: boolean }>(`/api/image-projects/${pendingArchiveProject.id}`, {
        method: "DELETE"
      });
      setProjects((items) => items.filter((project) => project.id !== pendingArchiveProject.id));
      if (selectedProjectId === pendingArchiveProject.id) {
        setSelectedProjectId(null);
      }
      setPendingArchiveProject(null);
      setMessage("项目已归档，图片已回到未分组状态。");
      void loadHistory({ quiet: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目归档失败，请稍后重试。");
    } finally {
      setArchivingProject(false);
    }
  }

  function regenerateTask(task: Task) {
    saveGenerationDraft({
      prompt: task.prompt,
      negativePrompt: task.negativePrompt ?? undefined,
      style: task.style,
      aspectRatio: task.aspectRatio,
      quality: task.quality,
      quantity: task.quantity,
      model: resolveSelectableImageModel(task.modelName),
      mode: "reuse"
    });
    router.push(
      buildGeneratePath({
        style: task.style,
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
      <Panel className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">项目工作台</h2>
            <p className="mt-1 text-sm text-white/52">按项目集整理历史图片，确认可复用素材后再收藏、下载或生成变体。</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-72">
            <div className="flex gap-2">
              <input
                className="focus-ring min-w-0 flex-1 rounded-2xl border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="新项目名称"
              />
              <button
                className="focus-ring inline-flex items-center gap-2 rounded-full bg-mint px-3 py-2 text-sm font-semibold text-ink hover:bg-volt disabled:opacity-60"
                type="button"
                disabled={creatingProject || !newProjectName.trim()}
                onClick={() => void createProject()}
              >
                <FolderPlus className="size-4" aria-hidden="true" />
                创建
              </button>
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className={`focus-ring rounded-full border px-3 py-2 text-sm transition-colors duration-200 ${
              selectedProjectId === null
                ? "border-mint/70 bg-mint/10 text-white"
                : "border-white/12 text-white/68 hover:bg-white/10"
            }`}
            type="button"
            onClick={() => setSelectedProjectId(null)}
          >
            全部资产 · {images.length}
          </button>
          {projects.map((project) => (
            <span key={project.id} className="inline-flex items-center gap-1 rounded-full border border-white/12">
              <button
                className={`focus-ring rounded-l-full px-3 py-2 text-sm transition-colors duration-200 ${
                  selectedProjectId === project.id ? "bg-mint/10 text-white" : "text-white/68 hover:bg-white/10"
                }`}
                type="button"
                onClick={() => setSelectedProjectId(project.id)}
              >
                {project.name} · {project.imageCount ?? 0}
              </button>
              <button
                className="focus-ring rounded-r-full px-2 py-2 text-white/48 transition-colors hover:bg-white/10 hover:text-white"
                type="button"
                aria-label={`归档项目 ${project.name}`}
                title="归档项目"
                onClick={() => setPendingArchiveProject(project)}
              >
                <Archive className="size-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      </Panel>
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
              <dl className="mt-4 grid gap-3 text-xs text-white/52 sm:grid-cols-2 lg:grid-cols-4">
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
                <div>
                  <dt>创建时间</dt>
                  <dd className="mt-1 text-white/80">{formatTaskTimestamp(selectedTask.createdAt)}</dd>
                </div>
                <div>
                  <dt>开始时间</dt>
                  <dd className="mt-1 text-white/80">{formatTaskTimestamp(selectedTask.startedAt)}</dd>
                </div>
                <div>
                  <dt>完成时间</dt>
                  <dd className="mt-1 text-white/80">{formatTaskTimestamp(selectedTask.completedAt)}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd className="mt-1 text-white/80">{formatTaskTimestamp(selectedTask.updatedAt)}</dd>
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
                    <label className="min-w-36 flex-1 text-xs text-white/50">
                      项目
                      <select
                        className="focus-ring mt-1 w-full rounded-full border border-white/12 bg-black px-3 py-2 text-xs text-white/72"
                        value={image.projectId ?? ""}
                        onChange={(event) => void assignImageProject(image, event.target.value || null)}
                      >
                        <option value="">未分组</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
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
      <ConfirmDialog
        open={Boolean(pendingArchiveProject)}
        title="确认归档项目？"
        description="归档后项目会从工作台隐藏，项目内图片不会删除，会回到未分组状态。"
        confirmLabel="归档项目"
        loading={archivingProject}
        onCancel={() => setPendingArchiveProject(null)}
        onConfirm={() => void confirmArchiveProject()}
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

function formatTaskTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const datePart = [date.getFullYear(), padTimestampPart(date.getMonth() + 1), padTimestampPart(date.getDate())].join(
    "-"
  );
  const timePart = [
    padTimestampPart(date.getHours()),
    padTimestampPart(date.getMinutes()),
    padTimestampPart(date.getSeconds())
  ].join(":");
  return `${datePart} ${timePart}`;
}

function padTimestampPart(value: number): string {
  return value.toString().padStart(2, "0");
}
