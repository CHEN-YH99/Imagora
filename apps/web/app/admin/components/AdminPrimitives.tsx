import type { ReactNode } from "react";
import { Panel } from "../../../components/AppFrame";
import { resolveImageSrc, type GeneratedImage } from "../../../lib/api";

export function AdminImagePreview({ image, alt, className }: { image: GeneratedImage; alt: string; className: string }) {
  const imageSrc = resolveImageSrc(image.thumbnailUrl, image.publicUrl);

  if (!imageSrc) {
    return (
      <div
        aria-label={alt}
        className={`flex min-h-24 items-center justify-center bg-black/30 px-3 text-center text-xs text-white/45 ${className}`}
        role="img"
        style={{ aspectRatio: `${image.width} / ${image.height}` }}
      >
        预览暂不可用
      </div>
    );
  }

  return (
    <img
      alt={alt}
      className={className}
      decoding="async"
      height={image.height}
      loading="lazy"
      src={imageSrc}
      width={image.width}
    />
  );
}

export function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <Panel>
      <p className="text-sm text-white/50">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </Panel>
  );
}

export function MiniStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center">
      <p className="text-lg font-semibold">{value}</p>
      <p className="mt-1 text-xs text-white/50">{label}</p>
    </div>
  );
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-xs text-white/52 ${className}`}>
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
