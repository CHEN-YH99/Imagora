CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");
CREATE INDEX "payment_events_order_id_created_at_idx" ON "payment_events"("order_id", "created_at");
CREATE INDEX "image_favorites_image_id_idx" ON "image_favorites"("image_id");
