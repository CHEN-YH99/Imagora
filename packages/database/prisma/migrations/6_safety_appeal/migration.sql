-- CreateEnum
CREATE TYPE "SafetyAppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "safety_appeals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "safety_event_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "SafetyAppealStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "safety_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "safety_appeals_user_id_created_at_idx" ON "safety_appeals"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "safety_appeals_status_created_at_idx" ON "safety_appeals"("status", "created_at");

-- CreateIndex
CREATE INDEX "safety_appeals_safety_event_id_idx" ON "safety_appeals"("safety_event_id");

-- AddForeignKey
ALTER TABLE "safety_appeals" ADD CONSTRAINT "safety_appeals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
