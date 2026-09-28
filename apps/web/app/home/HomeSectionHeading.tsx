import { Zap } from "lucide-react";

export function SectionHeading({
  eyebrow,
  title,
  description
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="max-w-3xl">
      <p className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-white/70">
        <Zap className="size-4 text-ember" aria-hidden="true" />
        {eyebrow}
      </p>
      <h2 className="mt-5 text-3xl font-semibold leading-tight text-white sm:text-5xl">{title}</h2>
      <p className="mt-5 text-base leading-8 text-white/68">{description}</p>
    </div>
  );
}
