"use client";

import { useEffect, useState } from "react";
import { AppFrame, Panel, StatusPill } from "../../components/AppFrame";
import { apiFetch, getStoredToken, type GeneratedImage, type Task } from "../../lib/api";

export default function HistoryPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setMessage("Sign in first. Demo account is available on the login page.");
      return;
    }
    Promise.all([
      apiFetch<{ tasks: Task[] }>("/api/generation/tasks?limit=50", { token }),
      apiFetch<{ images: GeneratedImage[] }>("/api/images?limit=50", { token })
    ])
      .then(([taskResult, imageResult]) => {
        setTasks(taskResult.tasks);
        setImages(imageResult.images);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load history"));
  }, []);

  return (
    <AppFrame title="Generation History" subtitle="任务和图片分开展示，符合文档里任务状态恢复和图片资产管理的要求。">
      {message ? <p className="mb-5 rounded-2xl border border-white/12 bg-white/7 p-4 text-sm text-white/70">{message}</p> : null}
      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Tasks</h2>
          <div className="space-y-3">
            {tasks.map((task) => (
              <article key={task.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm leading-6 text-white/74">{task.prompt}</p>
                  <StatusPill>{task.status}</StatusPill>
                </div>
                <p className="mt-3 text-xs text-white/46">
                  {task.style} · {task.aspectRatio} · {task.quantity} image(s) · {task.creditCost} credits
                </p>
              </article>
            ))}
            {tasks.length === 0 ? <p className="text-sm text-white/50">No tasks yet.</p> : null}
          </div>
        </Panel>
        <Panel>
          <h2 className="mb-4 text-xl font-semibold">Images</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {images.map((image) => (
              <img key={image.id} className="aspect-square rounded-2xl border border-white/12 object-cover" src={image.publicUrl} alt="Generated history item" />
            ))}
          </div>
        </Panel>
      </div>
    </AppFrame>
  );
}
