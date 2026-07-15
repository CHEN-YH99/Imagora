"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Copy, Download, Heart, Repeat2, RefreshCw, Trash2 } from "lucide-react";
import { AppFrame, ConfirmDialog, EmptyState, InlineNotice, Panel, StatusPill } from "../../../components/AppFrame";
import {
  formatImageAspectRatio,
  GeneratedImageLightbox,
  GeneratedImagePreviewButton
} from "../../../components/GeneratedImagePreview";
import {
  apiFetch,
  downloadGeneratedImage,
  formatCredits,
  formatQualityLabel,
  formatStyleLabel,
  resolveSelectableImageModel,
  type GeneratedImage,
  type GenerationMetadata,
  type Task
} from "../../../lib/api";
import { buildGeneratePath, saveGenerationDraft } from "../../../lib/generateDrafts";

type TaskDetail = {
  task: Task;
  images: GeneratedImage[];
};

export default function ImageDetailPage() {
  const params = useParams<{ imageId: string }>();
  const router = useRouter();
  const imageId = params.imageId;
  const [image, setImage] = useState<GeneratedImage | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<GeneratedImage | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingImage, setDeletingImage] = useState(false);

  useEffect(() => {
    void loadDetail();
  }, [imageId]);

  function regenerateTask() {
    const metadata = image?.generationMetadata ?? (task ? metadataFromTask(task) : null);
    if (!metadata) {
      router.push("/generate");
      return;
    }
    saveImageGenerationDraft(metadata, "reuse");
  }

  function createVariation() {
    const metadata = image?.generationMetadata ?? (task ? metadataFromTask(task) : null);
    if (!metadata) {
      router.push("/generate");
      return;
    }
    saveImageGenerationDraft(metadata, "variation");
  }

  function saveImageGenerationDraft(metadata: GenerationMetadata, mode: "reuse" | "variation") {
    const prompt = mode === "variation" ? `${metadata.prompt}，保持主体一致，生成新的构图与细节变化` : metadata.prompt;
    saveGenerationDraft({
      prompt,
      negativePrompt: metadata.negativePrompt ?? undefined,
      style: metadata.style,
      aspectRatio: metadata.aspectRatio,
      quality: metadata.quality,
      quantity: mode === "variation" ? 1 : metadata.quantity,
      model: resolveSelectableImageModel(metadata.modelName),
      mode
    });
    router.push(
      buildGeneratePath({
        style: metadata.style,
        aspectRatio: metadata.aspectRatio,
        quality: metadata.quality,
        quantity: mode === "variation" ? 1 : metadata.quantity,
        model: resolveSelectableImageModel(metadata.modelName)
      })
    );
  }

  async function loadDetail() {
    setLoading(true);
    setMessage("");
    setSelectedPreviewImage(null);
    try {
      const imageResult = await apiFetch<{ image: GeneratedImage }>(`/api/images/${imageId}`);
      setImage(imageResult.image);
      const taskResult = await apiFetch<TaskDetail>(`/api/generation/tasks/${imageResult.image.taskId}`);
      setTask(taskResult.task);
      setImage(taskResult.images.find((item) => item.id === imageResult.image.id) ?? imageResult.image);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片详情加载失败，请稍后重试。");
      setImage(null);
      setTask(null);
    } finally {
      setLoading(false);
    }
  }

  async function copyPrompt() {
    if (!task) {
      return;
    }
    await navigator.clipboard.writeText(task.prompt);
    setMessage("提示词已复制。");
  }

  async function toggleFavorite() {
    if (!image) {
      return;
    }
    try {
      await apiFetch<{ imageId: string; favorite: boolean }>(`/api/images/${image.id}/favorite`, {
        method: image.favorite ? "DELETE" : "POST"
      });
      setImage({ ...image, favorite: !image.favorite });
      setMessage(image.favorite ? "已取消收藏。" : "已加入收藏。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "收藏状态更新失败，请稍后重试。");
    }
  }

  async function downloadImage() {
    if (!image) {
      return;
    }
    try {
      await downloadGeneratedImage(image.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下载链接获取失败，请稍后重试。");
    }
  }

  async function confirmDeleteImage() {
    if (!image) {
      return;
    }
    setDeletingImage(true);
    try {
      await apiFetch<{ imageId: string; deleted: boolean }>(`/api/images/${image.id}`, {
        method: "DELETE"
      });
      router.push("/history");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setDeletingImage(false);
    }
  }

  return (
    <AppFrame title="图片详情" subtitle="查看生成图、任务参数、资产状态，并直接执行下载、收藏、删除和再次生成。">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link
          className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
          href="/history"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          返回历史
        </Link>
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
          type="button"
          onClick={() => void loadDetail()}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          刷新
        </button>
      </div>

      {message ? (
        <div className="mb-5">
          <InlineNotice tone={message.includes("失败") || message.includes("不可用") ? "danger" : "success"}>
            {message}
          </InlineNotice>
        </div>
      ) : null}

      {loading ? (
        <Panel>
          <div className="flex min-h-72 items-center justify-center text-sm text-white/54">正在加载图片详情...</div>
        </Panel>
      ) : image && task ? (
        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <Panel className="overflow-hidden p-0">
            <div className="border-b border-white/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-white/50">图片编号</p>
                  <p className="mt-1 break-all text-sm text-white/78">{image.id}</p>
                </div>
                <StatusPill>{image.visibility}</StatusPill>
              </div>
            </div>
            <div className="bg-black/26 p-4">
              <GeneratedImagePreviewButton
                alt="生成图片详情预览"
                ariaLabel="预览当前生成图片"
                className="max-h-[72vh] bg-black/30 hover:translate-y-0"
                image={image}
                imageClassName="object-contain bg-black/18"
                onOpen={() => setSelectedPreviewImage(image)}
              />
            </div>
          </Panel>

          <div className="space-y-5">
            <Panel>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <button
                  className="icon-action"
                  type="button"
                  onClick={() => void toggleFavorite()}
                  aria-label={image.favorite ? "取消收藏" : "收藏图片"}
                  title={image.favorite ? "取消收藏" : "收藏图片"}
                >
                  <Heart className={`size-4 ${image.favorite ? "fill-current text-ember" : ""}`} aria-hidden="true" />
                </button>
                <button
                  className="icon-action"
                  type="button"
                  onClick={() => void downloadImage()}
                  aria-label="下载图片"
                  title="下载图片"
                >
                  <Download className="size-4" aria-hidden="true" />
                </button>
                <button
                  className="icon-action"
                  type="button"
                  onClick={() => void copyPrompt()}
                  aria-label="复制提示词"
                  title="复制提示词"
                >
                  <Copy className="size-4" aria-hidden="true" />
                </button>
                <button
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/12 px-3 py-2 text-sm text-white/72 transition-colors duration-200 hover:bg-white/10 hover:text-white"
                  onClick={regenerateTask}
                  type="button"
                >
                  <Copy className="size-4" aria-hidden="true" />
                  复用参数
                </button>
                <button
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-mint/36 px-3 py-2 text-sm text-mint transition-colors duration-200 hover:bg-mint/10"
                  onClick={createVariation}
                  type="button"
                >
                  <Repeat2 className="size-4" aria-hidden="true" />
                  生成变体
                </button>
                <button
                  className="icon-action"
                  type="button"
                  onClick={() => setDeleteConfirmOpen(true)}
                  aria-label="删除图片"
                  title="删除图片"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
                <button
                  className="focus-ring ml-auto inline-flex items-center gap-2 rounded-full bg-mint px-3 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
                  onClick={regenerateTask}
                  type="button"
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  再次生成
                </button>
              </div>
              <p className="text-sm leading-6 text-white/76">{task.prompt}</p>
              {task.failureMessage ? (
                <p className="mt-4 rounded-2xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember">
                  {task.failureMessage}
                </p>
              ) : null}
            </Panel>

            <Panel>
              <h2 className="mb-4 text-lg font-semibold">生成参数</h2>
              <dl className="grid gap-3 text-sm text-white/58 sm:grid-cols-2">
                <DetailItem label="任务状态" value={<StatusPill>{task.status}</StatusPill>} />
                <DetailItem label="风格" value={formatStyleLabel(image.generationMetadata.style)} />
                <DetailItem label="画面比例" value={image.generationMetadata.aspectRatio} />
                <DetailItem label="质量" value={formatQualityLabel(image.generationMetadata.quality)} />
                <DetailItem label="生成数量" value={`${image.generationMetadata.quantity} 张`} />
                <DetailItem label="积分消耗" value={formatCredits(image.generationMetadata.creditCost)} />
              </dl>
            </Panel>

            <Panel>
              <h2 className="mb-4 text-lg font-semibold">任务时间</h2>
              <dl className="grid gap-3 text-sm text-white/58 sm:grid-cols-2">
                <DetailItem label="创建时间" value={formatTaskTimestamp(task.createdAt)} />
                <DetailItem label="开始时间" value={formatTaskTimestamp(task.startedAt)} />
                <DetailItem label="完成时间" value={formatTaskTimestamp(task.completedAt)} />
                <DetailItem label="更新时间" value={formatTaskTimestamp(task.updatedAt)} />
              </dl>
            </Panel>

            <Panel>
              <h2 className="mb-4 text-lg font-semibold">资产信息</h2>
              <dl className="grid gap-3 text-sm text-white/58 sm:grid-cols-2">
                <DetailItem label="尺寸" value={`${image.width} × ${image.height}`} />
                <DetailItem label="实际比例" value={formatImageAspectRatio(image.width, image.height)} />
                <DetailItem label="格式" value={image.mimeType ?? "未知"} />
                <DetailItem label="文件大小" value={formatFileSize(image.fileSize)} />
                <DetailItem label="生成时间" value={formatTaskTimestamp(image.createdAt)} />
                <DetailItem label="缩略图 Key" value={image.thumbnailKey ?? "-"} wide />
                <DetailItem label="原图 Key" value={image.storageKey ?? "-"} wide />
              </dl>
            </Panel>
          </div>
        </div>
      ) : (
        <Panel>
          <EmptyState
            title="图片详情不可用"
            description="图片不存在、已删除，或当前账号没有访问权限。"
            actionLabel="重试加载"
            onAction={() => void loadDetail()}
          />
        </Panel>
      )}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="确认删除图片？"
        description="删除后会返回历史记录页，这张图片将不再出现在当前资产列表中。"
        confirmLabel="删除图片"
        loading={deletingImage}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void confirmDeleteImage()}
      />
      <GeneratedImageLightbox image={selectedPreviewImage} onClose={() => setSelectedPreviewImage(null)} />
    </AppFrame>
  );
}

function DetailItem({ label, value, wide = false }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt>{label}</dt>
      <dd className="mt-1 break-all text-white/82">{value}</dd>
    </div>
  );
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

function formatFileSize(value: number | undefined): string {
  if (!value) {
    return "-";
  }
  if (value < 1024 * 1024) {
    return `${Math.ceil(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function metadataFromTask(task: Task): GenerationMetadata {
  return {
    taskId: task.id,
    prompt: task.prompt,
    negativePrompt: task.negativePrompt,
    style: task.style,
    aspectRatio: task.aspectRatio,
    quality: task.quality,
    quantity: task.quantity,
    modelProvider: task.modelProvider,
    modelName: task.modelName,
    width: task.width,
    height: task.height,
    creditCost: task.creditCost,
    createdAt: task.createdAt
  };
}
