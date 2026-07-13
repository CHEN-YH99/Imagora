import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerImageRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    assertFeatureEnabled,
    descCreated,
    envelope,
    envNumber,
    extensionForMimeType,
    imageParamSchema,
    mustFindOwnImage,
    paginationSchema,
    requireAuth,
    resolveInlineDataUrl,
    storage,
    store,
    withFavorite
  } = context;

  app.get("/api/images", async (request) => {
    const { user, data } = await requireAuth(request);
    const query = paginationSchema.parse(request.query);
    const images = data.generatedImages
      .filter((image) => image.userId === user.id && !image.deletedAt && image.visibility !== "HIDDEN")
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
      return envelope(request, { imageId, deleted: true });
    });
  });
}
