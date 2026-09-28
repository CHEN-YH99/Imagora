-- 定向任务退款与积分过期候选查询，不依赖 user_id 前缀遍历整个账本。
CREATE INDEX IF NOT EXISTS "credit_ledger_entries_source_type_source_id_type_idx"
ON "credit_ledger_entries"("source_type", "source_id", "type");

CREATE INDEX IF NOT EXISTS "credit_ledger_entries_type_expires_at_user_id_idx"
ON "credit_ledger_entries"("type", "expires_at", "user_id");
