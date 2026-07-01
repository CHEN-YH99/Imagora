-- 积分过期批次追踪：GRANT 流水记录该批次过期时间（NULL 表示永不过期）
ALTER TABLE "credit_ledger_entries"
ADD COLUMN "expires_at" TIMESTAMP(3);

-- 便于过期扫描按到期时间检索未过期的发放批次
CREATE INDEX "credit_ledger_entries_expires_at_idx" ON "credit_ledger_entries" ("expires_at");

-- 生成任务记录供应商侧真实成本（分），用于毛利核算
ALTER TABLE "generation_tasks"
ADD COLUMN "provider_cost_cents" INTEGER NOT NULL DEFAULT 0;
