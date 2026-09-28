import type { StoreData } from "@imagora/shared";
import { Prisma, type PrismaClient } from "../generated/client/index.js";

export interface GenerationMaintenanceQuery {
  pendingBefore?: string;
  runningBefore?: string;
  afterId?: string;
  limit: number;
}

export interface CreditExpiryQuery {
  now: string;
  afterUserId?: string;
  limit: number;
}

type GenerationCandidate = { id: string; userId: string };
type QueryClient = Pick<PrismaClient, "$queryRaw">;

/** 只筛选候选；调用方仍需在写锁内重读任务、账户和任务流水后执行维护。 */
export async function readPrismaGenerationCandidates(
  client: QueryClient,
  query: GenerationMaintenanceQuery
): Promise<GenerationCandidate[]> {
  const limit = batchLimit(query.limit);
  const pendingBefore = optionalDate(query.pendingBefore, "pendingBefore");
  const runningBefore = optionalDate(query.runningBefore, "runningBefore");
  const conditions = [
    ...(pendingBefore ? [Prisma.sql`(task.status = 'PENDING' AND task.created_at <= ${pendingBefore})`] : []),
    ...(runningBefore
      ? [Prisma.sql`(task.status = 'RUNNING' AND task.started_at IS NOT NULL AND task.started_at <= ${runningBefore})`]
      : []),
    Prisma.sql`(
      task.status IN ('FAILED', 'BLOCKED', 'CANCELED')
      AND task.credit_cost > 0
      AND NOT EXISTS (
        SELECT 1 FROM credit_ledger_entries refunded
        WHERE refunded.idempotency_key = 'task-refund:' || task.id
      )
      AND (
        SELECT COALESCE(SUM(CASE
          WHEN ledger.type = 'SPEND' THEN GREATEST(-ledger.amount::bigint, 0)
          WHEN ledger.type = 'REFUND' THEN -GREATEST(ledger.amount::bigint, 0)
          ELSE 0
        END), 0)
        FROM credit_ledger_entries ledger
        WHERE ledger.source_type = 'TASK' AND ledger.source_id = task.id
      ) > 0
    )`
  ];
  return client.$queryRaw<GenerationCandidate[]>(Prisma.sql`
    SELECT task.id, task.user_id AS "userId"
    FROM generation_tasks task
    WHERE (${Prisma.join(conditions, " OR ")})
      ${query.afterId === undefined ? Prisma.empty : Prisma.sql`AND task.id COLLATE "C" > ${query.afterId}`}
    ORDER BY task.id COLLATE "C" ASC
    LIMIT ${limit}
  `);
}

/** 用户去重和分页在数据库内完成；候选用户的全部流水必须随后在写锁内加载。 */
export async function readPrismaCreditExpiryUsers(client: QueryClient, query: CreditExpiryQuery): Promise<string[]> {
  const limit = batchLimit(query.limit);
  const now = requiredDate(query.now, "now");
  const rows = await client.$queryRaw<{ userId: string }[]>(Prisma.sql`
    SELECT DISTINCT grant_entry.user_id COLLATE "C" AS "userId"
    FROM credit_ledger_entries grant_entry
    WHERE grant_entry.type = 'GRANT' AND grant_entry.amount > 0
      AND grant_entry.expires_at IS NOT NULL AND grant_entry.expires_at <= ${now}
      AND NOT EXISTS (
        SELECT 1 FROM credit_ledger_entries expired
        WHERE expired.idempotency_key = 'credit-expire:' || grant_entry.id
      )
      ${query.afterUserId === undefined ? Prisma.empty : Prisma.sql`AND grant_entry.user_id COLLATE "C" > ${query.afterUserId}`}
    ORDER BY "userId" ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => row.userId);
}

/** 与 SQL 同语义的 JSON 候选选择，不修改原始数据，也不计算不完整流水的过期余额。 */
export function selectGenerationCandidates(data: StoreData, query: GenerationMaintenanceQuery): GenerationCandidate[] {
  const limit = batchLimit(query.limit);
  const pendingBefore = optionalDate(query.pendingBefore, "pendingBefore")?.getTime();
  const runningBefore = optionalDate(query.runningBefore, "runningBefore")?.getTime();
  const idempotencyKeys = new Set<string>();
  const unrefundedByTaskId = new Map<string, number>();
  for (const entry of data.creditLedgerEntries) {
    idempotencyKeys.add(entry.idempotencyKey);
    if (entry.sourceType !== "TASK") continue;
    const amount =
      entry.type === "SPEND" ? Math.max(-entry.amount, 0) : entry.type === "REFUND" ? -Math.max(entry.amount, 0) : 0;
    unrefundedByTaskId.set(entry.sourceId, (unrefundedByTaskId.get(entry.sourceId) ?? 0) + amount);
  }
  return data.generationTasks
    .filter((task) => {
      if (query.afterId !== undefined && compareIds(task.id, query.afterId) <= 0) return false;
      if (task.status === "PENDING" && atOrBefore(task.createdAt, pendingBefore)) return true;
      if (task.status === "RUNNING" && atOrBefore(task.startedAt, runningBefore)) return true;
      return (
        (task.status === "FAILED" || task.status === "BLOCKED" || task.status === "CANCELED") &&
        task.creditCost > 0 &&
        !idempotencyKeys.has(`task-refund:${task.id}`) &&
        (unrefundedByTaskId.get(task.id) ?? 0) > 0
      );
    })
    .sort((left, right) => compareIds(left.id, right.id))
    .slice(0, limit)
    .map(({ id, userId }) => ({ id, userId }));
}

export function selectCreditExpiryUsers(data: StoreData, query: CreditExpiryQuery): string[] {
  const limit = batchLimit(query.limit);
  const now = requiredDate(query.now, "now").getTime();
  const idempotencyKeys = new Set(data.creditLedgerEntries.map((entry) => entry.idempotencyKey));
  const users = new Set<string>();
  for (const entry of data.creditLedgerEntries) {
    if (
      entry.type === "GRANT" &&
      entry.amount > 0 &&
      atOrBefore(entry.expiresAt, now) &&
      !idempotencyKeys.has(`credit-expire:${entry.id}`) &&
      (query.afterUserId === undefined || compareIds(entry.userId, query.afterUserId) > 0)
    ) {
      users.add(entry.userId);
    }
  }
  return [...users].sort(compareIds).slice(0, limit);
}

/** 由调用方持有现有全局写锁；单条 SQL 只删除超额故障，不加载完整 Store。 */
export async function trimPrismaIncidents(client: Pick<PrismaClient, "$executeRaw">, keep: number): Promise<number> {
  if (!Number.isSafeInteger(keep) || keep < 0) {
    throw new RangeError("Incident retention must be a non-negative safe integer");
  }
  return client.$executeRaw(Prisma.sql`
    DELETE FROM operational_incidents
    WHERE id IN (
      SELECT id FROM operational_incidents
      ORDER BY updated_at DESC, id COLLATE "C" DESC
      OFFSET ${keep}
    )
  `);
}

function batchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("Maintenance batch limit must be an integer between 1 and 1000");
  }
  return limit;
}

function requiredDate(value: string, name: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`Invalid maintenance ${name}`);
  return date;
}

function optionalDate(value: string | undefined, name: string): Date | undefined {
  return value === undefined ? undefined : requiredDate(value, name);
}

function atOrBefore(value: string | null | undefined, cutoff: number | undefined): boolean {
  if (!value || cutoff === undefined) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= cutoff;
}

function compareIds(left: string, right: string): number {
  // PostgreSQL COLLATE "C" 按 UTF-8 字节排序，避免运行主机 locale 影响游标边界。
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
