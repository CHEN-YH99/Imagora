import type { ImageProject, StoreData } from "@imagora/shared";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerImageRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    assertFeatureEnabled,
    descCreated,
    envelope,
    envNumber,
    extensionForMimeType,
    imageProjectAssignmentSchema,
    imageQuerySchema,
    imageParamSchema,
    AppError,
    mustFindOwnImage,
    requireAuth,
    resolveInlineDataUrl,
    storage,
    store,
    withFavorite
  } = context;

  app.get("/api/images", async (request) => {
    const { user, data } = await requireAuth(request);
    const query = imageQuerySchema.parse(request.query);
    if (query.projectId) {
      mustFindOwnActiveProject(data, user.id, query.projectId, AppError);
    }
    const images = data.generatedImages
      .filter((image) => image.userId === user.id && !image.deletedAt && image.visibility !== "HIDDEN")
      .filter((image) => (query.projectId ? image.projectId === query.projectId : true))
      .sort(descCreated)
      .slice(0, query.limit)
      .map((image) => withFavorite(data, user.id, image));
    return envelope(request, { images });
  });

  app.get("/api/images/:imageId", async (request) => {
    const { user, data } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const image = mustFindOwnImage(data, user.id, imageId);
    const task = data.generationTasks.find((item) => item.id === image.taskId);
    return envelope(request, { image: withFavorite(data, user.id, image), task });
  });

  app.post("/api/images/:imageId/preview-url", async (request) => {
    const { user, data } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const image = mustFindOwnImage(data, user.id, imageId);
    const expiresInSeconds = Math.max(
      60,
      Math.min(envNumber("PREVIEW_URL_TTL_MINUTES", envNumber("DOWNLOAD_URL_TTL_MINUTES", 15)) * 60, 60 * 60 * 24 * 7)
    );
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    const inlineOriginalUrl = resolveInlineDataUrl(image.publicUrl);

    return envelope(request, {
      url: inlineOriginalUrl ?? (await storage.getSignedUrl(image.storageKey, expiresInSeconds)),
      expiresAt
    });
  });

  app.post("/api/images/:imageId/favorite", async (request) => {
    const { user } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    return store.update(async (data) => {
      mustFindOwnImage(data, user.id, imageId);
      if (!data.imageFavorites.some((favorite) => favorite.userId === user.id && favorite.imageId === imageId)) {
        data.imageFavorites.push({ userId: user.id, imageId, createdAt: new Date().toISOString() });
      }
      return envelope(request, { imageId, favorite: true });
    });
  });

  app.post("/api/images/:imageId/project", async (request) => {
    const { user } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const input = imageProjectAssignmentSchema.parse(request.body);
    const image = await store.update((data) => {
      const target = mustFindOwnImage(data, user.id, imageId);
      const previousProjectId = target.projectId;
      if (input.projectId) {
        const project = mustFindOwnActiveProject(data, user.id, input.projectId, AppError);
        target.projectId = project.id;
        project.coverImageId ??= target.id;
        project.updatedAt = new Date().toISOString();
      } else {
        target.projectId = null;
      }
      if (previousProjectId && previousProjectId !== target.projectId) {
        const previousProject = data.imageProjects.find((project) => project.id === previousProjectId);
        if (previousProject?.coverImageId === target.id) {
          previousProject.coverImageId =
            data.generatedImages.find(
              (candidate) =>
                candidate.userId === user.id &&
                candidate.projectId === previousProject.id &&
                candidate.id !== target.id &&
                !candidate.deletedAt
            )?.id ?? null;
          previousProject.updatedAt = new Date().toISOString();
        }
      }
      return withFavorite(data, user.id, target);
    });
    return envelope(request, { image });
  });

  app.delete("/api/images/:imageId/favorite", async (request) => {
    const { user } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    return store.update((data) => {
      mustFindOwnImage(data, user.id, imageId);
      data.imageFavorites = data.imageFavorites.filter(
        (favorite) => !(favorite.userId === user.id && favorite.imageId === imageId)
      );
      return envelope(request, { imageId, favorite: false });
    });
  });

  app.post("/api/images/:imageId/download-url", async (request) => {
    assertFeatureEnabled("downloads");
    const { user, data } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const image = mustFindOwnImage(data, user.id, imageId);
    const expiresInSeconds = Math.max(60, Math.min(envNumber("DOWNLOAD_URL_TTL_MINUTES", 15) * 60, 60 * 60 * 24 * 7));
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    return envelope(request, {
      url: await storage.getSignedUrl(image.storageKey, expiresInSeconds),
      fileName: `imagora-${image.id}.${extensionForMimeType(image.mimeType)}`,
      expiresAt
    });
  });

  app.delete("/api/images/:imageId", async (request) => {
    const { user, data } = await requireAuth(request);
    const { imageId } = imageParamSchema.parse(request.params);
    const image = mustFindOwnImage(data, user.id, imageId);
    await storage.deleteObject(image.storageKey);
    if (image.thumbnailKey && image.thumbnailKey !== image.storageKey) {
      await storage.deleteObject(image.thumbnailKey);
    }
    return store.update((data) => {
      const image = mustFindOwnImage(data, user.id, imageId);
      image.deletedAt = new Date().toISOString();
      for (const project of data.imageProjects) {
        if (project.userId === user.id && project.coverImageId === image.id) {
          project.coverImageId =
            data.generatedImages.find(
              (candidate) =>
                candidate.userId === user.id &&
                candidate.projectId === project.id &&
                candidate.id !== image.id &&
                !candidate.deletedAt
            )?.id ?? null;
          project.updatedAt = image.deletedAt;
        }
      }
      return envelope(request, { imageId, deleted: true });
    });
  });
}

function mustFindOwnActiveProject(
  data: StoreData,
  userId: string,
  projectId: string,
  AppError: ApiRouteContext["AppError"]
): ImageProject {
  const project = data.imageProjects.find(
    (item) => item.id === projectId && item.userId === userId && !item.archivedAt
  );
  if (!project) {
    throw new AppError("NOT_FOUND", "Image project was not found", 404);
  }
  return project;
}
