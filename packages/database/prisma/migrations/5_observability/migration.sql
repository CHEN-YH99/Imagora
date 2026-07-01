-- 第九关可观测性：持久化最近异常与本地告警通知记录
CREATE TABLE "operational_incidents" (
  "id" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "area" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "message" TEXT NOT NULL,
  "error_code" TEXT,
  "request_id" TEXT,
  "user_id" TEXT,
  "task_id" TEXT,
  "order_id" TEXT,
  "route" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),

  CONSTRAINT "operational_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alert_notifications" (
  "id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "alert_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "operational_incidents_status_created_at_idx" ON "operational_incidents" ("status", "created_at" DESC);
CREATE INDEX "operational_incidents_request_id_idx" ON "operational_incidents" ("request_id");
CREATE INDEX "operational_incidents_task_id_idx" ON "operational_incidents" ("task_id");
CREATE INDEX "operational_incidents_order_id_idx" ON "operational_incidents" ("order_id");
CREATE UNIQUE INDEX "alert_notifications_dedupe_key_key" ON "alert_notifications" ("dedupe_key");
CREATE INDEX "alert_notifications_alert_id_created_at_idx" ON "alert_notifications" ("alert_id", "created_at" DESC);
