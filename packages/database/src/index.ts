import type {
  GenerationTask as TaskRow,
  GeneratedImage as ImageRow,
  CreditLedgerEntry as LedgerRow,
  User as UserRow,
  Order as OrderRow,
  Plan as PlanRow,
  ImageProject as ImageProjectRow,
  UserCreditAccount as CreditAccountRow,
  ReferenceImage as ReferenceImageRow,
  SafetyRule as SafetyRuleRow,
  OperationalIncident as IncidentRow
} from "../generated/client/index.js";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "../generated/client/index.js";
import { generationMetadataFromTask } from "@imagora/shared";
import type {
  CreditLedgerEntry,
  GenerationMetadata,
  GenerationProgress,
  GenerationTask,
  Plan,
  SafetyAppeal,
  StoreData,
  User
} from "@imagora/shared";
import { createEmptyStoreData, persistStoreDiff } from "./prisma-store-persistence.js";
import {
  readPrismaGenerationCandidates,
  readPrismaCreditExpiryUsers,
  selectGenerationCandidates,
  selectCreditExpiryUsers,
  trimPrismaIncidents,
  type GenerationMaintenanceQuery,
  type CreditExpiryQuery
} from "./maintenance-queries.js";
export type { GenerationMaintenanceQuery, CreditExpiryQuery } from "./maintenance-queries.js";
export { createGenerationMaintenanceRunner } from "./maintenance-runtime.js";
import {
  applyStoreDiff,
  guardStoreScope,
  projectStoreScope,
  scopedReferenceImageIds,
  type StoreScope
} from "./store-scope.js";

export type { StoreScope } from "./store-scope.js";

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultPath = resolve(workspaceRoot, "data", "imagora-store.json");

export interface Store {
  initialize(): Promise<void>;
  read(): Promise<StoreData>;
  readSession(token: string): Promise<SessionIdentity | null>;
  readGenerationTasks(query: GenerationTasksQuery): Promise<GenerationTasksData>;
  readImages(query: ImagesQuery): Promise<ImagesData>;
  readUserRecords(query: UserRecordsQuery): Promise<UserRecordsData>;
  readImageProjects(userId: string): Promise<ImageProjectView[]>;
  readGenerationMaintenanceCandidates(
    query: GenerationMaintenanceQuery
  ): Promise<Array<{ id: string; userId: string }>>;
  readCreditExpiryUsers(query: CreditExpiryQuery): Promise<string[]>;
  trimOperationalIncidents(keep: number): Promise<number>;
  readPendingGenerationTasks(query: PendingGenerationTasksQuery): Promise<PendingGenerationTask[]>;
  readOrders(query: OrdersQuery): Promise<{ orders: StoreData["orders"]; plans: Plan[] }>;
  readActivePlans(): Promise<Plan[]>;
  closeExpiredUserOrders(userId: string, cutoff: string, now: string): Promise<number>;
  readGenerationStream(query: GenerationStreamQuery): Promise<GenerationStreamData>;
  updateGenerationProgress(write: GenerationProgressWrite): Promise<void>;
  write(data: StoreData): Promise<void>;
  update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T>;
  /** 只加载 scope 声明的记录并在同一写锁内提交差异；回调访问未声明的表会抛错。 */
  updateScoped<T>(scope: StoreScope, mutate: (data: StoreData) => T | Promise<T>): Promise<T>;
}

export type PendingGenerationTask = Pick<GenerationTask, "id" | "userId" | "createdAt">;

export interface PendingGenerationTasksQuery {
  /** 只返回排在该位置之后（createdAt、id 升序）的任务。 */
  after?: Pick<GenerationTask, "createdAt" | "id">;
  limit: number;
}

export interface GenerationStreamQuery {
  taskIds: string[];
  sessionTokens: string[];
  knownTaskVersions?: Record<string, string>;
}

export interface SessionIdentity {
  user: User;
  expiresAt: string;
}

export interface GenerationTasksQuery {
  userId: string;
  taskId?: string;
  taskIds?: string[];
  status?: StoreData["generationTasks"][number]["status"];
  offset: number;
  limit: number;
  includeImages?: boolean;
}

export interface GenerationTasksData {
  generationTasks: StoreData["generationTasks"];
  generatedImages: StoreData["generatedImages"];
  creditLedgerEntries: CreditLedgerEntry[];
  total: number;
}

export interface OrdersQuery {
  userId: string;
  orderId?: string;
  limit?: number;
}

export interface UserRecordsQuery {
  userId: string;
  creditAccount?: boolean;
  ledgerLimit?: number;
  safetyEventLimit?: number;
  sessions?: boolean;
}

export type UserRecordsData = Pick<StoreData, "creditAccounts" | "creditLedgerEntries" | "safetyEvents" | "sessions">;

export interface ImagesQuery {
  userId: string;
  imageId?: string;
  projectId?: string;
  favorite?: boolean;
  offset: number;
  limit: number;
}

export type ImagesData = Pick<
  StoreData,
  "generatedImages" | "generationTasks" | "creditLedgerEntries" | "imageFavorites" | "imageProjects"
> & { total: number };

export type ImageProjectView = StoreData["imageProjects"][number] & {
  imageCount: number;
  coverThumbnailUrl: string | null;
};

export interface GenerationStreamData {
  sessions: Array<{ token: string; userId: string; expiresAt: string; userStatus: User["status"] }>;
  generationTasks: StoreData["generationTasks"];
  generatedImages: StoreData["generatedImages"];
  creditLedgerEntries: StoreData["creditLedgerEntries"];
}

export interface GenerationProgressWrite {
  taskId: string;
  startedAt: string;
  progress: GenerationProgress;
}

export function createStore(): Store {
  if (process.env.DATA_STORE !== "prisma") {
    return new JsonStore();
  }

  const prismaStore = new PrismaStore();
  if (!allowPrismaDevelopmentFallback()) {
    return prismaStore;
  }

  return new DevelopmentFallbackStore(prismaStore, new JsonStore());
}

const JSON_STORE_FILE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const JSON_STORE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;
const JSON_STORE_TEMP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const JSON_STORE_TEMP_CLEANUP_BATCH_SIZE = 32;

export class JsonStore implements Store {
  readonly filePath: string;
  private updateChain: Promise<void> = Promise.resolve();
  private streamCache?: { version: string; data: StoreData };
  private snapshotRead?: { version: string; promise: Promise<StoreData> };
  private nextTemporaryCleanupAt = 0;

  constructor(filePath = resolveStorePath(process.env.IMAGORA_STORE_PATH)) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  async read(): Promise<StoreData> {
    return structuredClone(await this.readSnapshot());
  }

  async readSession(token: string): Promise<SessionIdentity | null> {
    const data = await this.readSnapshot();
    const session = data.sessions.find((item) => item.token === token && Date.parse(item.expiresAt) > Date.now());
    const user = session && data.users.find((item) => item.id === session.userId);
    return user && session ? structuredClone({ user, expiresAt: session.expiresAt }) : null;
  }

  async readGenerationTasks(query: GenerationTasksQuery): Promise<GenerationTasksData> {
    const data = await this.readSnapshot();
    const matching = data.generationTasks
      .filter(
        (task) =>
          task.userId === query.userId &&
          (!query.taskId || task.id === query.taskId) &&
          (!query.taskIds || query.taskIds.includes(task.id)) &&
          (!query.status || task.status === query.status)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const generationTasks = matching.slice(query.offset, query.offset + query.limit);
    const ids = new Set(generationTasks.map((task) => task.id));
    return structuredClone({
      generationTasks,
      generatedImages: query.includeImages
        ? data.generatedImages.filter(
            (image) => ids.has(image.taskId) && image.userId === query.userId && !image.deletedAt
          )
        : [],
      creditLedgerEntries: data.creditLedgerEntries.filter(
        (entry) =>
          entry.userId === query.userId &&
          entry.sourceType === "TASK" &&
          entry.type === "REFUND" &&
          ids.has(entry.sourceId)
      ),
      total: matching.length
    });
  }

  async readGenerationMaintenanceCandidates(query: GenerationMaintenanceQuery) {
    return selectGenerationCandidates(await this.readSnapshot(), query);
  }

  async readCreditExpiryUsers(query: CreditExpiryQuery): Promise<string[]> {
    return selectCreditExpiryUsers(await this.readSnapshot(), query);
  }

  async trimOperationalIncidents(keep: number): Promise<number> {
    if (!Number.isSafeInteger(keep) || keep < 0) throw new RangeError("Invalid incident retention limit");
    return this.update((data) => {
      const incidents = data.operationalIncidents ?? [];
      const removed = Math.max(0, incidents.length - keep);
      if (removed)
        data.operationalIncidents = incidents
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .slice(0, keep);
      return removed;
    });
  }

  async readUserRecords(query: UserRecordsQuery): Promise<UserRecordsData> {
    const data = await this.readSnapshot();
    const byCreated = <T extends { createdAt: string; id: string }>(items: T[]) =>
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return structuredClone({
      creditAccounts: query.creditAccount ? data.creditAccounts.filter((row) => row.userId === query.userId) : [],
      creditLedgerEntries:
        query.ledgerLimit === undefined
          ? []
          : byCreated(data.creditLedgerEntries.filter((row) => row.userId === query.userId)).slice(
              0,
              query.ledgerLimit
            ),
      safetyEvents:
        query.safetyEventLimit === undefined
          ? []
          : byCreated(data.safetyEvents.filter((row) => row.userId === query.userId)).slice(0, query.safetyEventLimit),
      sessions: query.sessions
        ? data.sessions
            .filter((row) => row.userId === query.userId && Date.parse(row.expiresAt) > Date.now())
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.token.localeCompare(a.token))
        : []
    });
  }

  async readImages(query: ImagesQuery): Promise<ImagesData> {
    const data = await this.readSnapshot();
    const imageProjects = query.projectId
      ? data.imageProjects.filter(
          (project) => project.id === query.projectId && project.userId === query.userId && !project.archivedAt
        )
      : [];
    const favoriteIds = new Set(
      data.imageFavorites.filter((item) => item.userId === query.userId).map((item) => item.imageId)
    );
    const matching =
      query.projectId && !imageProjects.length
        ? []
        : data.generatedImages
            .filter(
              (image) =>
                image.userId === query.userId &&
                !image.deletedAt &&
                (query.imageId ? image.id === query.imageId : image.visibility !== "HIDDEN") &&
                (!query.projectId || image.projectId === query.projectId) &&
                (query.favorite === undefined || favoriteIds.has(image.id) === query.favorite)
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const generatedImages = matching.slice(query.offset, query.offset + query.limit);
    const imageIds = new Set(generatedImages.map((image) => image.id));
    const taskIds = new Set(query.imageId ? generatedImages.map((image) => image.taskId) : []);
    return structuredClone({
      generatedImages,
      imageProjects,
      imageFavorites: data.imageFavorites.filter((item) => item.userId === query.userId && imageIds.has(item.imageId)),
      generationTasks: data.generationTasks.filter((task) => task.userId === query.userId && taskIds.has(task.id)),
      creditLedgerEntries: data.creditLedgerEntries.filter(
        (entry) =>
          entry.userId === query.userId &&
          entry.sourceType === "TASK" &&
          entry.type === "REFUND" &&
          taskIds.has(entry.sourceId)
      ),
      total: matching.length
    });
  }

  async readImageProjects(userId: string): Promise<ImageProjectView[]> {
    const data = await this.readSnapshot();
    return structuredClone(
      data.imageProjects
        .filter((project) => project.userId === userId && !project.archivedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
        .map((project) => {
          const images = data.generatedImages
            .filter(
              (image) =>
                image.userId === userId &&
                image.projectId === project.id &&
                !image.deletedAt &&
                image.visibility !== "HIDDEN"
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
          const cover = images.find((image) => image.id === project.coverImageId) ?? images[0];
          return { ...project, imageCount: images.length, coverThumbnailUrl: cover?.thumbnailUrl ?? null };
        })
    );
  }

  async readPendingGenerationTasks(query: PendingGenerationTasksQuery): Promise<PendingGenerationTask[]> {
    const { after } = query;
    return (await this.readSnapshot()).generationTasks
      .filter((task) => task.status === "PENDING" && (!after || comparePendingPosition(task, after) > 0))
      .sort(comparePendingPosition)
      .slice(0, query.limit)
      .map(({ id, userId, createdAt }) => ({ id, userId, createdAt }));
  }

  async readOrders(query: OrdersQuery): Promise<{ orders: StoreData["orders"]; plans: Plan[] }> {
    const data = await this.readSnapshot();
    const orders = data.orders
      .filter((order) => order.userId === query.userId && (!query.orderId || order.id === query.orderId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, query.limit ?? Number.POSITIVE_INFINITY);
    const planIds = new Set(query.orderId ? orders.map((order) => order.planId) : []);
    return structuredClone({ orders, plans: data.plans.filter((plan) => planIds.has(plan.id)) });
  }

  async readActivePlans(): Promise<Plan[]> {
    return structuredClone(
      (await this.readSnapshot()).plans
        .filter((plan) => plan.status === "ACTIVE")
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    );
  }

  async closeExpiredUserOrders(userId: string, cutoff: string, now: string): Promise<number> {
    const matches = (order: StoreData["orders"][number]) =>
      order.userId === userId && order.status === "PENDING" && order.createdAt <= cutoff;
    if (!(await this.readSnapshot()).orders.some(matches)) return 0;
    return this.update((data) => {
      const expired = data.orders.filter(matches);
      for (const order of expired) {
        order.status = "CLOSED";
        order.updatedAt = now;
      }
      return expired.length;
    });
  }

  async readGenerationStream(query: GenerationStreamQuery): Promise<GenerationStreamData> {
    return projectGenerationStream(await this.readSnapshot(), query);
  }

  private async readSnapshot(): Promise<StoreData> {
    // 原子替换的文件句柄对应同一份快照；仅在其他进程写入后重新解析。
    const file = await open(this.filePath, "r").catch(async (error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
      await this.ensureInitialized();
      return open(this.filePath, "r");
    });
    try {
      const stat = await file.stat({ bigint: true });
      const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      if (this.streamCache?.version === version) return this.streamCache.data;
      if (this.snapshotRead?.version === version) return await this.snapshotRead.promise;
      const promise = file
        .readFile("utf8")
        .then((content) => normalizeStoreData(JSON.parse(content) as Partial<StoreData>));
      this.snapshotRead = { version, promise };
      try {
        const data = await promise;
        if (this.snapshotRead?.promise === promise) this.streamCache = { version, data };
        return data;
      } finally {
        if (this.snapshotRead?.promise === promise) this.snapshotRead = undefined;
      }
    } finally {
      await file.close();
    }
  }

  async updateGenerationProgress(write: GenerationProgressWrite): Promise<void> {
    await this.update((data) => {
      const task = data.generationTasks.find((item) => item.id === write.taskId);
      if (!task || task.status !== "RUNNING" || task.startedAt !== write.startedAt) return;
      if ((task.progress?.sequence ?? 0) >= (write.progress.sequence ?? 0)) return;
      task.progress = structuredClone(write.progress);
      task.updatedAt = write.progress.updatedAt;
    });
  }

  async write(data: StoreData): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await this.writeUnlocked(data);
    });
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.serialized(async (data) => mutate(data));
  }

  async updateScoped<T>(scope: StoreScope, mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    // 与 Prisma 相同的投影与防漏读保护，JSON 下的接口测试即可覆盖 scope 声明是否完整。
    return this.serialized(async (data) => {
      const scoped = projectStoreScope(data, scope);
      const before = structuredClone(scoped);
      const result = await mutate(guardStoreScope(scoped, scope));
      applyStoreDiff(data, before, scoped);
      return result;
    });
  }

  private async serialized<T>(operation: (data: StoreData) => Promise<T>): Promise<T> {
    let result: T | undefined;
    const run = this.updateChain.then(async () => {
      await withFileLock(this.filePath, async () => {
        await this.ensureInitializedUnlocked();
        const data = await this.readUnlocked();
        result = await operation(data);
        await this.writeUnlocked(data);
      });
    });
    this.updateChain = run.then(
      () => undefined,
      () => undefined
    );
    await run;
    return result as T;
  }

  private async readUnlocked(): Promise<StoreData> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const content = await readFile(this.filePath, "utf8");
        return normalizeStoreData(JSON.parse(content) as Partial<StoreData>);
      } catch (error) {
        if (attempt === 2 || !(error instanceof SyntaxError)) {
          throw error;
        }
        await sleep(20);
      }
    }
    throw new Error("JSON store read failed");
  }

  private async writeUnlocked(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const content = JSON.stringify(data, null, 2) + "\n";
    const temporaryPath = this.filePath + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp";
    // 独占创建成功后才拥有此临时文件，不能删除碰巧已存在的文件。
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.close();
      // 每次只重试替换同一份快照，不重跑业务变更，也不删除正式数据库。
      await retryTransientFileOperation(() => rename(temporaryPath, this.filePath));
    } catch (error) {
      await handle.close().catch(() => undefined);
      try {
        await retryTransientFileOperation(async () => {
          try {
            await unlink(temporaryPath);
          } catch (cleanupError) {
            if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
          }
        });
      } catch (cleanupError) {
        warnTemporaryCleanupFailure(temporaryPath, cleanupError);
      }
      throw error;
    }
    // 回收失败不能把已经提交成功的业务写入误报为失败。
    await this.cleanupStaleTemporaryFiles();
  }

  private async cleanupStaleTemporaryFiles(): Promise<void> {
    const now = Date.now();
    if (now < this.nextTemporaryCleanupAt) return;
    this.nextTemporaryCleanupAt = now + JSON_STORE_TEMP_CLEANUP_INTERVAL_MS;
    try {
      // 正式数据库不可读时保留崩溃快照，供恢复使用；调用者始终持有该库的写锁。
      await this.readUnlocked();
      const directory = dirname(this.filePath);
      const prefix = basename(this.filePath) + ".";
      const cutoff = now - JSON_STORE_TEMP_MIN_AGE_MS;
      let attempted = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const match = /^([1-9]\d*)\.(\d+)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/i.exec(
          entry.name.slice(prefix.length)
        );
        if (!match) continue;
        const ownerPid = Number(match[1]);
        const createdAt = Number(match[2]);
        if (
          !Number.isSafeInteger(ownerPid) ||
          ownerPid > 0x7fffffff ||
          !Number.isSafeInteger(createdAt) ||
          createdAt <= 0 ||
          createdAt > cutoff ||
          !isProcessDefinitelyExited(ownerPid)
        )
          continue;
        const temporaryPath = join(directory, entry.name);
        try {
          const metadata = await lstat(temporaryPath);
          if (!metadata.isFile() || metadata.mtimeMs > cutoff) continue;
          attempted += 1;
          // 每个旧文件只尝试一次，避免占用写锁等待整批重试。
          await unlink(temporaryPath);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) warnTemporaryCleanupFailure(temporaryPath, error);
        }
        if (attempted >= JSON_STORE_TEMP_CLEANUP_BATCH_SIZE) break;
      }
    } catch (error) {
      warnTemporaryCleanupFailure(this.filePath, error);
    }
  }

  private async ensureInitialized(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await this.ensureInitializedUnlocked();
      await this.cleanupStaleTemporaryFiles();
    });
  }

  private async ensureInitializedUnlocked(): Promise<void> {
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      await this.writeUnlocked(createInitialData());
    }
  }
}

class DevelopmentFallbackStore implements Store {
  private activeFallback: Store | null = null;

  constructor(
    private readonly primary: Store,
    private readonly fallback: Store
  ) {}

  async initialize(): Promise<void> {
    return this.run((store) => store.initialize());
  }

  async readSession(token: string): Promise<SessionIdentity | null> {
    return this.run((store) => store.readSession(token));
  }

  async readGenerationTasks(query: GenerationTasksQuery): Promise<GenerationTasksData> {
    return this.run((store) => store.readGenerationTasks(query));
  }

  async readGenerationMaintenanceCandidates(query: GenerationMaintenanceQuery) {
    return this.run((store) => store.readGenerationMaintenanceCandidates(query));
  }

  async readCreditExpiryUsers(query: CreditExpiryQuery): Promise<string[]> {
    return this.run((store) => store.readCreditExpiryUsers(query));
  }

  async trimOperationalIncidents(keep: number): Promise<number> {
    return this.run((store) => store.trimOperationalIncidents(keep));
  }

  async readUserRecords(query: UserRecordsQuery): Promise<UserRecordsData> {
    return this.run((store) => store.readUserRecords(query));
  }

  async readImages(query: ImagesQuery): Promise<ImagesData> {
    return this.run((store) => store.readImages(query));
  }

  async readImageProjects(userId: string): Promise<ImageProjectView[]> {
    return this.run((store) => store.readImageProjects(userId));
  }

  async readPendingGenerationTasks(query: PendingGenerationTasksQuery): Promise<PendingGenerationTask[]> {
    return this.run((store) => store.readPendingGenerationTasks(query));
  }

  async readOrders(query: OrdersQuery): Promise<{ orders: StoreData["orders"]; plans: Plan[] }> {
    return this.run((store) => store.readOrders(query));
  }

  async readActivePlans(): Promise<Plan[]> {
    return this.run((store) => store.readActivePlans());
  }

  async closeExpiredUserOrders(userId: string, cutoff: string, now: string): Promise<number> {
    return this.run((store) => store.closeExpiredUserOrders(userId, cutoff, now));
  }

  async read(): Promise<StoreData> {
    return this.run((store) => store.read());
  }

  async readGenerationStream(query: GenerationStreamQuery): Promise<GenerationStreamData> {
    return this.run((store) => store.readGenerationStream(query));
  }

  async updateGenerationProgress(write: GenerationProgressWrite): Promise<void> {
    return this.run((store) => store.updateGenerationProgress(write));
  }

  async write(data: StoreData): Promise<void> {
    return this.run((store) => store.write(data));
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.run((store) => store.update(mutate));
  }

  async updateScoped<T>(scope: StoreScope, mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.run((store) => store.updateScoped(scope, mutate));
  }

  private async run<T>(operation: (store: Store) => Promise<T>): Promise<T> {
    if (this.activeFallback) {
      return operation(this.activeFallback);
    }

    try {
      return await operation(this.primary);
    } catch (error) {
      if (!isPrismaUnavailableError(error)) {
        throw error;
      }
      this.activeFallback = this.fallback;
      return operation(this.activeFallback);
    }
  }
}

export class PrismaStore implements Store {
  private readonly prisma: PrismaClient;
  private updateChain: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;

  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    await this.ensureSeeded();
  }

  async readSession(token: string): Promise<SessionIdentity | null> {
    const session = await this.prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    return { user: userFromRow(session.user), expiresAt: session.expiresAt.toISOString() };
  }

  async readGenerationTasks(query: GenerationTasksQuery): Promise<GenerationTasksData> {
    return this.prisma.$transaction(
      async (tx) => {
        const where = {
          userId: query.userId,
          ...(query.taskId ? { id: query.taskId } : query.taskIds ? { id: { in: query.taskIds } } : {}),
          ...(query.status ? { status: query.status } : {})
        };
        const [rows, total] = await Promise.all([
          tx.generationTask.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: query.offset,
            take: query.limit
          }),
          tx.generationTask.count({ where })
        ]);
        const ids = rows.map((task) => task.id);
        const [images, entries] = ids.length
          ? await Promise.all([
              query.includeImages
                ? tx.generatedImage.findMany({ where: { userId: query.userId, taskId: { in: ids }, deletedAt: null } })
                : [],
              tx.creditLedgerEntry.findMany({
                where: { userId: query.userId, sourceType: "TASK", sourceId: { in: ids }, type: "REFUND" }
              })
            ])
          : [[], []];
        const generationTasks = rows.map(generationTaskFromRow);
        return {
          generationTasks,
          generatedImages: images.map((image) => generatedImageFromRow(image, generationTasks)),
          creditLedgerEntries: entries.map(creditLedgerEntryFromRow),
          total
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000 }
    );
  }

  async readGenerationMaintenanceCandidates(query: GenerationMaintenanceQuery) {
    return readPrismaGenerationCandidates(this.prisma, query);
  }

  async readCreditExpiryUsers(query: CreditExpiryQuery): Promise<string[]> {
    return readPrismaCreditExpiryUsers(this.prisma, query);
  }

  async trimOperationalIncidents(keep: number): Promise<number> {
    return this.serialized((tx) => trimPrismaIncidents(tx, keep));
  }

  async readUserRecords(query: UserRecordsQuery): Promise<UserRecordsData> {
    const [creditAccounts, entries, events, sessions] = await Promise.all([
      query.creditAccount ? this.prisma.userCreditAccount.findMany({ where: { userId: query.userId } }) : [],
      query.ledgerLimit === undefined
        ? []
        : this.prisma.creditLedgerEntry.findMany({
            where: { userId: query.userId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: query.ledgerLimit
          }),
      query.safetyEventLimit === undefined
        ? []
        : this.prisma.safetyEvent.findMany({
            where: { userId: query.userId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: query.safetyEventLimit
          }),
      query.sessions
        ? this.prisma.session.findMany({
            where: { userId: query.userId, expiresAt: { gt: new Date() } },
            orderBy: [{ createdAt: "desc" }, { token: "desc" }]
          })
        : []
    ]);
    return {
      creditAccounts: creditAccounts.map(creditAccountFromRow),
      creditLedgerEntries: entries.map(creditLedgerEntryFromRow),
      safetyEvents: events.map((event) => ({
        id: event.id,
        userId: event.userId,
        targetType: event.targetType as StoreData["safetyEvents"][number]["targetType"],
        targetId: event.targetId,
        status: event.status,
        reasonCode: event.reasonCode,
        reasonMessage: event.reasonMessage,
        provider: event.provider,
        createdAt: event.createdAt.toISOString()
      })),
      sessions: sessions.map((session) => ({
        token: session.token,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString()
      }))
    };
  }

  async readImages(query: ImagesQuery): Promise<ImagesData> {
    return this.prisma.$transaction(
      async (tx) => {
        const projects = query.projectId
          ? await tx.imageProject.findMany({ where: { id: query.projectId, userId: query.userId, archivedAt: null } })
          : [];
        const imageProjects = projects.map(imageProjectFromRow);
        if (query.projectId && !projects.length) {
          return {
            generatedImages: [],
            generationTasks: [],
            creditLedgerEntries: [],
            imageFavorites: [],
            imageProjects,
            total: 0
          };
        }
        const where: Prisma.GeneratedImageWhereInput = {
          userId: query.userId,
          deletedAt: null,
          ...(query.imageId ? { id: query.imageId } : { visibility: { not: "HIDDEN" } }),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.favorite === undefined
            ? {}
            : {
                favorites: query.favorite ? { some: { userId: query.userId } } : { none: { userId: query.userId } }
              })
        };
        const [rows, total] = await Promise.all([
          tx.generatedImage.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: query.offset,
            take: query.limit,
            include: { favorites: { where: { userId: query.userId } }, task: true }
          }),
          tx.generatedImage.count({ where })
        ]);
        // 旧图片可能缺少元数据；仅关联当前页任务恢复兼容字段，绝不读取全部任务。
        const generationTasks = rows
          .map((image) => generationTaskFromRow(image.task))
          .filter((task) => task.userId === query.userId);
        const taskIds = [...new Set(generationTasks.map((task) => task.id))];
        const entries =
          query.imageId && taskIds.length
            ? await tx.creditLedgerEntry.findMany({
                where: { userId: query.userId, sourceType: "TASK", type: "REFUND", sourceId: { in: taskIds } }
              })
            : [];
        return {
          generatedImages: rows.map((image) => generatedImageFromRow(image, generationTasks)),
          generationTasks: query.imageId ? generationTasks : [],
          creditLedgerEntries: entries.map(creditLedgerEntryFromRow),
          imageFavorites: rows.flatMap((image) =>
            image.favorites.map((favorite) => ({
              userId: favorite.userId,
              imageId: favorite.imageId,
              createdAt: favorite.createdAt.toISOString()
            }))
          ),
          imageProjects,
          total
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000 }
    );
  }

  async readImageProjects(userId: string): Promise<ImageProjectView[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const visible = { userId, deletedAt: null, visibility: { not: "HIDDEN" as const } };
        const projects = await tx.imageProject.findMany({
          where: { userId, archivedAt: null },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          include: {
            _count: { select: { images: { where: visible } } },
            images: {
              where: visible,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { id: true, projectId: true, thumbnailUrl: true, publicUrl: true }
            }
          }
        });
        const coverIds = projects.flatMap((project) => (project.coverImageId ? [project.coverImageId] : []));
        const covers = coverIds.length
          ? await tx.generatedImage.findMany({
              where: { ...visible, id: { in: coverIds } },
              select: { id: true, projectId: true, thumbnailUrl: true, publicUrl: true }
            })
          : [];
        return projects.map((project) => {
          const cover =
            covers.find((image) => image.id === project.coverImageId && image.projectId === project.id) ??
            project.images[0];
          return {
            ...imageProjectFromRow(project),
            imageCount: project._count.images,
            coverThumbnailUrl: cover ? (cover.thumbnailUrl ?? cover.publicUrl ?? "") : null
          };
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000 }
    );
  }

  async readPendingGenerationTasks(query: PendingGenerationTasksQuery): Promise<PendingGenerationTask[]> {
    const { after } = query;
    const rows = await this.prisma.generationTask.findMany({
      where: {
        status: "PENDING",
        ...(after
          ? {
              OR: [
                { createdAt: { gt: new Date(after.createdAt) } },
                { createdAt: new Date(after.createdAt), id: { gt: after.id } }
              ]
            }
          : {})
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: query.limit,
      select: { id: true, userId: true, createdAt: true }
    });
    return rows.map((task) => ({ id: task.id, userId: task.userId, createdAt: task.createdAt.toISOString() }));
  }

  async readOrders(query: OrdersQuery): Promise<{ orders: StoreData["orders"]; plans: Plan[] }> {
    const rows = await this.prisma.order.findMany({
      where: { userId: query.userId, ...(query.orderId ? { id: query.orderId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(query.limit === undefined ? {} : { take: query.limit }),
      include: { plan: !!query.orderId }
    });
    return { orders: rows.map(orderFromRow), plans: query.orderId ? rows.map((order) => planFromRow(order.plan)) : [] };
  }

  async readActivePlans(): Promise<Plan[]> {
    return (
      await this.prisma.plan.findMany({ where: { status: "ACTIVE" }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] })
    ).map(planFromRow);
  }

  async closeExpiredUserOrders(userId: string, cutoff: string, now: string): Promise<number> {
    const where = { userId, status: "PENDING" as const, createdAt: { lte: new Date(cutoff) } };
    if (!(await this.prisma.order.findFirst({ where, select: { id: true } }))) return 0;
    // 仅实际过期关闭需要与旧 Store 写事务协调；普通订单读取不占用全局写锁。
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
        return (await tx.order.updateMany({ where, data: { status: "CLOSED", updatedAt: new Date(now) } })).count;
      },
      { timeout: 5_000 }
    );
  }

  async read(): Promise<StoreData> {
    await this.ensureSeeded();
    return this.readFromClient(this.prisma);
  }

  async readGenerationStream(query: GenerationStreamQuery): Promise<GenerationStreamData> {
    // 只读一致性快照，不执行种子检查，也不争用 Store 写事务的 advisory lock。
    return this.prisma.$transaction(
      async (tx) => {
        const sessions = await tx.session.findMany({
          where: { token: { in: query.sessionTokens }, expiresAt: { gt: new Date() } },
          select: { token: true, userId: true, expiresAt: true, user: { select: { status: true } } }
        });
        const userIds = [
          ...new Set(sessions.filter((session) => session.user.status === "ACTIVE").map((session) => session.userId))
        ];
        const tasks = userIds.length
          ? await tx.generationTask.findMany({
              where: { id: { in: query.taskIds }, userId: { in: userIds } }
            })
          : [];
        const taskIds = tasks
          .filter((task) => query.knownTaskVersions?.[task.id] !== generationTaskVersion(generationTaskFromRow(task)))
          .map((task) => task.id);
        const [images, entries] = taskIds.length
          ? await Promise.all([
              tx.generatedImage.findMany({
                where: { taskId: { in: taskIds }, userId: { in: userIds }, deletedAt: null }
              }),
              tx.creditLedgerEntry.findMany({
                where: { userId: { in: userIds }, sourceType: "TASK", sourceId: { in: taskIds }, type: "REFUND" }
              })
            ])
          : [[], []];
        const generationTasks = tasks.map(generationTaskFromRow);
        return {
          sessions: sessions.map((session) => ({
            token: session.token,
            userId: session.userId,
            expiresAt: session.expiresAt.toISOString(),
            userStatus: session.user.status
          })),
          generationTasks,
          generatedImages: images.map((image) => generatedImageFromRow(image, generationTasks)),
          creditLedgerEntries: entries.map(creditLedgerEntryFromRow)
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000 }
    );
  }

  async updateGenerationProgress(write: GenerationProgressWrite): Promise<void> {
    // 与原有任务终态事务协调，但只更新一条任务，不读取、克隆或 diff 全库。
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
        await tx.generationTask.updateMany({
          where: {
            id: write.taskId,
            status: "RUNNING",
            startedAt: new Date(write.startedAt),
            OR: [
              { progress: { equals: Prisma.DbNull } },
              { progress: { path: ["sequence"], lt: write.progress.sequence ?? 0 } }
            ]
          },
          data: {
            progress: write.progress as unknown as Prisma.InputJsonObject,
            updatedAt: new Date(write.progress.updatedAt)
          }
        });
      },
      { timeout: 5_000 }
    );
  }

  private async readFromClient(client: PrismaClient | Prisma.TransactionClient): Promise<StoreData> {
    const [
      users,
      sessions,
      passwordResetTokens,
      emailVerificationTokens,
      creditAccounts,
      creditLedgerEntries,
      generationTasks,
      referenceImages,
      generatedImages,
      imageFavorites,
      imageProjects,
      plans,
      orders,
      paymentEvents,
      safetyEvents,
      safetyRules,
      safetyAppeals,
      adminAuditLogs,
      operationalIncidents,
      alertNotifications
    ] = await Promise.all([
      client.user.findMany(),
      client.session.findMany(),
      client.passwordResetToken.findMany(),
      client.emailVerificationToken.findMany(),
      client.userCreditAccount.findMany(),
      client.creditLedgerEntry.findMany(),
      client.generationTask.findMany(),
      client.referenceImage.findMany(),
      client.generatedImage.findMany(),
      client.imageFavorite.findMany(),
      client.imageProject.findMany(),
      client.plan.findMany(),
      client.order.findMany(),
      client.paymentEvent.findMany(),
      client.safetyEvent.findMany(),
      client.safetyRule.findMany(),
      client.safetyAppeal.findMany(),
      client.adminAuditLog.findMany(),
      client.operationalIncident.findMany(),
      client.alertNotification.findMany()
    ]);

    const generationTaskViews: StoreData["generationTasks"] = generationTasks.map(generationTaskFromRow);

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: user.role,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null
      })),
      sessions: sessions.map((session) => ({
        token: session.token,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString()
      })),
      passwordResetTokens: passwordResetTokens.map((token) => ({
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt.toISOString(),
        usedAt: token.usedAt?.toISOString() ?? null,
        createdAt: token.createdAt.toISOString()
      })),
      emailVerificationTokens: emailVerificationTokens.map((token) => ({
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt.toISOString(),
        usedAt: token.usedAt?.toISOString() ?? null,
        createdAt: token.createdAt.toISOString()
      })),
      creditAccounts: creditAccounts.map(creditAccountFromRow),
      creditLedgerEntries: creditLedgerEntries.map(creditLedgerEntryFromRow),
      generationTasks: generationTaskViews,
      referenceImages: referenceImages.map(referenceImageFromRow),
      generatedImages: generatedImages.map((image) => generatedImageFromRow(image, generationTaskViews)),
      imageFavorites: imageFavorites.map((favorite) => ({
        userId: favorite.userId,
        imageId: favorite.imageId,
        createdAt: favorite.createdAt.toISOString()
      })),
      imageProjects: imageProjects.map((project) => ({
        id: project.id,
        userId: project.userId,
        name: project.name,
        description: project.description,
        coverImageId: project.coverImageId,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        archivedAt: project.archivedAt?.toISOString() ?? null
      })),
      plans: plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: plan.currency,
        credits: plan.credits,
        validDays: plan.validDays,
        status: plan.status,
        sortOrder: plan.sortOrder,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString()
      })),
      orders: orders.map((order) => ({
        id: order.id,
        userId: order.userId,
        planId: order.planId,
        orderNo: order.orderNo,
        amountCents: order.amountCents,
        currency: order.currency,
        paymentProvider: order.paymentProvider,
        paymentIntentId: order.paymentIntentId,
        status: order.status,
        paidAt: order.paidAt?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString()
      })),
      paymentEvents: paymentEvents.map((event) => ({
        id: event.id,
        provider: event.provider,
        providerEventId: event.providerEventId,
        orderId: event.orderId,
        eventType: event.eventType,
        payload: event.payload as Record<string, unknown>,
        processedAt: event.processedAt.toISOString(),
        createdAt: event.createdAt.toISOString()
      })),
      safetyEvents: safetyEvents.map((event) => ({
        id: event.id,
        userId: event.userId,
        targetType: event.targetType as StoreData["safetyEvents"][number]["targetType"],
        targetId: event.targetId,
        status: event.status,
        reasonCode: event.reasonCode,
        reasonMessage: event.reasonMessage,
        provider: event.provider,
        createdAt: event.createdAt.toISOString()
      })),
      safetyRules: safetyRules.map(safetyRuleFromRow),
      safetyAppeals: safetyAppeals.map((appeal) => ({
        id: appeal.id,
        userId: appeal.userId,
        safetyEventId: appeal.safetyEventId,
        reason: appeal.reason,
        status: appeal.status as SafetyAppeal["status"],
        adminNote: appeal.adminNote ?? null,
        createdAt: appeal.createdAt.toISOString(),
        resolvedAt: appeal.resolvedAt?.toISOString() ?? null
      })),
      adminAuditLogs: adminAuditLogs.map((log) => ({
        id: log.id,
        adminUserId: log.adminUserId,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        reason: log.reason ?? null,
        before: log.before as Record<string, unknown> | null,
        after: log.after as Record<string, unknown> | null,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        createdAt: log.createdAt.toISOString()
      })),
      operationalIncidents: operationalIncidents.map(operationalIncidentFromRow),
      alertNotifications: alertNotifications.map((notification) => ({
        id: notification.id,
        alertId: notification.alertId,
        channel: notification.channel as StoreData["alertNotifications"][number]["channel"],
        status: notification.status as StoreData["alertNotifications"][number]["status"],
        severity: notification.severity as StoreData["alertNotifications"][number]["severity"],
        dedupeKey: notification.dedupeKey,
        message: notification.message,
        createdAt: notification.createdAt.toISOString(),
        sentAt: notification.sentAt.toISOString()
      }))
    };
  }

  async write(data: StoreData): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
        const before = await this.readFromClient(tx);
        await persistStoreDiff(tx, before, data);
      },
      { timeout: 30_000 }
    );
  }

  async update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.serialized(async (tx) => {
      await this.seedIfEmpty(tx);
      const data = await this.readFromClient(tx);
      const before = structuredClone(data);
      const result = await mutate(data);
      await persistStoreDiff(tx, before, data);
      return result;
    });
  }

  async updateScoped<T>(scope: StoreScope, mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    await this.ensureSeeded();
    // 仍持有全局写锁：旧 update 以整行绝对值写积分账户，不加锁会互相覆盖；收益来自不再读全库。
    return this.serialized(async (tx) => {
      const data = await this.loadScope(tx, scope);
      const before = structuredClone(data);
      const result = await mutate(guardStoreScope(data, scope));
      await persistStoreDiff(tx, before, data);
      return result;
    });
  }

  private async serialized<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    let result: T | undefined;
    const run = this.updateChain.then(async () => {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
          result = await operation(tx);
        },
        { timeout: 30_000 }
      );
    });
    this.updateChain = run.then(
      () => undefined,
      () => undefined
    );
    await run;
    return result as T;
  }

  private async loadScope(tx: Prisma.TransactionClient, scope: StoreScope): Promise<StoreData> {
    const data = createEmptyStoreData();
    const taskScope = scope.generationTasks;
    if (taskScope && "nextPending" in taskScope) {
      data.generationTasks = (
        await tx.generationTask.findMany({
          where: { status: "PENDING" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 1
        })
      ).map(generationTaskFromRow);
    } else if (taskScope && (taskScope.ids?.length || taskScope.clientRequestIds?.length)) {
      data.generationTasks = (
        await tx.generationTask.findMany({
          where: {
            ...(taskScope.userId ? { userId: taskScope.userId } : {}),
            OR: [
              ...(taskScope.ids?.length ? [{ id: { in: taskScope.ids } }] : []),
              ...(taskScope.clientRequestIds?.length ? [{ clientRequestId: { in: taskScope.clientRequestIds } }] : [])
            ]
          }
        })
      ).map(generationTaskFromRow);
    }
    const taskIds = data.generationTasks.map((task) => task.id);
    const referenceImageIds = scopedReferenceImageIds(scope, data.generationTasks);
    const referenceContent = scope.referenceImages?.content;
    const userIds = scope.creditAccounts?.userIds ?? [];
    const openTaskIds = scope.operationalIncidents?.openTaskIds ?? [];
    const [creditAccounts, creditLedgerEntries, referenceImages, safetyRules, operationalIncidents] = await Promise.all(
      [
        userIds.length ? tx.userCreditAccount.findMany({ where: { userId: { in: userIds } } }) : [],
        scope.creditLedgerEntries === "loadedTasks" && taskIds.length
          ? tx.creditLedgerEntry.findMany({
              where: {
                OR: [
                  { sourceType: "TASK", sourceId: { in: taskIds } },
                  { idempotencyKey: { in: taskIds.map((id) => `task-refund:${id}`) } }
                ]
              }
            })
          : typeof scope.creditLedgerEntries === "object" && scope.creditLedgerEntries.userIds.length
            ? tx.creditLedgerEntry.findMany({ where: { userId: { in: scope.creditLedgerEntries.userIds } } })
            : [],
        referenceImageIds.length || referenceContent
          ? tx.referenceImage.findMany({
              where: {
                OR: [
                  ...(referenceImageIds.length ? [{ id: { in: referenceImageIds } }] : []),
                  ...(referenceContent ? [{ userId: referenceContent.userId, contentHash: referenceContent.hash }] : [])
                ]
              }
            })
          : [],
        scope.safetyRules === "active" ? tx.safetyRule.findMany({ where: { status: "ACTIVE" } }) : [],
        openTaskIds.length
          ? tx.operationalIncident.findMany({ where: { status: "OPEN", taskId: { in: openTaskIds } } })
          : []
      ]
    );
    data.creditAccounts = creditAccounts.map(creditAccountFromRow);
    data.creditLedgerEntries = creditLedgerEntries.map(creditLedgerEntryFromRow);
    data.referenceImages = referenceImages.map(referenceImageFromRow);
    data.safetyRules = safetyRules.map(safetyRuleFromRow);
    data.operationalIncidents = operationalIncidents.map(operationalIncidentFromRow);
    return data;
  }

  private async ensureSeeded(): Promise<void> {
    // 每个 Store 实例只初始化一次；失败后允许重试，日常只读不再反复获取全局锁。
    this.initialization ??= this.prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(73341001)");
          await this.seedIfEmpty(tx);
        },
        { timeout: 30_000 }
      )
      .catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    await this.initialization;
  }

  private async seedIfEmpty(tx: Prisma.TransactionClient): Promise<void> {
    if ((await tx.user.count()) > 0) {
      return;
    }
    const before = await this.readFromClient(tx);
    await persistStoreDiff(tx, before, createInitialData());
  }
}

function userFromRow(user: UserRow): User {
  return {
    ...user,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null
  };
}

function orderFromRow(order: OrderRow): StoreData["orders"][number] {
  return {
    id: order.id,
    userId: order.userId,
    planId: order.planId,
    orderNo: order.orderNo,
    amountCents: order.amountCents,
    currency: order.currency,
    paymentProvider: order.paymentProvider,
    paymentIntentId: order.paymentIntentId,
    status: order.status,
    paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

function imageProjectFromRow(project: ImageProjectRow): StoreData["imageProjects"][number] {
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    description: project.description,
    coverImageId: project.coverImageId,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    archivedAt: project.archivedAt?.toISOString() ?? null
  };
}

function planFromRow(plan: PlanRow): Plan {
  return { ...plan, createdAt: plan.createdAt.toISOString(), updatedAt: plan.updatedAt.toISOString() };
}

export function generationTaskVersion(task: StoreData["generationTasks"][number]): string {
  return [task.updatedAt, task.progress?.sequence ?? 0, task.status].join(":");
}

function generationTaskFromRow(task: TaskRow): StoreData["generationTasks"][number] {
  return {
    id: task.id,
    userId: task.userId,
    clientRequestId: task.clientRequestId,
    referenceImageId: task.referenceImageId,
    prompt: task.prompt,
    negativePrompt: task.negativePrompt,
    style: task.style as StoreData["generationTasks"][number]["style"],
    aspectRatio: task.aspectRatio as StoreData["generationTasks"][number]["aspectRatio"],
    width: task.width,
    height: task.height,
    quantity: task.quantity,
    quality: task.quality as StoreData["generationTasks"][number]["quality"],
    modelProvider: task.modelProvider,
    modelName: task.modelName,
    modelSnapshot: task.modelSnapshot as unknown as StoreData["generationTasks"][number]["modelSnapshot"],
    progress: task.progress as unknown as StoreData["generationTasks"][number]["progress"],
    status: task.status,
    creditCost: task.creditCost,
    providerCostCents: task.providerCostCents,
    failureCode: task.failureCode,
    failureMessage: task.failureMessage,
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString()
  };
}

function creditAccountFromRow(account: CreditAccountRow): StoreData["creditAccounts"][number] {
  return {
    userId: account.userId,
    balance: account.balance,
    totalEarned: account.totalEarned,
    totalSpent: account.totalSpent,
    updatedAt: account.updatedAt.toISOString()
  };
}

function referenceImageFromRow(image: ReferenceImageRow): StoreData["referenceImages"][number] {
  return {
    id: image.id,
    userId: image.userId,
    storageKey: image.storageKey,
    publicUrl: image.publicUrl ?? "",
    originalFileName: image.originalFileName,
    mimeType: image.mimeType as StoreData["referenceImages"][number]["mimeType"],
    fileSize: image.fileSize,
    width: image.width,
    height: image.height,
    contentHash: image.contentHash,
    safetyStatus: image.safetyStatus,
    createdAt: image.createdAt.toISOString(),
    expiresAt: image.expiresAt.toISOString(),
    deletedAt: image.deletedAt?.toISOString() ?? null
  };
}

function safetyRuleFromRow(rule: SafetyRuleRow): StoreData["safetyRules"][number] {
  return {
    id: rule.id,
    term: rule.term,
    action: rule.action,
    status: rule.status,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString()
  };
}

function operationalIncidentFromRow(incident: IncidentRow): StoreData["operationalIncidents"][number] {
  return {
    id: incident.id,
    severity: incident.severity as StoreData["operationalIncidents"][number]["severity"],
    area: incident.area as StoreData["operationalIncidents"][number]["area"],
    status: incident.status as StoreData["operationalIncidents"][number]["status"],
    message: incident.message,
    errorCode: incident.errorCode,
    requestId: incident.requestId,
    userId: incident.userId,
    taskId: incident.taskId,
    orderId: incident.orderId,
    route: incident.route,
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null
  };
}

function comparePendingPosition(
  left: Pick<GenerationTask, "createdAt" | "id">,
  right: Pick<GenerationTask, "createdAt" | "id">
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function creditLedgerEntryFromRow(entry: LedgerRow): CreditLedgerEntry {
  return {
    id: entry.id,
    userId: entry.userId,
    type: entry.type,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    idempotencyKey: entry.idempotencyKey,
    remark: entry.remark,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString()
  };
}

function generatedImageFromRow(
  image: ImageRow,
  generationTaskViews: StoreData["generationTasks"]
): StoreData["generatedImages"][number] {
  const createdAt = image.createdAt.toISOString();
  return {
    id: image.id,
    taskId: image.taskId,
    userId: image.userId,
    projectId: image.projectId,
    storageKey: image.storageKey,
    thumbnailKey: image.thumbnailKey,
    thumbnailUrl: image.thumbnailUrl ?? image.publicUrl ?? "",
    publicUrl: image.publicUrl ?? "",
    width: image.width,
    height: image.height,
    fileSize: image.fileSize,
    mimeType: image.mimeType,
    safetyStatus: image.safetyStatus,
    visibility: image.visibility,
    generationMetadata: normalizeGenerationMetadata(
      image.generationMetadata,
      generationTaskViews.find((task) => task.id === image.taskId),
      { taskId: image.taskId, width: image.width, height: image.height, createdAt }
    ),
    deletedAt: image.deletedAt?.toISOString() ?? null,
    createdAt
  };
}

function projectGenerationStream(data: StoreData, query: GenerationStreamQuery): GenerationStreamData {
  const tokens = new Set(query.sessionTokens);
  const users = new Map(data.users.map((user) => [user.id, user]));
  const sessions = data.sessions
    .filter((session) => tokens.has(session.token) && Date.parse(session.expiresAt) > Date.now())
    .map((session) => ({
      token: session.token,
      userId: session.userId,
      expiresAt: session.expiresAt,
      userStatus: users.get(session.userId)?.status ?? ("DELETED" as const)
    }));
  const userIds = new Set(
    sessions.filter((session) => session.userStatus === "ACTIVE").map((session) => session.userId)
  );
  const requested = new Set(query.taskIds);
  const generationTasks = data.generationTasks.filter((task) => requested.has(task.id) && userIds.has(task.userId));
  const taskIds = new Set(
    generationTasks
      .filter((task) => query.knownTaskVersions?.[task.id] !== generationTaskVersion(task))
      .map((task) => task.id)
  );
  return structuredClone({
    sessions,
    generationTasks,
    generatedImages: data.generatedImages.filter(
      (image) => taskIds.has(image.taskId) && userIds.has(image.userId) && !image.deletedAt
    ),
    creditLedgerEntries: data.creditLedgerEntries.filter(
      (entry) =>
        entry.type === "REFUND" &&
        entry.sourceType === "TASK" &&
        taskIds.has(entry.sourceId) &&
        userIds.has(entry.userId)
    )
  });
}

export function createInitialData(): StoreData {
  if (shouldSeedDemoData()) {
    return createSeedData();
  }

  const email = process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Store is empty. Set IMAGORA_BOOTSTRAP_ADMIN_EMAIL and IMAGORA_BOOTSTRAP_ADMIN_PASSWORD, or set IMAGORA_SEED_DEMO_DATA=true for local demos."
    );
  }

  return createBootstrapAdminData(email, password);
}

export function createSeedData(): StoreData {
  const now = new Date().toISOString();
  const adminId = randomUUID();
  const demoId = randomUUID();
  return {
    users: [
      {
        id: adminId,
        email: "admin@imagora.local",
        passwordHash: hashPassword("Admin123!"),
        nickname: "Imagora Admin",
        avatarUrl: null,
        role: "ADMIN",
        status: "ACTIVE",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      },
      {
        id: demoId,
        email: "demo@imagora.local",
        passwordHash: hashPassword("Demo123!"),
        nickname: "创作用户",
        avatarUrl: null,
        role: "USER",
        status: "ACTIVE",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      }
    ],
    sessions: [],
    passwordResetTokens: [],
    emailVerificationTokens: [],
    creditAccounts: [
      { userId: adminId, balance: 9999, totalEarned: 9999, totalSpent: 0, updatedAt: now },
      { userId: demoId, balance: 1240, totalEarned: 1240, totalSpent: 0, updatedAt: now }
    ],
    creditLedgerEntries: [
      seedLedger(adminId, 9999, "Initial admin credits", now),
      seedLedger(demoId, 1240, "新用户欢迎积分", now)
    ],
    generationTasks: [],
    referenceImages: [],
    generatedImages: [],
    imageFavorites: [],
    imageProjects: [],
    plans: seedPlans(now),
    orders: [],
    paymentEvents: [],
    safetyEvents: [],
    safetyRules: seedSafetyRules(now),
    safetyAppeals: [],
    adminAuditLogs: [],
    operationalIncidents: [],
    alertNotifications: []
  };
}

function createBootstrapAdminData(email: string, password: string): StoreData {
  const now = new Date().toISOString();
  const adminId = randomUUID();
  return {
    users: [
      {
        id: adminId,
        email,
        passwordHash: hashPassword(password),
        nickname: "Imagora Admin",
        avatarUrl: null,
        role: "ADMIN",
        status: "ACTIVE",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      }
    ],
    sessions: [],
    passwordResetTokens: [],
    emailVerificationTokens: [],
    creditAccounts: [{ userId: adminId, balance: 9999, totalEarned: 9999, totalSpent: 0, updatedAt: now }],
    creditLedgerEntries: [seedLedger(adminId, 9999, "Initial admin credits", now)],
    generationTasks: [],
    referenceImages: [],
    generatedImages: [],
    imageFavorites: [],
    imageProjects: [],
    plans: seedPlans(now),
    orders: [],
    paymentEvents: [],
    safetyEvents: [],
    safetyRules: seedSafetyRules(now),
    safetyAppeals: [],
    adminAuditLogs: [],
    operationalIncidents: [],
    alertNotifications: []
  };
}

export function hashPassword(password: string): string {
  const salt = randomUUID().replace(/-/g, "");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHash] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHash) {
    return false;
  }
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function withoutPassword(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function seedLedger(userId: string, amount: number, remark: string, now: string): CreditLedgerEntry {
  return {
    id: randomUUID(),
    userId,
    type: "GRANT",
    amount,
    balanceAfter: amount,
    sourceType: "SYSTEM",
    sourceId: "seed",
    idempotencyKey: `seed:${userId}`,
    remark,
    expiresAt: null,
    createdAt: now
  };
}

function seedPlans(now: string): Plan[] {
  return [
    {
      id: "starter",
      name: "入门版",
      description: "适合验证提示词方向、探索风格和完成轻量创作。",
      priceCents: 900,
      currency: "CNY",
      credits: 220,
      validDays: 30,
      status: "ACTIVE",
      sortOrder: 10,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "creator",
      name: "创作者版",
      description: "适合个人创作者稳定生成素材，并支持高清下载。",
      priceCents: 1900,
      currency: "CNY",
      credits: 620,
      validDays: 60,
      status: "ACTIVE",
      sortOrder: 20,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "studio",
      name: "团队版",
      description: "面向小团队、电商运营和持续内容生产的高容量积分包。",
      priceCents: 4900,
      currency: "CNY",
      credits: 1850,
      validDays: 90,
      status: "ACTIVE",
      sortOrder: 30,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function seedSafetyRules(now: string) {
  return [
    {
      id: randomUUID(),
      term: "儿童安全风险内容",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "性暴力内容",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "恐怖主义内容",
      action: "BLOCK" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      term: "政治敏感词汇",
      action: "REVIEW" as const,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function normalizeStoreData(data: Partial<StoreData>): StoreData {
  const now = new Date().toISOString();
  const generationTasks = (data.generationTasks ?? []).map((task) => ({
    ...task,
    referenceImageId: task.referenceImageId ?? null,
    providerCostCents: task.providerCostCents ?? 0
  }));
  const generatedImages = (data.generatedImages ?? []).map((image) => {
    const task = generationTasks.find((item) => item.id === image.taskId);
    return {
      ...image,
      projectId: image.projectId ?? null,
      thumbnailUrl: image.thumbnailUrl ?? image.publicUrl ?? "",
      publicUrl: image.publicUrl ?? "",
      generationMetadata: normalizeGenerationMetadata(image.generationMetadata, task, image)
    };
  });
  return {
    users: data.users ?? [],
    sessions: data.sessions ?? [],
    passwordResetTokens: data.passwordResetTokens ?? [],
    emailVerificationTokens: data.emailVerificationTokens ?? [],
    creditAccounts: data.creditAccounts ?? [],
    creditLedgerEntries: (data.creditLedgerEntries ?? []).map((entry) => ({
      ...entry,
      expiresAt: entry.expiresAt ?? null
    })),
    generationTasks,
    referenceImages: data.referenceImages ?? [],
    generatedImages,
    imageFavorites: data.imageFavorites ?? [],
    imageProjects: (data.imageProjects ?? []).map((project) => ({
      ...project,
      description: project.description ?? "",
      coverImageId: project.coverImageId ?? null,
      archivedAt: project.archivedAt ?? null
    })),
    plans: data.plans ?? seedPlans(now),
    orders: data.orders ?? [],
    paymentEvents: data.paymentEvents ?? [],
    safetyEvents: data.safetyEvents ?? [],
    safetyRules: data.safetyRules ?? seedSafetyRules(now),
    safetyAppeals: data.safetyAppeals ?? [],
    adminAuditLogs: (data.adminAuditLogs ?? []).map((log) => ({
      ...log,
      reason: log.reason ?? null
    })),
    operationalIncidents: (data.operationalIncidents ?? []).map((incident) => ({
      ...incident,
      status: incident.status ?? "OPEN",
      errorCode: incident.errorCode ?? null,
      requestId: incident.requestId ?? null,
      userId: incident.userId ?? null,
      taskId: incident.taskId ?? null,
      orderId: incident.orderId ?? null,
      route: incident.route ?? null,
      resolvedAt: incident.resolvedAt ?? null
    })),
    alertNotifications: data.alertNotifications ?? []
  };
}

function normalizeGenerationMetadata(
  metadata: unknown,
  task: StoreData["generationTasks"][number] | undefined,
  image: Pick<StoreData["generatedImages"][number], "taskId" | "width" | "height" | "createdAt">
): GenerationMetadata {
  if (isGenerationMetadata(metadata)) {
    // 旧 PostgreSQL 序列化曾遗漏 channel；只补缺失线路，不覆盖图片已有的生成参数。
    if (!metadata.channel && task) {
      const channel = generationMetadataFromTask(task).channel;
      if (channel) return { ...metadata, channel };
    }
    return metadata;
  }
  if (task) {
    return generationMetadataFromTask(task);
  }
  return {
    taskId: image.taskId,
    prompt: "",
    negativePrompt: null,
    style: "realistic",
    aspectRatio: "1:1",
    quality: "standard",
    quantity: 1,
    modelProvider: "unknown",
    modelName: "unknown",
    width: image.width,
    height: image.height,
    creditCost: 0,
    createdAt: image.createdAt
  };
}

function isGenerationMetadata(value: unknown): value is GenerationMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const metadata = value as Partial<GenerationMetadata>;
  return (
    typeof metadata.taskId === "string" &&
    typeof metadata.prompt === "string" &&
    (typeof metadata.negativePrompt === "string" || metadata.negativePrompt === null) &&
    typeof metadata.style === "string" &&
    typeof metadata.aspectRatio === "string" &&
    typeof metadata.quality === "string" &&
    typeof metadata.quantity === "number" &&
    typeof metadata.modelProvider === "string" &&
    typeof metadata.modelName === "string" &&
    typeof metadata.width === "number" &&
    typeof metadata.height === "number" &&
    typeof metadata.creditCost === "number" &&
    typeof metadata.createdAt === "string"
  );
}

function shouldSeedDemoData(): boolean {
  const value = process.env.IMAGORA_SEED_DEMO_DATA;
  if (value !== undefined) {
    return envFlag(value);
  }
  return process.env.NODE_ENV !== "production";
}

function allowPrismaDevelopmentFallback(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return !envFlag(process.env.DISABLE_PRISMA_DEV_FALLBACK ?? "false");
}

function isPrismaUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return (
    name === "PrismaClientInitializationError" ||
    code === "P1001" ||
    /Can't reach database server|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(message)
  );
}

async function retryTransientFileOperation(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const delay = JSON_STORE_FILE_RETRY_DELAYS_MS[attempt];
      const transient = ["EPERM", "EBUSY", "EACCES"].some((code) => isNodeError(error, code));
      if (!transient || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

function isProcessDefinitelyExited(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // 权限不足不代表进程已退出，不能据此删除其文件。
    return isNodeError(error, "ESRCH");
  }
}

function warnTemporaryCleanupFailure(filePath: string, error: unknown): void {
  process.emitWarning("Could not clean JSON store temporary file: " + filePath, {
    code: "JSON_STORE_TEMP_CLEANUP_FAILED",
    detail: error instanceof Error ? error.message : String(error)
  });
}

async function withFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(`${filePath}.lock`);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      await handle.close();
      return async () => {
        await unlink(lockPath).catch((error) => {
          if (!isNodeError(error, "ENOENT")) {
            throw error;
          }
        });
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      await removeStaleLock(lockPath);
      await sleep(25);
    }
  }
  throw new Error(`Timed out waiting for store lock: ${lockPath}`);
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const content = await readFile(lockPath, "utf8");
    const timestamp = Number(content.split(":")[1]);
    if (Number.isFinite(timestamp) && Date.now() - timestamp > 30_000) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function envFlag(value: string): boolean {
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase());
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveStorePath(configuredPath?: string): string {
  if (!configuredPath) {
    return defaultPath;
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(workspaceRoot, configuredPath);
}
