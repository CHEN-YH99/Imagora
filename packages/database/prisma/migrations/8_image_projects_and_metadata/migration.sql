CREATE TABLE "image_projects" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "cover_image_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3),

  CONSTRAINT "image_projects_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "generated_images"
  ADD COLUMN "project_id" TEXT,
  ADD COLUMN "generation_metadata" JSONB NOT NULL DEFAULT '{}';

UPDATE "generated_images" AS image
SET "generation_metadata" = jsonb_build_object(
  'taskId', task."id",
  'prompt', task."prompt",
  'negativePrompt', task."negative_prompt",
  'style', task."style",
  'aspectRatio', task."aspect_ratio",
  'quality', task."quality",
  'quantity', task."quantity",
  'modelProvider', task."model_provider",
  'modelName', task."model_name",
  'width', task."width",
  'height', task."height",
  'creditCost', task."credit_cost",
  'createdAt', task."created_at"
)
FROM "generation_tasks" AS task
WHERE image."task_id" = task."id"
  AND image."generation_metadata" = '{}'::jsonb;

CREATE INDEX "image_projects_user_id_updated_at_idx" ON "image_projects"("user_id", "updated_at" DESC);
CREATE INDEX "image_projects_user_id_archived_at_idx" ON "image_projects"("user_id", "archived_at");
CREATE INDEX "generated_images_project_id_created_at_idx" ON "generated_images"("project_id", "created_at" DESC);

ALTER TABLE "image_projects"
  ADD CONSTRAINT "image_projects_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_images"
  ADD CONSTRAINT "generated_images_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "image_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
