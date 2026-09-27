CREATE INDEX "credit_ledger_entries_user_id_source_type_source_id_type_idx"
ON "credit_ledger_entries" ("user_id", "source_type", "source_id", "type");

CREATE INDEX "generation_tasks_user_id_status_created_at_id_idx"
ON "generation_tasks" ("user_id", "status", "created_at" DESC, "id" DESC);
