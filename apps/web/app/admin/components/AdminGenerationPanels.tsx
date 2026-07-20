import type { Dispatch, SetStateAction } from "react";
import { Eye, EyeOff } from "lucide-react";
import { EmptyState, Panel, StatusPill } from "../../../components/AppFrame";
import {
  formatCredits,
  formatStyleLabel,
  type GeneratedImage,
  type Task
} from "../../../lib/api";
import { AdminImagePreview, Field } from "./AdminPrimitives";

type AdminGenerationPanelsProps = {
  tasks: Task[];
  taskStatusFilter: "ALL" | Task["status"];
  setTaskStatusFilter: Dispatch<SetStateAction<"ALL" | Task["status"]>>;
  images: GeneratedImage[];
  imageVisibilityFilter: "ALL" | GeneratedImage["visibility"];
  setImageVisibilityFilter: Dispatch<SetStateAction<"ALL" | GeneratedImage["visibility"]>>;
  onOpenTaskDetail(taskId: string): void;
  onOpenImageDetail(imageId: string): void;
  onRequestImageVisibilityChange(image: GeneratedImage): void;
  onRefresh(): void;
  onRefreshImages(): void;
};

export function AdminGenerationPanels({
  tasks,
  taskStatusFilter,
  setTaskStatusFilter,
  images,
  imageVisibilityFilter,
  setImageVisibilityFilter,
  onOpenTaskDetail,
  onOpenImageDetail,
  onRequestImageVisibilityChange,
  onRefresh,
  onRefreshImages
}: AdminGenerationPanelsProps) {
  return (
    <>
      <Panel>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-xl font-semibold">生成任务</h2>
          <Field label="任务状态">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={taskStatusFilter}
              onChange={(event) => setTaskStatusFilter(event.target.value as "ALL" | Task["status"])}
            >
              <option value="ALL">全部状态</option>
              <option value="PENDING">待处理</option>
              <option value="RUNNING">处理中</option>
              <option value="SUCCEEDED">已完成</option>
              <option value="FAILED">失败</option>
              <option value="BLOCKED">已拦截</option>
              <option value="CANCELED">已取消</option>
            </select>
          </Field>
        </div>
        <div className="space-y-3">
          {tasks.map((task) => (
            <article key={task.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="line-clamp-2 text-sm text-white/70">{task.prompt}</p>
                  <p className="mt-1 break-all text-xs text-white/36">{task.userId}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <StatusPill>{task.status}</StatusPill>
                  <button
                    className="focus-ring inline-flex items-center gap-1 rounded-full border border-white/12 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:border-mint/70"
                    onClick={() => onOpenTaskDetail(task.id)}
                    type="button"
                  >
                    <Eye className="size-3" aria-hidden="true" />
                    详情
                  </button>
                </div>
              </div>
              <p className="mt-2 text-xs text-white/42">
                {formatCredits(task.creditCost)} · {formatStyleLabel(task.style)} · {task.aspectRatio}
              </p>
            </article>
          ))}
          {tasks.length === 0 ? (
            <EmptyState
              title="暂无符合条件的生成任务"
              description="当前筛选条件下没有任务，调整状态筛选或刷新任务列表后再看。"
              actionLabel="刷新任务"
              onAction={onRefresh}
            />
          ) : null}
        </div>
      </Panel>

      <Panel>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-xl font-semibold">图片资产</h2>
          <Field label="可见性筛选">
            <select
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              value={imageVisibilityFilter}
              onChange={(event) =>
                setImageVisibilityFilter(event.target.value as "ALL" | GeneratedImage["visibility"])
              }
            >
              <option value="ALL">全部可见性</option>
              <option value="PRIVATE">私有</option>
              <option value="PUBLIC">公开</option>
              <option value="HIDDEN">已隐藏</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {images.map((image) => (
            <article key={image.id} className="overflow-hidden rounded-2xl border border-white/12 bg-black/20">
              <AdminImagePreview image={image} alt="后台图片预览" className="aspect-square w-full object-cover" />
              <div className="space-y-2 p-3">
                <StatusPill>{image.visibility}</StatusPill>
                <button
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-2 py-2 text-xs text-white transition-colors hover:border-mint/70"
                  onClick={() => onOpenImageDetail(image.id)}
                  type="button"
                >
                  <Eye className="size-3" aria-hidden="true" />
                  详情
                </button>
                <button
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/12 px-2 py-2 text-xs text-white transition-colors hover:border-mint/70"
                  onClick={() => onRequestImageVisibilityChange(image)}
                  type="button"
                >
                  {image.visibility === "HIDDEN" ? (
                    <Eye className="size-3" aria-hidden="true" />
                  ) : (
                    <EyeOff className="size-3" aria-hidden="true" />
                  )}
                  {image.visibility === "HIDDEN" ? "恢复显示" : "隐藏图片"}
                </button>
              </div>
            </article>
          ))}
          {images.length === 0 ? (
            <div className="col-span-full">
              <EmptyState
                title="暂无符合条件的图片资产"
                description="当前筛选条件下没有可见图片，调整筛选后再看。"
                actionLabel="刷新图片"
                onAction={onRefreshImages}
              />
            </div>
          ) : null}
        </div>
      </Panel>
    </>
  );
}
