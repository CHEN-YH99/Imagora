import type { ImageProject, StoreData } from "@imagora/shared";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

type ImageProjectView = ImageProject & {
  imageCount: number;
  coverThumbnailUrl: string | null;
};

export function registerImageProjectRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    AppError,
    descUpdated,
    envelope,
    imageProjectCreateSchema,
    imageProjectParamSchema,
    imageProjectPatchSchema,
    mustFindOwnImage,
    randomUUID,
    requireAuth,
    store
  } = context;

  app.get("/api/image-projects", async (request) => {
    const { user, data } = await requireAuth(request);
    const projects = data.imageProjects
      .filter((project) => project.userId === user.id && !project.archivedAt)
      .sort(descUpdated)
      .map((project) => withProjectStats(data, project));
    return envelope(request, { projects });
  });

  app.post("/api/image-projects", async (request, reply) => {
    const { user } = await requireAuth(request);
    const input = imageProjectCreateSchema.parse(request.body);
    const project = await store.update((data) => {
      const now = new Date().toISOString();
      const created: ImageProject = {
        id: randomUUID(),
        userId: user.id,
        name: input.name,
        description: input.description ?? "",
        coverImageId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      };
      data.imageProjects.push(created);
      return withProjectStats(data, created);
    });
    reply.status(201);
    return envelope(request, { project });
  });

  app.patch("/api/image-projects/:projectId", async (request) => {
    const { user } = await requireAuth(request);
    const { projectId } = imageProjectParamSchema.parse(request.params);
    const input = imageProjectPatchSchema.parse(request.body);
    const project = await store.update((data) => {
      const target = mustFindOwnProject(data, user.id, projectId, AppError);
      if (input.coverImageId) {
        const cover = mustFindOwnImage(data, user.id, input.coverImageId);
        if (cover.projectId !== target.id) {
          throw new AppError("VALIDATION_ERROR", "Project cover image must belong to the project", 400);
        }
      }
      if (input.name !== undefined) {
        target.name = input.name;
      }
      if (input.description !== undefined) {
        target.description = input.description;
      }
      if (input.coverImageId !== undefined) {
        target.coverImageId = input.coverImageId;
      }
      target.updatedAt = new Date().toISOString();
      return withProjectStats(data, target);
    });
    return envelope(request, { project });
  });

  app.delete("/api/image-projects/:projectId", async (request) => {
    const { user } = await requireAuth(request);
    const { projectId } = imageProjectParamSchema.parse(request.params);
    const result = await store.update((data) => {
      const target = mustFindOwnProject(data, user.id, projectId, AppError);
      const now = new Date().toISOString();
      target.archivedAt = now;
      target.updatedAt = now;
      target.coverImageId = null;
      for (const image of data.generatedImages) {
        if (image.userId === user.id && image.projectId === target.id) {
          image.projectId = null;
        }
      }
      return { projectId: target.id, archived: true };
    });
    return envelope(request, result);
  });
}

function mustFindOwnProject(
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

function withProjectStats(data: StoreData, project: ImageProject): ImageProjectView {
  const projectImages = data.generatedImages.filter(
    (image) => image.projectId === project.id && !image.deletedAt && image.visibility !== "HIDDEN"
  );
  const coverImage =
    (project.coverImageId ? projectImages.find((image) => image.id === project.coverImageId) : null) ??
    projectImages[0] ??
    null;
  return {
    ...project,
    coverThumbnailUrl: coverImage?.thumbnailUrl ?? null,
    imageCount: projectImages.length
  };
}
