# Imagora Local Runtime

This Compose file starts the web app, API, worker, PostgreSQL, and Redis.

```bash
docker compose -f infra/docker-compose.yml up
```

This is a development runtime. The app still uses the local JSON store by default, while PostgreSQL and Redis are available for the Prisma/BullMQ migration checkpoint.

## Production-Style Runtime

The production-style Compose file builds immutable images for Web, API, and Worker instead of running `npm install && npm run dev` inside containers.

```bash
npm run deploy:local-prod
```

Equivalent direct command:

```bash
docker compose -f infra/docker-compose.prod.yml up -d --build
```

Default services:

| Service | Image source | Port |
| --- | --- | --- |
| `web` | `infra/Dockerfile.web` | `3100` |
| `api` | `infra/Dockerfile.api` | `4100` |
| `worker` | `infra/Dockerfile.worker` | internal |
| `postgres` | `postgres:16-alpine` | internal |
| `redis` | `redis:7-alpine` | internal |

Production-style defaults use Prisma/PostgreSQL and BullMQ/Redis:

```text
DATA_STORE=prisma
QUEUE_PROVIDER=bullmq
```

For a real production environment, replace mock providers before accepting paid traffic:

```text
IMAGE_PROVIDER_DEFAULT=openai
PAYMENT_PROVIDER=stripe
STORAGE_PROVIDER=s3 # or r2
MAILER_PROVIDER=smtp
SAFETY_PROVIDER=http
```

Required provider settings:

```text
OPENAI_API_KEY=...
IMAGE_MODEL_DEFAULT=openai:gpt-image-2
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=imagora
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
SMTP_HOST=smtp.example.com
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=noreply@example.com
SAFETY_TEXT_ENDPOINT=https://safety.example.com/text
SAFETY_IMAGE_ENDPOINT=https://safety.example.com/image
SESSION_COOKIE_SECURE=true
NEXT_PUBLIC_PAYMENT_PROVIDER=stripe
```

Legacy compatibility remains for `AI_PROVIDER` and `OPENAI_IMAGE_MODEL`, but new deployments should use `IMAGE_PROVIDER_DEFAULT` and `IMAGE_MODEL_DEFAULT`.

`mock`, `inline`, `console`, `local`, and JSON store are only acceptable for local demos and smoke checks. Do not accept paid traffic until OpenAI or another real AI provider, S3/R2-compatible object storage, Stripe webhook signature verification, SMTP delivery, third-party HTTP safety review, Prisma/PostgreSQL, and secure cookies are configured.

## Runtime Checks

Before a gray release, run the local quality gate:

```bash
npm run typecheck
npm test
npm run build
npm run release:drill
npm run p0:check
npm audit --omit=dev
git diff --check
```

After deployment, run smoke and load checks:

```bash
npm run smoke
npm run load:smoke
```

By default, `npm run load:smoke` starts a local built API on `API_BASE_URL` when `API_BASE_URL` is not set. Use `API_BASE_URL`, `WEB_BASE_URL`, `LOAD_MANAGE_API=0`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_TARGETS`, `LOAD_AVG_MS`, `LOAD_P95_MS`, and `LOAD_FAILURE_RATE_MAX` to target another environment and set release thresholds.

`npm run load:smoke` checks `/health` and `/api/features` by default. `LOAD_TARGETS` accepts a comma-separated list, for example:

```bash
LOAD_TARGETS=/health,/api/features LOAD_P95_MS=1000 LOAD_FAILURE_RATE_MAX=0 npm run load:smoke
```

`npm run release:drill` performs a local gray-release rehearsal without deploying: it verifies the production configuration checklist, build artifacts, JSON backup/restore hashing, and rollback checklist. Missing real provider credentials are warnings by default because local development cannot invent external accounts; set `RELEASE_DRILL_STRICT=1` before an actual gray release to fail on those gaps.

`npm run p0:check` 是 P0 生产就绪入口。它会以严格模式运行 `release:drill`，并明确标出外部 Provider smoke 的边界：没有灰度环境时，`external-provider-smoke` 只能是 manual，因为真实 OpenAI、S3/R2、Stripe、SMTP、第三方安全审核不能靠本地 mock 结果验收。

最终灰度 P0 签收前，先对已部署的灰度环境运行 smoke 和 load 检查：

```bash
API_BASE_URL=https://<gray-api> WEB_BASE_URL=https://<gray-web> SMOKE_MANAGE_SERVICES=0 npm run smoke
API_BASE_URL=https://<gray-api> LOAD_MANAGE_API=0 LOAD_FAILURE_RATE_MAX=0 npm run load:smoke
```

然后强制要求外部联调证据：

```bash
P0_REQUIRE_EXTERNAL_SMOKE=1 P0_EXTERNAL_SMOKE_PASSED=1 P0_EXTERNAL_SMOKE_EVIDENCE=<run-id-or-url> npm run p0:check
```

The API health probe is:

```bash
curl http://127.0.0.1:4100/health
```

The admin operational metrics endpoint is:

```bash
GET /api/admin/metrics
```

It returns service uptime, HTTP counters, domain counters, feature flags, and order maintenance counters.

## Alert Thresholds

The MVP exposes operational alerts in `GET /api/admin/metrics`. The defaults are intentionally conservative for a gray release:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `ALERT_GENERATION_FAILURE_RATE` | `0.35` | Alert when failed generation tasks exceed this terminal-task ratio. |
| `ALERT_GENERATION_BACKLOG_MAX` | `25` | Alert when pending plus running generation tasks exceed this count. |
| `ALERT_STALE_RUNNING_MINUTES` | `10` | Running tasks older than this are treated as stale. |
| `ALERT_STALE_RUNNING_TASKS_MAX` | `0` | Alert when stale running tasks exceed this count. |
| `ALERT_PENDING_ORDERS_MAX` | `50` | Alert when pending payment orders exceed this count. |
| `ALERT_PAYMENT_AMOUNT_MISMATCH_MAX` | `0` | Alert when payment succeeded events have amount mismatches. |
| `ALERT_HTTP_FAILURE_RATE` | `0.05` | Alert when HTTP 5xx responses exceed this request ratio. |

## Gray Release Checklist

1. Confirm `FEATURE_GENERATION_ENABLED`, `FEATURE_PAYMENTS_ENABLED`, `FEATURE_UPLOADS_ENABLED`, and `FEATURE_DOWNLOADS_ENABLED` match the release plan.
2. Confirm `ORDER_PENDING_TTL_MINUTES` is set. The default is 30 minutes.
3. Confirm production secrets are injected through environment variables only.
4. Run the quality gate above from a clean install.
5. Confirm an admin can open `/admin`, read metrics, and trigger order reconciliation.
6. Submit one mock generation task and verify it reaches `SUCCEEDED`.
7. Submit one blocked prompt and verify it returns `CONTENT_BLOCKED`.
8. Create one order, simulate a successful payment webhook, and verify credits are granted once.
9. Upload one valid reference image and one disguised invalid file.
10. Watch generation success rate, payment event count, HTTP failures, and order maintenance counters for 24 to 48 hours before full rollout.
11. Run `npm run smoke` against the gray environment.
12. Run `npm run load:smoke` against the API health and feature endpoints and keep p95 below the release target.
13. Run `npm run release:drill`; for real gray release rehearsal, use `RELEASE_DRILL_STRICT=1`.

## API Contracts

### Generation

`POST /api/generation/tasks` creates an async task and returns immediately with a task id. The API validates feature flags, auth, reference image ownership, prompt safety, credit balance, and `clientRequestId` idempotency before enqueueing work.

`GET /api/generation/tasks/:taskId` is the polling endpoint. Terminal statuses are `SUCCEEDED`, `FAILED`, `CANCELED`, and `BLOCKED`.

`POST /api/generation/tasks/:taskId/retry` creates a new task from a failed or blocked task and charges credits again through the normal ledger path.

### Payments

`POST /api/orders` creates a pending order from the server-side plan snapshot. Frontend prices are not trusted.

`POST /api/payments/webhooks/:provider` verifies the provider payload, stores the raw payment event once, checks the amount against the order, and grants credits through `order-grant:{orderId}` idempotency.

`POST /api/admin/maintenance/reconcile` closes expired pending orders, replays valid succeeded payment events, and backfills missing paid-order credit grants.

### Worker

The worker processes generation jobs from BullMQ or the inline JSON-store scanner. It moves tasks through `PENDING -> RUNNING -> SUCCEEDED|FAILED`, stores generated images, and refunds failed tasks once through `task-refund:{taskId}` idempotency.

## Error Code Guide

| Code | User-facing copy | Operator action |
| --- | --- | --- |
| `VALIDATION_ERROR` | Some submitted fields are invalid. | Check request payload and field limits. |
| `UNAUTHORIZED` | Please sign in again. | Confirm token/session expiry. |
| `FORBIDDEN` | This account cannot access the requested resource. | Check role, ownership, or account status. |
| `NOT_FOUND` | The requested item was not found. | Check resource id and ownership. |
| `CONFLICT` | This action conflicts with existing data. | Check duplicate email or idempotency key. |
| `INSUFFICIENT_CREDITS` | Not enough credits for this generation. | Ask the user to top up or lower quantity/quality. |
| `CONTENT_BLOCKED` | The prompt or upload did not pass safety checks. | Review safety rule hit and user appeal context. |
| `TASK_NOT_RETRYABLE` | This task cannot be retried. | Confirm task status is failed or blocked. |
| `PLAN_UNAVAILABLE` | This plan is no longer available. | Check plan status in admin. |
| `ORDER_NOT_PAYABLE` | This order can no longer be paid. | Create a new order unless a late provider webhook is being reconciled. |
| `RATE_LIMITED` | Too many requests. Please retry later. | Check IP activity and rate-limit headers. |
| `FEATURE_DISABLED` | This feature is temporarily unavailable. | Confirm feature flags and incident status. |
| `INTERNAL_ERROR` | Something went wrong. | Search logs by `requestId`. |

## Rollback

Use feature flags before rolling back infrastructure:

1. Payment incident: set `FEATURE_PAYMENTS_ENABLED=false`, keep generation and history online, then run `POST /api/admin/maintenance/reconcile` after the provider recovers.
2. AI provider incident: set `FEATURE_GENERATION_ENABLED=false`, keep account, pricing, history, and orders online.
3. Storage incident: set `FEATURE_DOWNLOADS_ENABLED=false`, keep task status and history visible.
4. Upload incident: set `FEATURE_UPLOADS_ENABLED=false`, keep text-to-image generation online.
5. Bad deploy: restore the previous app image or commit, keep the data volume, then run the quality gate and health probe.

Never delete the PostgreSQL volume or JSON store during rollback. Data rollback must be a restore from a verified backup, not a volume wipe.

## Incident Runbook

### Payment credits did not arrive

1. Open `/admin` and check operational metrics.
2. Trigger `Reconcile orders`.
3. Verify `reconciledPaidOrders` or `reconciledPaymentEvents` increased.
4. Check the affected user credit ledger for `order-grant:{orderId}`.
5. If the payment provider webhook amount does not match the order amount, do not manually grant credits until the provider event is verified.

### Pending orders pile up

1. Confirm `ORDER_PENDING_TTL_MINUTES`.
2. Trigger `POST /api/admin/maintenance/reconcile`.
3. Verify `closedExpiredOrders` increased.
4. If new orders keep piling up, disable payments and inspect provider status.

### Generation tasks are stuck

1. Check `/api/admin/metrics` for failed and running task counts.
2. Restart the worker.
3. Keep `FEATURE_GENERATION_ENABLED=false` if the provider failure rate is high.
4. Verify failed tasks refund credits once, not repeatedly.

### Unsafe upload or prompt bypass

1. Add or update the safety rule in `/admin`.
2. Confirm the rule writes an audit log.
3. Re-test the prompt or upload path.
4. Keep `FEATURE_UPLOADS_ENABLED=false` if file validation is suspected to be broken.

## Database Migration Notes

For Prisma checkpoints:

```bash
npm --workspace packages/database run prisma:validate
npm --workspace packages/database run prisma:generate
npm --workspace packages/database run prisma:push
```

Migration rollback must use a database backup taken before the migration. Do not rely on `prisma db push` as a reversible migration tool.

## JSON Store Backup

The production-style runtime should use PostgreSQL. For local JSON-store environments, use:

```bash
npm run backup:json
npm run restore:json -- backups/imagora-store-YYYY-MM-DDTHH-MM-SS-000Z.json
```

`IMAGORA_STORE_PATH` controls the source/target store path. `BACKUP_DIR` controls the backup directory.

Backups now validate JSON before copying, write a sibling `.manifest.json` with `sha256`, and verify the copied file hash. Restore validates JSON and checks the manifest hash when it is present before copying back to the target store.

## Object Storage Lifecycle

The inline storage provider is only for local and smoke environments. Production S3/R2/OSS/COS buckets must enforce:

1. Default private objects.
2. Lifecycle expiration for temporary reference uploads.
3. No permanent CDN cache for private generated images.
4. Versioning or object-lock policy for rollback-sensitive assets.
5. Periodic review of orphaned objects whose database rows were deleted.
