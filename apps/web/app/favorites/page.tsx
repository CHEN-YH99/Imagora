"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Heart } from "lucide-react";
import { AppFrame, ConfirmDialog, EmptyState, InlineNotice, Panel } from "../../components/AppFrame";
import { GeneratedImageLightbox, GeneratedImagePreviewButton } from "../../components/GeneratedImagePreview";
import { apiFetch, type GeneratedImage, type ImageProject, type PageInfo } from "../../lib/api";

const favoritesPageSize = 50;

export default function FavoritesPage() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [message, setMessage] = useState("");
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<GeneratedImage | null>(null);
  const [pendingRemove, setPendingRemove] = useState<GeneratedImage | null>(null);
  const [projects, setProjects] = useState<ImageProject[]>([]);
  const [removing, setRemoving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    void loadFavorites();
  }, []);

  async function loadFavorites(options: { append?: boolean } = {}) {
    const append = options.append ?? false;
    if (append) {
      if (loading || loadingMore || !pageInfo?.hasMore) {
        return;
      }
      setLoadingMore(true);
    } else {
      setLoading(true);
      setMessage("");
    }
    try {
      const offset = append ? images.length : 0;
      const [imageResult, projectResult] = await Promise.all([
        apiFetch<{ images: GeneratedImage[]; pageInfo: PageInfo }>(
          `/api/images?favorite=true&limit=${favoritesPageSize}&offset=${offset}`
        ),
        apiFetch<{ projects: ImageProject[] }>("/api/image-projects")
      ]);
      setImages((current) => (append ? mergeImages(current, imageResult.images) : imageResult.images));
      setPageInfo(imageResult.pageInfo);
      setProjects(projectResult.projects);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "收藏加载失败，请稍后重试。");
    } finally {
      if (append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }

  async function confirmRemoveFavorite() {
    if (!pendingRemove) {
      return;
    }
    setRemoving(true);
    setMessage("");
    try {
      await apiFetch<{ imageId: string; favorite: boolean }>(`/api/images/${pendingRemove.id}/favorite`, {
        method: "DELETE"
      });
      const nextLength = images.filter((image) => image.id !== pendingRemove.id).length;
      setImages((current) => current.filter((image) => image.id !== pendingRemove.id));
      setPageInfo((current) =>
        current
          ? {
              ...current,
              total: Math.max(0, current.total - 1),
              hasMore: nextLength < Math.max(0, current.total - 1)
            }
          : current
      );
      setSelectedPreviewImage((value) => (value?.id === pendingRemove.id ? null : value));
      setMessage("已取消收藏。");
      setPendingRemove(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取消收藏失败，请稍后重试。");
    } finally {
      setRemoving(false);
    }
  }

  async function assignImageProject(image: GeneratedImage, projectId: string | null) {
    try {
      const result = await apiFetch<{ image: GeneratedImage }>(`/api/images/${image.id}/project`, {
        method: "POST",
        body: { projectId }
      });
      setImages((items) => items.map((item) => (item.id === image.id ? { ...result.image, favorite: true } : item)));
      setMessage(projectId ? "收藏图片已保存到项目。" : "收藏图片已移出项目。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目移动失败，请稍后重试。");
    }
  }

  return (
    <AppFrame title="我的收藏" subtitle="集中保存可复用的生成图片，方便后续下载、归档和延展创作。">
      <Panel>
        {message ? (
          <div className="mb-4">
            <InlineNotice tone={message.includes("已取消") ? "success" : "danger"}>
              {message}
              {!message.includes("已取消") ? (
                <>
                  {" "}
                  <button className="underline underline-offset-4" onClick={() => void loadFavorites()} type="button">
                    重新加载收藏
                  </button>
                </>
              ) : null}
            </InlineNotice>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {images.map((image, index) => (
            <article key={image.id} className="rounded-2xl border border-white/12 bg-black/20 p-3">
              <GeneratedImagePreviewButton
                alt="收藏的生成图片"
                ariaLabel={`预览收藏第 ${index + 1} 张生成图片`}
                className="rounded-xl hover:translate-y-0"
                image={image}
                onOpen={() => setSelectedPreviewImage(image)}
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="inline-flex items-center gap-2 text-sm text-white/64">
                  <Heart className="size-4 text-plasma" aria-hidden="true" />
                  已收藏
                </p>
                <div className="flex items-center gap-2">
                  <Link
                    className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/68 transition-colors hover:bg-white/10 hover:text-white"
                    href={`/images/${image.id}`}
                  >
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    详情
                  </Link>
                  <button
                    className="focus-ring rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/68 transition-colors hover:bg-white/10 hover:text-white"
                    onClick={() => setPendingRemove(image)}
                    type="button"
                  >
                    取消收藏
                  </button>
                </div>
              </div>
              <label className="mt-3 block text-xs text-white/50">
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
            </article>
          ))}
          {images.length === 0 ? (
            <div className="sm:col-span-2 lg:col-span-4">
              {loading ? (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-8 text-center text-sm text-white/55">
                  正在加载收藏…
                </div>
              ) : (
                <EmptyState
                  title="暂无收藏图片"
                  description="在历史或图片详情中收藏满意的生成图后，它们会集中显示在这里。"
                  actionLabel={message ? "重新加载收藏" : "去生成图片"}
                  actionHref={message ? undefined : "/generate"}
                  onAction={message ? () => void loadFavorites() : undefined}
                />
              )}
            </div>
          ) : null}
        </div>
        {pageInfo?.hasMore ? (
          <div className="mt-5 flex justify-center">
            <button
              className="focus-ring rounded-full border border-white/12 px-4 py-2 text-sm text-white/72 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loadingMore}
              onClick={() => void loadFavorites({ append: true })}
              type="button"
            >
              {loadingMore ? "正在加载…" : `加载更多（已显示 ${images.length}/${pageInfo.total}）`}
            </button>
          </div>
        ) : null}
      </Panel>
      <ConfirmDialog
        open={Boolean(pendingRemove)}
        title="确认取消收藏？"
        description="取消后图片会从收藏页移除，但仍可在历史记录和详情页重新加入收藏。"
        confirmLabel="取消收藏"
        loading={removing}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => void confirmRemoveFavorite()}
      />
      <GeneratedImageLightbox image={selectedPreviewImage} onClose={() => setSelectedPreviewImage(null)} />
    </AppFrame>
  );
}

function mergeImages(current: GeneratedImage[], next: GeneratedImage[]): GeneratedImage[] {
  const currentIds = new Set(current.map((image) => image.id));
  return [...current, ...next.filter((image) => !currentIds.has(image.id))];
}
