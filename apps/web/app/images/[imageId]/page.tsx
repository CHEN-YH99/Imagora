"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, Copy, Download, Heart, RefreshCw, Trash2 } from "lucide-react";
import { AppFrame, Panel, StatusPill } from "../../../components/AppFrame";
import {
  apiFetch,
  formatCredits,
  formatQualityLabel,
  formatStyleLabel,
  type GeneratedImage,
  type Task
} from "../../../lib/api";

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

  useEffect(() => {
    void loadDetail();
  }, [imageId]);

  const generatedAgainHref = useMemo(() => {
    if (!task) {
      return "/generate";
    }
    return `/generate?prompt=${encodeURIComponent(task.prompt)}&style=${encodeURIComponent(task.style)}&aspectRatio=${encodeURIComponent(task.aspectRatio)}&quality=${encodeURIComponent(task.quality)}&quantity=${task.quantity}`;
  }, [task]);

  async function loadDetail() {
    setLoading(true);
    setMessage("");
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
      const result = await apiFetch<{ url: string; fileName: string }>(`/api/images/${image.id}/download-url`, {
        method: "POST",
        body: {}
      });
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = result.fileName;
      anchor.rel = "noreferrer";
      anchor.click();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下载链接获取失败，请稍后重试。");
    }
  }

  async function deleteImage() {
    if (!image || !window.confirm("确定从历史记录中删除这张生成图片？")) {
      return;
    }
    try {
      await apiFetch<{ imageId: string; deleted: boolean }>(`/api/images/${image.id}`, {
        method: "DELETE"
      });
      router.push("/history");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败，请稍后重试。");
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
        <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/72">{message}</p>
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
              <img
                className="max-h-[72vh] w-full rounded-2xl border border-white/12 object-contain"
                src={image.publicUrl}
                alt="生成图片详情预览"
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
                  className="icon-action"
                  type="button"
                  onClick={() => void deleteImage()}
                  aria-label="删除图片"
                  title="删除图片"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
                <Link
                  className="focus-ring ml-auto inline-flex items-center gap-2 rounded-full bg-mint px-3 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
                  href={generatedAgainHref}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  再次生成
                </Link>
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
                <DetailItem label="风格" value={formatStyleLabel(task.style)} />
                <DetailItem label="画面比例" value={task.aspectRatio} />
                <DetailItem label="质量" value={formatQualityLabel(task.quality)} />
                <DetailItem label="生成数量" value={`${task.quantity} 张`} />
                <DetailItem label="积分消耗" value={formatCredits(task.creditCost)} />
              </dl>
            </Panel>

            <Panel>
              <h2 className="mb-4 text-lg font-semibold">资产信息</h2>
              <dl className="grid gap-3 text-sm text-white/58 sm:grid-cols-2">
                <DetailItem label="尺寸" value={`${image.width} × ${image.height}`} />
                <DetailItem label="格式" value={image.mimeType ?? "未知"} />
                <DetailItem label="文件大小" value={formatFileSize(image.fileSize)} />
                <DetailItem label="生成时间" value={formatDate(image.createdAt)} />
                <DetailItem label="缩略图 Key" value={image.thumbnailKey ?? "-"} wide />
                <DetailItem label="原图 Key" value={image.storageKey ?? "-"} wide />
              </dl>
            </Panel>
          </div>
        </div>
      ) : (
        <Panel>
          <div className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
            <AlertCircle className="size-8 text-ember" aria-hidden="true" />
            <div>
              <h2 className="text-lg font-semibold">图片详情不可用</h2>
              <p className="mt-2 text-sm text-white/54">图片不存在、已删除，或当前账号没有访问权限。</p>
            </div>
            <button
              className="focus-ring rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:bg-volt"
              type="button"
              onClick={() => void loadDetail()}
            >
              重试加载
            </button>
          </div>
        </Panel>
      )}
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
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
