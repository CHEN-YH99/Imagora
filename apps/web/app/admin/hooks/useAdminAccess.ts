"use client";

import { useEffect, useState } from "react";
import { getCurrentUser, peekCurrentUser } from "../../../lib/api";
import type { AdminAccessState, Notice } from "../admin-types";

type AdminRouter = {
  replace(path: string): void;
};

export function useAdminAccess(router: AdminRouter, onError: (notice: Notice) => void): AdminAccessState {
  const cachedUser = peekCurrentUser();
  const [accessState, setAccessState] = useState<AdminAccessState>(
    cachedUser?.role === "ADMIN" ? "granted" : "checking"
  );

  useEffect(() => {
    let active = true;

    if (cachedUser !== undefined) {
      if (!cachedUser) {
        router.replace("/login?next=%2Fadmin");
        return () => {
          active = false;
        };
      }
      if (cachedUser.role !== "ADMIN") {
        router.replace("/generate");
        return () => {
          active = false;
        };
      }
      setAccessState("granted");
    }

    getCurrentUser({ force: cachedUser === undefined })
      .then((currentUser) => {
        if (!active) {
          return;
        }
        if (!currentUser) {
          router.replace("/login?next=%2Fadmin");
          return;
        }
        if (currentUser.role !== "ADMIN") {
          router.replace("/generate");
          return;
        }
        setAccessState("granted");
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        onError({
          tone: "danger",
          text: error instanceof Error ? error.message : "管理员权限校验失败，请稍后重试。"
        });
      });

    return () => {
      active = false;
    };
  }, [cachedUser, onError, router]);

  return accessState;
}
