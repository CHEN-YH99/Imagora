"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { AppFrame, ConfirmDialog, EmptyState, InlineNotice, Panel } from "../../components/AppFrame";
import { apiFetch, type GeneratedImage } from "../../lib/api";

export default function FavoritesPage() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [message, setMessage] = useState("");
  const [pendingRemove, setPendingRemove] = useState<GeneratedImage | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    void loadFavorites();
  }, []);

  async function loadFavorites() {
    setMessage("");
    apiFetch<{ images: GeneratedImage[] }>("/api/images?limit=100")
      .then((result) => setImages(result.images.filter((image) => image.favorite)))
      .catch((error) => setMessage(error instanceof Error ? error.message : "收藏加载失败，请稍后重试。"));
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
      setImages((current) => current.filter((image) => image.id !== pendingRemove.id));
      setMessage("已取消收藏。");
      setPendingRemove(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取消收藏失败，请稍后重试。");
    } finally {
      setRemoving(false);
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
          {images.map((image) => (
            <article key={image.id} className="rounded-2xl border border-white/12 bg-black/20 p-3">
              <Link className="focus-ring block" href={`/images/${image.id}`}>
                <img className="aspect-square rounded-xl object-cover" src={image.publicUrl} alt="收藏的生成图片" />
              </Link>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="inline-flex items-center gap-2 text-sm text-white/64">
                  <Heart className="size-4 text-plasma" aria-hidden="true" />
                  已收藏
                </p>
                <button
                  className="focus-ring rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/68 transition-colors hover:bg-white/10 hover:text-white"
                  onClick={() => setPendingRemove(image)}
                  type="button"
                >
                  取消收藏
                </button>
              </div>
            </article>
          ))}
          {images.length === 0 ? (
            <div className="sm:col-span-2 lg:col-span-4">
              <EmptyState
                title="暂无收藏图片"
                description="在历史或图片详情中收藏满意的生成图后，它们会集中显示在这里。"
                actionLabel={message ? "重新加载收藏" : "去生成图片"}
                actionHref={message ? undefined : "/generate"}
                onAction={message ? () => void loadFavorites() : undefined}
              />
            </div>
          ) : null}
        </div>
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
    </AppFrame>
  );
}
