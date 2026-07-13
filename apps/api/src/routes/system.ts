import { FilesystemObjectStorage } from "@imagora/storage";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerSystemRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const {
    AppError,
    contentTypeForStorageKey,
    envelope,
    errorMessage,
    featureFlags,
    fileSignatureQuerySchema,
    readFile,
    storage
  } = context;

  app.get("/health", async () => ({
    status: "ok",
    service: "imagora-api",
    time: new Date().toISOString(),
    features: featureFlags()
  }));

  app.get("/api/features", async (request) => envelope(request, { features: featureFlags() }));

  // filesystem 存储模式下的文件回读：复刻 S3 signed URL 的私有 + 过期语义。
  // getSignedUrl 生成 /api/files/<key>?expiresAt=&signature=，这里校验 HMAC 与过期后回读磁盘文件。
  // 仅在 STORAGE_PROVIDER=filesystem 时挂载，其余模式该路由不存在（图片走 data: 内联或 S3 直链）。
  if (storage instanceof FilesystemObjectStorage) {
    const filesystemStorage = storage;
    app.get("/api/files/*", async (request, reply) => {
      const key = (request.params as Record<string, string>)["*"];
      const query = fileSignatureQuerySchema.parse(request.query);
      let filePath: string;
      try {
        filePath = filesystemStorage.verifyAndResolve(key, Number(query.expiresAt), query.signature);
      } catch (error) {
        throw new AppError("FORBIDDEN", errorMessage(error, "Signed URL is invalid"), 403);
      }
      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        throw new AppError("NOT_FOUND", "File was not found", 404);
      }
      reply.header("content-type", contentTypeForStorageKey(key));
      reply.header("cache-control", "private, max-age=300");
      return reply.send(body);
    });
  }
}
