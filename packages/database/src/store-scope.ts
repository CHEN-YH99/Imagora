import type { GenerationTask, StoreData } from "@imagora/shared";

/**
 * 定向写事务的加载范围。未声明的表在回调中不可访问（访问即抛错），
 * 防止业务逻辑把"没加载"误判成"不存在"；"append" 表只允许追加新记录。
 */
export interface StoreScope {
  creditAccounts?: { userIds: string[] };
  /** ids 与 clientRequestIds 取并集，userId 为附加条件；nextPending 取最早的一条 PENDING 任务。 */
  generationTasks?: { userId?: string; ids?: string[]; clientRequestIds?: string[] } | { nextPending: true };
  /** loadedTasks：已加载任务的全部 TASK 流水（扣费、退款），并允许追加。 */
  creditLedgerEntries?: "loadedTasks" | "append" | { userIds: string[] };
  referenceImages?: { ids?: string[]; loadedTasks?: boolean; content?: { userId: string; hash: string } };
  safetyRules?: "active";
  operationalIncidents?: { openTaskIds: string[] };
  safetyEvents?: "append";
  generatedImages?: "append";
}

type StoreKey = keyof StoreData;
type AnyRecord = Record<string, unknown>;

// 与 persistStoreDiff 共用的实体主键，JSON 合并与 Prisma upsert 判定一致。
export const storeEntityKeys: { [K in StoreKey]: (record: StoreData[K][number]) => string } = {
  users: (record) => record.id,
  sessions: (record) => record.token,
  passwordResetTokens: (record) => record.id,
  emailVerificationTokens: (record) => record.id,
  creditAccounts: (record) => record.userId,
  creditLedgerEntries: (record) => record.id,
  generationTasks: (record) => record.id,
  referenceImages: (record) => record.id,
  generatedImages: (record) => record.id,
  imageFavorites: (record) => `${record.userId}:${record.imageId}`,
  imageProjects: (record) => record.id,
  plans: (record) => record.id,
  orders: (record) => record.id,
  paymentEvents: (record) => record.id,
  safetyEvents: (record) => record.id,
  safetyRules: (record) => record.id,
  safetyAppeals: (record) => record.id,
  adminAuditLogs: (record) => record.id,
  operationalIncidents: (record) => record.id,
  alertNotifications: (record) => record.id
};

const storeKeys = new Set<string>(Object.keys(storeEntityKeys));

export function selectScopedGenerationTasks(tasks: GenerationTask[], scope: StoreScope): GenerationTask[] {
  const taskScope = scope.generationTasks;
  if (!taskScope) return [];
  if ("nextPending" in taskScope) {
    const next = tasks
      .filter((task) => task.status === "PENDING")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    return next ? [next] : [];
  }
  const ids = new Set(taskScope.ids ?? []);
  const clientRequestIds = new Set(taskScope.clientRequestIds ?? []);
  return tasks.filter(
    (task) =>
      (!taskScope.userId || task.userId === taskScope.userId) &&
      (ids.has(task.id) || clientRequestIds.has(task.clientRequestId))
  );
}

export function scopedReferenceImageIds(scope: StoreScope, loadedTasks: GenerationTask[]): string[] {
  const imageScope = scope.referenceImages;
  if (!imageScope) return [];
  const ids = new Set(imageScope.ids ?? []);
  if (imageScope.loadedTasks) {
    for (const task of loadedTasks) if (task.referenceImageId) ids.add(task.referenceImageId);
  }
  return [...ids];
}

/** JSON 存储按与 Prisma 相同的语义在内存中投影；返回深拷贝，回调失败不污染全量数据。 */
export function projectStoreScope(data: StoreData, scope: StoreScope): StoreData {
  const generationTasks = selectScopedGenerationTasks(data.generationTasks, scope);
  const taskIds = new Set(generationTasks.map((task) => task.id));
  const userIds = new Set(scope.creditAccounts?.userIds ?? []);
  const referenceImageIds = new Set(scopedReferenceImageIds(scope, generationTasks));
  const openTaskIds = new Set(scope.operationalIncidents?.openTaskIds ?? []);
  const projected = emptyScopedData();
  projected.generationTasks = generationTasks;
  projected.creditAccounts = data.creditAccounts.filter((account) => userIds.has(account.userId));
  if (scope.creditLedgerEntries === "loadedTasks") {
    projected.creditLedgerEntries = data.creditLedgerEntries.filter(
      (entry) =>
        (entry.sourceType === "TASK" && taskIds.has(entry.sourceId)) ||
        generationTasks.some((task) => entry.idempotencyKey === `task-refund:${task.id}`)
    );
  } else if (typeof scope.creditLedgerEntries === "object") {
    const ledgerUserIds = new Set(scope.creditLedgerEntries.userIds);
    projected.creditLedgerEntries = data.creditLedgerEntries.filter((entry) => ledgerUserIds.has(entry.userId));
  }
  const referenceContent = scope.referenceImages?.content;
  projected.referenceImages = data.referenceImages.filter(
    (image) =>
      referenceImageIds.has(image.id) ||
      (referenceContent && image.userId === referenceContent.userId && image.contentHash === referenceContent.hash)
  );
  if (scope.safetyRules === "active") {
    projected.safetyRules = data.safetyRules.filter((rule) => rule.status === "ACTIVE");
  }
  projected.operationalIncidents = (data.operationalIncidents ?? []).filter(
    (incident) => incident.status === "OPEN" && incident.taskId !== null && openTaskIds.has(incident.taskId)
  );
  return structuredClone(projected);
}

/** 只放行 scope 中声明的表；顶层不可整体替换，"append" 表只允许 push。 */
export function guardStoreScope(data: StoreData, scope: StoreScope): StoreData {
  const views = new Map<string, unknown>();
  for (const key of storeKeys) {
    const mode = scope[key as keyof StoreScope];
    if (mode === "append") views.set(key, appendOnly(data[key as StoreKey] as unknown[], key));
    else if (mode !== undefined) views.set(key, data[key as StoreKey]);
  }
  const reject = (key: string | symbol): never => {
    throw new Error(`Scoped store update cannot replace "${String(key)}"`);
  };
  return new Proxy(data, {
    get(target, key, receiver) {
      if (typeof key === "string" && storeKeys.has(key)) {
        if (!views.has(key)) throw new Error(`Scoped store update did not load "${key}"`);
        return views.get(key);
      }
      return Reflect.get(target, key, receiver);
    },
    set: (_target, key) => reject(key),
    deleteProperty: (_target, key) => reject(key)
  });
}

function appendOnly<T>(records: T[], name: string): T[] {
  return new Proxy(records, {
    get(target, key, receiver) {
      if (key === "push" || key === "length") return Reflect.get(target, key, receiver);
      throw new Error(`Scoped store update can only append to "${name}"`);
    }
  });
}

/** 把定向回调的前后差异合并回全量数据：删除被移除的、覆盖或追加变更的，未加载记录保持原样。 */
export function applyStoreDiff(target: StoreData, before: StoreData, after: StoreData): void {
  for (const name of storeKeys) {
    const key = storeEntityKeys[name as StoreKey] as unknown as (record: AnyRecord) => string;
    const previous = before[name as StoreKey] as unknown as AnyRecord[];
    const next = after[name as StoreKey] as unknown as AnyRecord[];
    if (previous.length === 0 && next.length === 0) continue;
    const nextByKey = new Map(next.map((record) => [key(record), record]));
    const removed = new Set(previous.map(key).filter((id) => !nextByKey.has(id)));
    const current = (target[name as StoreKey] ?? []) as unknown as AnyRecord[];
    const merged = current
      .filter((record) => !removed.has(key(record)))
      .map((record) => nextByKey.get(key(record)) ?? record);
    const existing = new Set(merged.map(key));
    merged.push(...next.filter((record) => !existing.has(key(record))));
    (target as unknown as Record<string, AnyRecord[]>)[name] = merged;
  }
}

function emptyScopedData(): StoreData {
  return Object.fromEntries([...storeKeys].map((key) => [key, []])) as unknown as StoreData;
}
