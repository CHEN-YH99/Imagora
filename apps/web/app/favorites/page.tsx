"use client";

import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { AppFrame, Panel } from "../../components/AppFrame";
import { apiFetch, getStoredToken, type GeneratedImage } from "../../lib/api";

export default function FavoritesPage() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setMessage("Sign in first.");
      return;
    }
    apiFetch<{ images: GeneratedImage[] }>("/api/images?limit=100", { token })
      .then((result) => setImages(result.images.filter((image) => image.favorite)))
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load favorites"));
  }, []);

  return (
    <AppFrame title="Favorites" subtitle="收藏是创作资产复用的入口，别生成完就让用户自己去硬盘里捞。">
      <Panel>
        {message ? <p className="mb-4 text-sm text-white/60">{message}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {images.map((image) => (
            <article key={image.id} className="rounded-2xl border border-white/12 bg-black/20 p-3">
              <img className="aspect-square rounded-xl object-cover" src={image.publicUrl} alt="Favorite generated image" />
              <p className="mt-3 inline-flex items-center gap-2 text-sm text-white/64">
                <Heart className="size-4 text-plasma" aria-hidden="true" />
                Saved
              </p>
            </article>
          ))}
          {images.length === 0 ? <p className="text-sm text-white/50">No favorites yet.</p> : null}
        </div>
      </Panel>
    </AppFrame>
  );
}
