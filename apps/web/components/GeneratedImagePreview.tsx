"use client";

import { Sparkles, X } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { resolveImageSrc, type GeneratedImage } from "../lib/api";

export function GeneratedImagePreviewButton({
  image,
  alt,
  ariaLabel,
  onOpen,
  className = "",
  imageClassName = "object-cover"
}: {
  image: GeneratedImage;
  alt: string;
  ariaLabel: string;
  onOpen: () => void;
  className?: string;
  imageClassName?: string;
}) {
  const thumbnailSrc = resolveImageSrc(image.thumbnailUrl, image.publicUrl);

  return (
    <button
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      className={`focus-ring group relative w-full cursor-zoom-in overflow-hidden rounded-2xl border border-white/12 bg-black/28 text-left motion-reduce:transform-none motion-reduce:transition-none transition duration-200 hover:-translate-y-0.5 hover:border-mint/60 hover:shadow-glow ${className}`}
      disabled={!thumbnailSrc}
      onClick={thumbnailSrc ? onOpen : undefined}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
      type="button"
    >
      {thumbnailSrc ? (
        <img
          alt={alt}
          className={`h-full w-full motion-reduce:transform-none motion-reduce:transition-none transition duration-300 group-hover:scale-[1.025] ${imageClassName}`}
          decoding="async"
          height={image.height}
          loading="lazy"
          src={thumbnailSrc}
          width={image.width}
        />
      ) : (
        <span
          aria-label={alt}
          className="flex h-full w-full items-center justify-center bg-black/30 px-4 text-center text-sm text-white/45"
          role="img"
        >
          预览暂不可用
        </span>
      )}
      {thumbnailSrc ? (
        <>
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/84 via-ink/24 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100" />
          <span className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center px-4 opacity-0 transition duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="inline-flex items-center gap-2 rounded-full border border-cyanx/32 bg-ink/78 px-3 py-2 text-sm font-medium text-white shadow-glow backdrop-blur-md">
              <Sparkles className="size-4 text-mint" aria-hidden="true" />
              查看原图
            </span>
          </span>
        </>
      ) : null}
      <span className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-white/12 bg-ink/78 px-2.5 py-1 text-[11px] font-medium text-white/74 backdrop-blur-md">
        比例 {formatImageAspectRatio(image.width, image.height)}
      </span>
    </button>
  );
}

export function GeneratedImageLightbox({
  image,
  alt = "生成图片大图预览",
  ariaLabel = "生成图片大图预览",
  onClose
}: {
  image: GeneratedImage | null;
  alt?: string;
  ariaLabel?: string;
  onClose: () => void;
}) {
  const lightboxSrc = image ? resolveImageSrc(image.thumbnailUrl, image.publicUrl) : null;
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  useEffect(() => {
    if (!image) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [image, onClose]);

  useEffect(() => {
    setIsImageLoaded(false);
    setImageLoadFailed(false);
  }, [lightboxSrc]);

  if (!image) {
    return null;
  }

  return (
    <div
      aria-label={ariaLabel}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/94 px-4 py-6 backdrop-blur-xl"
      onClick={onClose}
      role="dialog"
    >
      <button
        aria-label="关闭大图预览"
        className="focus-ring absolute right-4 top-4 inline-flex size-10 items-center justify-center rounded-full border border-white/12 bg-white/8 text-white/70 transition-colors duration-200 hover:bg-white/14 hover:text-white"
        onClick={onClose}
        type="button"
      >
        <X className="size-5" aria-hidden="true" />
      </button>
      <figure
        className="relative flex max-h-[88vh] max-w-[min(96vw,1200px)] flex-col items-center"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="relative flex max-h-[82vh] max-w-[96vw] items-center justify-center overflow-hidden rounded-2xl border border-white/16 bg-black/30 shadow-glow"
          style={lightboxFrameStyle(image.width, image.height)}
        >
          {lightboxSrc && !imageLoadFailed ? (
            <img
              key={lightboxSrc}
              alt={alt}
              className={`h-full w-full object-contain transition-opacity duration-200 ${
                isImageLoaded ? "opacity-100" : "opacity-0"
              }`}
              decoding="async"
              height={image.height}
              onError={() => setImageLoadFailed(true)}
              onLoad={() => setIsImageLoaded(true)}
              src={lightboxSrc}
              width={image.width}
            />
          ) : (
            <span
              aria-label={alt}
              className="flex h-full min-h-48 w-full items-center justify-center px-6 text-center text-sm text-white/45"
              role="img"
            >
              预览暂不可用
            </span>
          )}
          {lightboxSrc && !isImageLoaded && !imageLoadFailed ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/50 text-sm text-white/58">
              图片加载中...
            </span>
          ) : null}
        </div>
        <figcaption className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-white/58">
          <span className="rounded-full border border-white/12 bg-white/7 px-3 py-1 backdrop-blur-sm">
            {image.width} × {image.height}
          </span>
          <span className="rounded-full border border-cyanx/32 bg-cyanx/10 px-3 py-1 text-cyanx backdrop-blur-sm">
            比例 {formatImageAspectRatio(image.width, image.height)}
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

function lightboxFrameStyle(width: number, height: number): CSSProperties {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      aspectRatio: "1 / 1",
      width: "min(96vw, 82vh, 1200px)"
    };
  }

  const roundedWidth = Math.max(1, Math.round(width));
  const roundedHeight = Math.max(1, Math.round(height));
  return {
    aspectRatio: `${roundedWidth} / ${roundedHeight}`,
    width: `min(96vw, 1200px, calc(82vh * ${roundedWidth} / ${roundedHeight}))`
  };
}

export function formatImageAspectRatio(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "-";
  }

  const divisor = greatestCommonDivisor(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || 1;
}
