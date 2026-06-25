"use client";

import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { AppFrame, Panel } from "../../components/AppFrame";
import { apiFetch, type GeneratedImage } from "../../lib/api";

export default function FavoritesPage() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiFetch<{ images: GeneratedImage[] }>("/api/images?limit=100")
      .then((result) => setImages(result.images.filter((image) => image.favorite)))
      .catch((error) => setMessage(error instanceof Error ? error.message : "收藏加载失败，请稍后重试。"));
  }, []);

  return (
    <AppFrame title="我的收藏" subtitle="集中保存可复用的生成图片，方便后续下载、归档和延展创作。">
      <Panel>
        {message ? <p className="mb-4 text-sm text-white/60">{message}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {images.map((image) => (
            <article key={image.id} className="rounded-2xl border border-white/12 bg-black/20 p-3">
              <img className="aspect-square rounded-xl object-cover" src={image.publicUrl} alt="收藏的生成图片" />
              <p className="mt-3 inline-flex items-center gap-2 text-sm text-white/64">
                <Heart className="size-4 text-plasma" aria-hidden="true" />
                已收藏
              </p>
            </article>
          ))}
          {images.length === 0 ? <p className="text-sm text-white/50">暂无收藏图片。</p> : null}
        </div>
      </Panel>
    </AppFrame>
  );
}
