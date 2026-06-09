# Imagora 技术实现文档

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 项目名称 | Imagora |
| 文档名称 | Imagora 技术实现文档 |
| 版本 | v1.0 |
| 日期 | 2026-06-09 |
| 前置文档 | AI图片生成网站用户需求文档.md |
| 适用范围 | AI 图片生成网站的架构设计、研发拆分、接口设计、数据建模、部署与验收 |

## 2. 技术目标

Imagora 的首版技术目标是稳定打通“用户输入提示词 -> 创建生成任务 -> 扣减积分 -> 异步生成图片 -> 存储图片 -> 展示和下载结果”的核心闭环。

系统设计应优先保证以下能力：

1. 生成任务异步化，避免模型调用耗时拖垮 Web 请求。
2. 积分扣减、任务创建、失败退款必须可追踪、可补偿。
3. 模型、支付、对象存储、内容审核供应商必须可替换。
4. 用户私有数据必须严格隔离，不能让用户看到别人的图。
5. 管理后台能定位用户、任务、图片、订单和异常原因。
6. MVP 先做清楚核心链路，不要一上来搞模板市场、团队空间、在线编辑器，那是典型没走稳就想开飞机。

## 3. 技术选型

需求文档未指定技术栈，本文给出推荐默认方案。后续如已有团队栈或部署约束，可替换同层组件。

### 3.1 推荐栈

| 层级 | 推荐方案 | 说明 |
| --- | --- | --- |
| 前端 Web | Next.js + React + TypeScript | 支持 SEO、服务端渲染、复杂交互和后台页面 |
| UI | Tailwind CSS + Radix UI / shadcn/ui 风格组件 | 快速构建一致的表单、弹窗、菜单、表格 |
| 后端 API | NestJS 或 Fastify + TypeScript | 模块化清晰，适合账户、支付、任务、后台 API |
| 异步任务 | BullMQ + Redis | 生成任务排队、重试、限流、失败处理 |
| 数据库 | PostgreSQL | 适合交易、订单、积分流水和查询 |
| ORM | Prisma | 数据模型清晰，迁移和类型生成方便 |
| 缓存 | Redis | 会话、验证码、任务状态缓存、限流 |
| 图片存储 | S3 兼容对象存储 | 可对接 AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS 等 |
| CDN | 对象存储 CDN 或独立 CDN | 加速图片预览和下载 |
| 支付 | 支付适配器接口 | 国内可接微信/支付宝，海外可接 Stripe |
| 内容审核 | 审核适配器接口 | 支持本地规则和第三方审核服务 |
| 日志 | 结构化 JSON 日志 | 便于生产环境检索和告警 |
| 部署 | Docker Compose 起步，后续 Kubernetes 或托管平台 | MVP 先稳，别第一天就把运维复杂度拉满 |

### 3.2 选型原则

1. 前后端统一 TypeScript，减少类型割裂。
2. 数据一致性靠 PostgreSQL 事务保证，不靠“应该不会出错”的玄学。
3. 耗时任务放到 Worker，不在 HTTP 请求里直接等模型返回。
4. 所有外部供应商都通过接口适配，不让业务代码直接依赖供应商 SDK。
5. 生成图片只存对象存储地址和元数据，不把二进制塞数据库。

## 4. 总体架构

### 4.1 逻辑架构

```mermaid
flowchart LR
  User[用户浏览器] --> Web[Next.js Web]
  Admin[管理员浏览器] --> Web
  Web --> API[API 服务]
  API --> DB[(PostgreSQL)]
  API --> Redis[(Redis)]
  API --> Queue[生成任务队列]
  Queue --> Worker[Generation Worker]
  Worker --> AI[AI 模型供应商]
  Worker --> Safety[内容审核服务]
  Worker --> Storage[对象存储]
  API --> Payment[支付渠道]
  Payment --> API
  Storage --> CDN[CDN]
  CDN --> User
```

### 4.2 服务拆分

| 服务 | 职责 |
| --- | --- |
| `apps/web` | 用户前台、管理后台、登录注册、生成页、历史页、价格页 |
| `apps/api` | 认证、用户、任务、图片、积分、订单、后台管理 API |
| `apps/worker` | 消费生成队列、调用模型、保存图片、审核结果、失败退款 |
| `packages/shared` | 共享类型、枚举、校验规则、错误码 |
| `packages/database` | Prisma schema、迁移、种子数据 |
| `packages/ai-providers` | AI 模型供应商适配器 |
| `packages/storage` | 对象存储适配器 |
| `packages/payments` | 支付渠道适配器 |
| `packages/safety` | 文本和图片安全审核适配器 |

### 4.3 推荐仓库结构

```text
Imagora/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   └── lib/
│   ├── api/
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   ├── shared/
│   │   │   ├── config/
│   │   │   └── main.ts
│   │   └── tests/
│   └── worker/
│       ├── src/
│       │   ├── jobs/
│       │   ├── processors/
│       │   └── main.ts
│       └── tests/
├── packages/
│   ├── shared/
│   ├── database/
│   ├── ai-providers/
│   ├── storage/
│   ├── payments/
│   └── safety/
├── infra/
│   ├── docker-compose.yml
│   └── nginx/
├── docs/
└── package.json
```

## 5. 核心模块设计

### 5.1 用户与认证模块

功能范围：

1. 邮箱注册、登录、退出。
2. 密码重置。
3. 用户资料读取和修改。
4. 用户角色管理。
5. 会话管理。

实现要求：

1. 密码使用 Argon2id 或 bcrypt 哈希存储，禁止明文和可逆加密。
2. 登录态使用 `HttpOnly`、`Secure`、`SameSite` Cookie。
3. 管理员权限通过角色校验，后台接口必须二次校验。
4. 登录、注册、密码重置接口必须限流。
5. 用户 ID 使用 UUID，避免自增 ID 暴露业务规模。

### 5.2 图片生成模块

功能范围：

1. 创建生成任务。
2. 计算积分消耗。
3. 检查用户余额。
4. 检查提示词和参考图安全。
5. 写入任务记录。
6. 投递队列。
7. 查询任务状态。
8. 失败重试和失败退款。

任务状态：

| 状态 | 说明 |
| --- | --- |
| `PENDING` | 任务已创建，等待 Worker 消费 |
| `RUNNING` | Worker 正在处理 |
| `SUCCEEDED` | 生成成功，图片已入库 |
| `FAILED` | 生成失败，已记录失败原因 |
| `CANCELED` | 任务被系统或管理员取消 |
| `BLOCKED` | 命中内容安全规则，未进入模型生成 |

任务创建流程：

```mermaid
sequenceDiagram
  participant U as User
  participant API as API
  participant DB as PostgreSQL
  participant S as Safety
  participant Q as Queue

  U->>API: POST /generation/tasks
  API->>API: 校验参数
  API->>S: 审核提示词/参考图
  S-->>API: 审核通过
  API->>DB: 事务：检查余额、创建任务、扣积分、写流水
  API->>Q: 投递生成任务
  API-->>U: 返回 taskId 和状态
```

Worker 处理流程：

```mermaid
sequenceDiagram
  participant Q as Queue
  participant W as Worker
  participant AI as AI Provider
  participant ST as Object Storage
  participant S as Safety
  participant DB as PostgreSQL

  Q->>W: 消费任务
  W->>DB: 标记 RUNNING
  W->>AI: 提交生成请求
  AI-->>W: 返回图片数据或图片 URL
  W->>S: 审核生成结果
  W->>ST: 上传原图和缩略图
  W->>DB: 保存图片，标记 SUCCEEDED
```

失败处理：

1. 参数错误：请求阶段直接返回 `400`，不创建任务，不扣积分。
2. 内容违规：任务可记录为 `BLOCKED`，不扣积分。
3. 模型失败：任务标记 `FAILED`，按规则退还积分。
4. 对象存储失败：任务可重试，超过重试次数后退款。
5. Worker 崩溃：队列自动重试，任务超时后进入失败补偿。

### 5.3 图片管理模块

功能范围：

1. 生成结果列表。
2. 图片详情。
3. 下载图片。
4. 收藏和取消收藏。
5. 删除生成记录。
6. 基于历史参数再次生成。

实现要求：

1. 图片访问必须校验所属用户或公开权限。
2. 下载链接建议使用短期签名 URL，避免原始存储地址长期裸奔。
3. 列表页使用缩略图，详情页再加载原图。
4. 删除记录优先做软删除，后续由定时任务清理对象存储。
5. 收藏关系独立建表，不要把收藏状态直接塞图片表里凑合。

### 5.4 积分模块

功能范围：

1. 查询积分余额。
2. 生成前预估消耗。
3. 任务创建扣减积分。
4. 任务失败退还积分。
5. 查看积分流水。
6. 管理员人工调整积分。

实现要求：

1. 积分余额和流水必须在同一个数据库事务内更新。
2. 积分流水只追加，不物理删除。
3. 每条流水必须包含业务来源，例如任务 ID、订单 ID 或管理员操作 ID。
4. 退款操作必须幂等，同一任务不能重复退款。
5. 余额字段可冗余存储，但以流水和事务规则作为审计依据。

积分消耗建议：

| 参数 | 成本影响 |
| --- | --- |
| 生成数量 | 线性增加 |
| 图片尺寸 | 尺寸越大成本越高 |
| 生成质量 | 高质量提高倍率 |
| 模型类型 | 不同模型有不同基础成本 |
| 会员等级 | 可配置折扣或赠送额度 |

### 5.5 支付与订单模块

功能范围：

1. 套餐列表。
2. 创建订单。
3. 拉起支付。
4. 支付回调。
5. 订单状态查询。
6. 支付成功发放积分或会员权益。

订单状态：

| 状态 | 说明 |
| --- | --- |
| `PENDING` | 待支付 |
| `PAID` | 已支付 |
| `CANCELED` | 已取消 |
| `REFUNDED` | 已退款 |
| `CLOSED` | 超时关闭 |

实现要求：

1. 金额使用整数分存储，不使用浮点数。
2. 支付回调必须校验签名。
3. 支付事件必须落库，按支付平台事件 ID 做幂等。
4. 发放积分和更新订单状态必须在事务内完成。
5. 支付成功但权益发放失败时，必须支持补偿任务。

支付回调流程：

```mermaid
sequenceDiagram
  participant P as Payment Provider
  participant API as API
  participant DB as PostgreSQL

  P->>API: POST /payments/webhooks/:provider
  API->>API: 校验签名
  API->>DB: 保存支付事件，检查幂等
  API->>DB: 事务：更新订单、发放权益、写积分流水
  API-->>P: 返回成功
```

### 5.6 内容安全模块

功能范围：

1. 提示词敏感词检查。
2. 上传图片审核。
3. 生成结果审核。
4. 管理员内容处理。
5. 审核事件记录。

实现要求：

1. 安全检查分为本地规则和第三方审核两层。
2. 命中明确违规规则时直接拦截。
3. 不确定风险可进入人工审核或隐藏状态。
4. 所有拦截必须记录原因、规则、用户、任务和时间。
5. 安全规则支持后台配置和灰度启用。

### 5.7 管理后台模块

功能范围：

1. 数据概览。
2. 用户管理。
3. 任务管理。
4. 图片内容管理。
5. 套餐管理。
6. 订单管理。
7. 系统配置。
8. 管理员操作日志。

实现要求：

1. 后台路由和 API 必须统一走管理员鉴权。
2. 高风险操作需要二次确认，例如封禁、删除、退款、人工加积分。
3. 后台列表必须支持分页、筛选、搜索和排序。
4. 所有后台写操作必须记录 `admin_audit_logs`。

## 6. 数据库设计

### 6.1 主要数据表

#### `users`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 用户 ID |
| `email` | varchar | 邮箱，唯一 |
| `password_hash` | varchar | 密码哈希 |
| `nickname` | varchar | 昵称 |
| `avatar_url` | text | 头像地址 |
| `role` | enum | `USER`、`ADMIN` |
| `status` | enum | `ACTIVE`、`SUSPENDED`、`DELETED` |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 更新时间 |
| `last_login_at` | timestamp | 最近登录时间 |

#### `user_credit_accounts`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | UUID | 用户 ID，主键 |
| `balance` | integer | 当前积分余额 |
| `total_earned` | integer | 累计获得 |
| `total_spent` | integer | 累计消耗 |
| `updated_at` | timestamp | 更新时间 |

#### `credit_ledger_entries`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 流水 ID |
| `user_id` | UUID | 用户 ID |
| `type` | enum | `GRANT`、`SPEND`、`REFUND`、`EXPIRE`、`ADJUST` |
| `amount` | integer | 积分变化，正数增加，负数减少 |
| `balance_after` | integer | 变更后余额 |
| `source_type` | enum | `TASK`、`ORDER`、`ADMIN`、`SYSTEM` |
| `source_id` | UUID | 业务来源 ID |
| `idempotency_key` | varchar | 幂等键 |
| `remark` | text | 备注 |
| `created_at` | timestamp | 创建时间 |

#### `generation_tasks`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 任务 ID |
| `user_id` | UUID | 用户 ID |
| `prompt` | text | 正向提示词 |
| `negative_prompt` | text | 负向提示词 |
| `style` | varchar | 风格 |
| `aspect_ratio` | varchar | 图片比例 |
| `width` | integer | 宽度 |
| `height` | integer | 高度 |
| `quantity` | integer | 生成数量 |
| `quality` | varchar | 质量 |
| `model_provider` | varchar | 模型供应商 |
| `model_name` | varchar | 模型名称 |
| `status` | enum | 任务状态 |
| `credit_cost` | integer | 消耗积分 |
| `failure_code` | varchar | 失败码 |
| `failure_message` | text | 失败说明 |
| `started_at` | timestamp | 开始时间 |
| `completed_at` | timestamp | 完成时间 |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 更新时间 |

#### `generated_images`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 图片 ID |
| `task_id` | UUID | 任务 ID |
| `user_id` | UUID | 用户 ID |
| `storage_key` | text | 原图对象存储 key |
| `thumbnail_key` | text | 缩略图对象存储 key |
| `public_url` | text | 公开展示地址，可为空 |
| `width` | integer | 宽度 |
| `height` | integer | 高度 |
| `file_size` | integer | 文件大小 |
| `mime_type` | varchar | 文件类型 |
| `safety_status` | enum | `PASSED`、`BLOCKED`、`REVIEW_REQUIRED` |
| `visibility` | enum | `PRIVATE`、`PUBLIC`、`HIDDEN` |
| `deleted_at` | timestamp | 软删除时间 |
| `created_at` | timestamp | 创建时间 |

#### `image_favorites`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | UUID | 用户 ID |
| `image_id` | UUID | 图片 ID |
| `created_at` | timestamp | 收藏时间 |

联合唯一索引：`(user_id, image_id)`。

#### `plans`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 套餐 ID |
| `name` | varchar | 套餐名称 |
| `description` | text | 套餐说明 |
| `price_cents` | integer | 价格，单位分 |
| `currency` | varchar | 币种 |
| `credits` | integer | 发放积分 |
| `valid_days` | integer | 有效期，可为空 |
| `status` | enum | `ACTIVE`、`INACTIVE` |
| `sort_order` | integer | 排序 |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 更新时间 |

#### `orders`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 订单 ID |
| `user_id` | UUID | 用户 ID |
| `plan_id` | UUID | 套餐 ID |
| `order_no` | varchar | 业务订单号，唯一 |
| `amount_cents` | integer | 金额 |
| `currency` | varchar | 币种 |
| `payment_provider` | varchar | 支付渠道 |
| `payment_intent_id` | varchar | 支付平台订单或意图 ID |
| `status` | enum | 订单状态 |
| `paid_at` | timestamp | 支付时间 |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 更新时间 |

#### `payment_events`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 事件 ID |
| `provider` | varchar | 支付渠道 |
| `provider_event_id` | varchar | 支付平台事件 ID |
| `order_id` | UUID | 关联订单 |
| `event_type` | varchar | 事件类型 |
| `payload` | jsonb | 原始回调内容 |
| `processed_at` | timestamp | 处理时间 |
| `created_at` | timestamp | 创建时间 |

联合唯一索引：`(provider, provider_event_id)`。

#### `safety_events`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 审核事件 ID |
| `user_id` | UUID | 用户 ID |
| `target_type` | enum | `PROMPT`、`UPLOAD_IMAGE`、`GENERATED_IMAGE` |
| `target_id` | UUID | 目标 ID |
| `status` | enum | `PASSED`、`BLOCKED`、`REVIEW_REQUIRED` |
| `reason_code` | varchar | 原因码 |
| `reason_message` | text | 原因说明 |
| `provider` | varchar | 审核来源 |
| `created_at` | timestamp | 创建时间 |

#### `admin_audit_logs`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 日志 ID |
| `admin_user_id` | UUID | 管理员 ID |
| `action` | varchar | 操作类型 |
| `target_type` | varchar | 目标类型 |
| `target_id` | UUID | 目标 ID |
| `before` | jsonb | 操作前数据 |
| `after` | jsonb | 操作后数据 |
| `ip_address` | varchar | IP |
| `user_agent` | text | 浏览器信息 |
| `created_at` | timestamp | 创建时间 |

### 6.2 索引建议

| 表 | 索引 | 用途 |
| --- | --- | --- |
| `users` | `email unique` | 登录和注册唯一性 |
| `generation_tasks` | `(user_id, created_at desc)` | 用户历史记录 |
| `generation_tasks` | `(status, created_at)` | 后台任务筛选和补偿扫描 |
| `generated_images` | `(user_id, created_at desc)` | 用户图片列表 |
| `generated_images` | `(task_id)` | 任务详情加载图片 |
| `credit_ledger_entries` | `(user_id, created_at desc)` | 积分流水 |
| `credit_ledger_entries` | `idempotency_key unique` | 防止重复扣减和退款 |
| `orders` | `(user_id, created_at desc)` | 用户订单列表 |
| `orders` | `order_no unique` | 订单查询和回调 |
| `payment_events` | `(provider, provider_event_id) unique` | 支付回调幂等 |

## 7. API 设计

API 默认使用 JSON。认证接口通过 Cookie 维护登录态，管理后台接口要求管理员角色。

### 7.1 通用响应格式

成功响应：

```json
{
  "data": {},
  "requestId": "req_123"
}
```

失败响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "积分余额不足",
    "details": {}
  },
  "requestId": "req_123"
}
```

### 7.2 认证接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | 邮箱注册 | 游客 |
| `POST` | `/api/auth/login` | 登录 | 游客 |
| `POST` | `/api/auth/logout` | 退出 | 登录用户 |
| `GET` | `/api/auth/me` | 当前用户信息 | 登录用户 |
| `POST` | `/api/auth/password-reset/request` | 请求重置密码 | 游客 |
| `POST` | `/api/auth/password-reset/confirm` | 确认重置密码 | 游客 |

### 7.3 用户接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| `GET` | `/api/users/me` | 获取个人资料 | 登录用户 |
| `PATCH` | `/api/users/me` | 更新昵称、头像 | 登录用户 |
| `GET` | `/api/users/me/credits` | 获取积分余额 | 登录用户 |
| `GET` | `/api/users/me/credit-ledger` | 获取积分流水 | 登录用户 |

### 7.4 生成接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| `POST` | `/api/generation/quote` | 预估积分消耗 | 登录用户 |
| `POST` | `/api/generation/tasks` | 创建生成任务 | 登录用户 |
| `GET` | `/api/generation/tasks` | 获取任务列表 | 登录用户 |
| `GET` | `/api/generation/tasks/:taskId` | 获取任务详情 | 登录用户 |
| `POST` | `/api/generation/tasks/:taskId/retry` | 基于失败任务重试 | 登录用户 |

创建任务请求示例：

```json
{
  "prompt": "A clean product photo of a futuristic wireless headphone on white background",
  "negativePrompt": "low quality, blurry, distorted",
  "style": "product_photography",
  "aspectRatio": "1:1",
  "quantity": 4,
  "quality": "standard",
  "referenceImageId": null
}
```

创建任务响应示例：

```json
{
  "data": {
    "taskId": "2e7a9e5c-7c96-4d6e-9fb7-7d9f2fdc5f5e",
    "status": "PENDING",
    "creditCost": 8,
    "balanceAfter": 92
  },
  "requestId": "req_123"
}
```

### 7.5 图片接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| `GET` | `/api/images` | 获取图片列表 | 登录用户 |
| `GET` | `/api/images/:imageId` | 获取图片详情 | 登录用户 |
| `POST` | `/api/images/:imageId/favorite` | 收藏图片 | 登录用户 |
| `DELETE` | `/api/images/:imageId/favorite` | 取消收藏 | 登录用户 |
| `POST` | `/api/images/:imageId/download-url` | 获取下载签名 URL | 登录用户 |
| `DELETE` | `/api/images/:imageId` | 删除图片记录 | 登录用户 |

### 7.6 套餐和订单接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| `GET` | `/api/plans` | 获取可购买套餐 | 游客 |
| `POST` | `/api/orders` | 创建订单 | 登录用户 |
| `GET` | `/api/orders` | 获取订单列表 | 登录用户 |
| `GET` | `/api/orders/:orderId` | 获取订单详情 | 登录用户 |
| `POST` | `/api/orders/:orderId/pay` | 继续支付 | 登录用户 |
| `POST` | `/api/payments/webhooks/:provider` | 支付回调 | 支付平台 |

### 7.7 管理后台接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| `GET` | `/api/admin/dashboard` | 数据概览 | 管理员 |
| `GET` | `/api/admin/users` | 用户列表 | 管理员 |
| `GET` | `/api/admin/users/:userId` | 用户详情 | 管理员 |
| `PATCH` | `/api/admin/users/:userId/status` | 修改用户状态 | 管理员 |
| `POST` | `/api/admin/users/:userId/credits/adjust` | 人工调整积分 | 管理员 |
| `GET` | `/api/admin/generation/tasks` | 任务列表 | 管理员 |
| `GET` | `/api/admin/images` | 图片内容列表 | 管理员 |
| `PATCH` | `/api/admin/images/:imageId/visibility` | 修改图片可见性 | 管理员 |
| `GET` | `/api/admin/orders` | 订单列表 | 管理员 |
| `POST` | `/api/admin/plans` | 新增套餐 | 管理员 |
| `PATCH` | `/api/admin/plans/:planId` | 编辑套餐 | 管理员 |
| `GET` | `/api/admin/audit-logs` | 操作日志 | 管理员 |

## 8. 异步任务设计

### 8.1 队列划分

| 队列 | 职责 |
| --- | --- |
| `generation` | 图片生成任务 |
| `image-postprocess` | 缩略图、元数据提取、格式转换 |
| `payment-compensation` | 支付成功后权益补偿 |
| `credit-refund` | 失败任务退款补偿 |
| `cleanup` | 软删除图片清理、过期任务处理 |

MVP 可以先只实现 `generation`，但队列命名和任务结构要给后续扩展留口子。

### 8.2 任务负载

```json
{
  "taskId": "2e7a9e5c-7c96-4d6e-9fb7-7d9f2fdc5f5e",
  "userId": "76f12e75-66db-4af4-9f17-a76e4ee9ce03",
  "attempt": 1,
  "requestedAt": "2026-06-09T01:30:00.000Z"
}
```

Worker 必须从数据库读取任务完整参数，不能完全相信队列 payload。队列消息是通知，不是事实来源。

### 8.3 重试策略

| 失败类型 | 策略 |
| --- | --- |
| 模型限流 | 指数退避重试 |
| 网络超时 | 重试 |
| 内容违规 | 不重试，标记 `BLOCKED` |
| 参数不支持 | 不重试，标记 `FAILED` |
| 对象存储失败 | 重试 |
| 数据库写入失败 | 重试并告警 |

建议每个任务最多自动重试 3 次。超过次数后进入失败状态，并触发退款补偿。

## 9. 供应商适配器设计

### 9.1 AI 模型适配器

业务代码只依赖统一接口：

```ts
export interface ImageGenerationProvider {
  name: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

export interface GenerateImageInput {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  quantity: number;
  quality: "draft" | "standard" | "high";
  style?: string;
  referenceImageUrl?: string;
}

export interface GenerateImageResult {
  images: Array<{
    url?: string;
    base64?: string;
    mimeType: string;
    width: number;
    height: number;
  }>;
  providerRequestId?: string;
  raw?: unknown;
}
```

### 9.2 存储适配器

```ts
export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getSignedUrl(input: GetSignedUrlInput): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
```

### 9.3 支付适配器

```ts
export interface PaymentProvider {
  name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent>;
}
```

### 9.4 内容审核适配器

```ts
export interface SafetyProvider {
  checkText(input: SafetyTextInput): Promise<SafetyResult>;
  checkImage(input: SafetyImageInput): Promise<SafetyResult>;
}
```

## 10. 前端实现设计

### 10.1 页面路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页/生成入口 | 展示核心输入入口和案例 |
| `/generate` | 图片生成页 | 提示词、参数、任务状态、结果 |
| `/history` | 历史记录 | 用户任务和图片列表 |
| `/favorites` | 收藏页 | 收藏图片 |
| `/pricing` | 价格页 | 套餐和积分包 |
| `/account` | 账户页 | 用户资料、余额、积分流水 |
| `/orders` | 订单页 | 订单列表 |
| `/login` | 登录 | 邮箱密码登录 |
| `/register` | 注册 | 邮箱注册 |
| `/admin` | 后台首页 | 数据概览 |
| `/admin/users` | 用户管理 | 用户列表和详情 |
| `/admin/tasks` | 任务管理 | 生成任务 |
| `/admin/images` | 内容管理 | 图片和审核结果 |
| `/admin/plans` | 套餐管理 | 套餐配置 |
| `/admin/orders` | 订单管理 | 订单列表 |

### 10.2 状态管理

1. 服务端数据使用请求缓存库或框架数据加载能力。
2. 表单状态使用局部状态，不上全局仓库。
3. 登录用户、积分余额、当前任务状态可以做轻量全局缓存。
4. 任务状态 MVP 使用轮询，生成中每 2 到 3 秒查询一次。
5. 后续可升级为 SSE 或 WebSocket 推送。

### 10.3 生成页交互

必须具备：

1. 提示词输入框。
2. 风格选择。
3. 比例选择。
4. 数量选择。
5. 质量选择。
6. 预计积分消耗。
7. 当前余额。
8. 生成按钮的加载和禁用状态。
9. 任务状态展示。
10. 结果图片网格。
11. 下载、收藏、复制提示词、再次生成操作。

交互规则：

1. 提示词为空不能提交。
2. 余额不足不能提交。
3. 提交中禁止重复点击。
4. 任务失败展示可读错误和重试按钮。
5. 移动端参数面板应可折叠，别把用户手机屏幕塞成电表箱。

### 10.4 管理后台前端

后台以表格、筛选器、详情抽屉、确认弹窗为主，不做花哨首页。

关键组件：

1. 数据概览指标卡。
2. 通用筛选表单。
3. 分页表格。
4. 任务详情抽屉。
5. 图片预览弹窗。
6. 用户状态修改确认框。
7. 套餐编辑表单。

## 11. 安全设计

### 11.1 认证与授权

1. 所有用户私有接口必须要求登录。
2. 所有后台接口必须要求管理员角色。
3. 服务端必须校验资源所属关系，例如 `image.user_id === currentUser.id`。
4. Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax` 或更严格配置。
5. 登录失败次数和敏感操作必须限流。

### 11.2 输入校验

1. 所有 API 入参使用 schema 校验。
2. 提示词长度必须限制。
3. 图片上传限制格式、大小、尺寸和数量。
4. 分页参数限制最大页大小。
5. 后台搜索参数避免直接拼 SQL。

### 11.3 文件安全

1. 上传文件不信任扩展名，必须检查 MIME 和文件签名。
2. 上传图片建议重新编码或生成安全副本。
3. 原始对象存储 bucket 不公开，访问通过签名 URL 或 CDN 鉴权。
4. 文件 key 不包含用户原始文件名，避免路径和隐私问题。

### 11.4 支付安全

1. 回调必须校验签名。
2. 回调处理必须幂等。
3. 订单金额以服务端套餐为准，不能相信前端传来的价格。
4. 支付成功发放权益必须落库可追踪。

### 11.5 内容安全

1. 提交前审核提示词。
2. 上传前或上传后立即审核参考图。
3. 生成后审核结果图。
4. 违规内容不展示、不下载、不公开。
5. 管理员处理违规内容必须记录审计日志。

## 12. 配置与环境变量

示例环境变量：

```text
NODE_ENV=development
APP_URL=http://localhost:3000
API_URL=http://localhost:4000

DATABASE_URL=postgresql://user:password@localhost:5432/imagora
REDIS_URL=redis://localhost:6379

SESSION_SECRET=change-me
PASSWORD_RESET_TOKEN_TTL_MINUTES=30

S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE_URL=

AI_PROVIDER=
AI_API_KEY=
AI_MODEL_NAME=

PAYMENT_PROVIDER=
PAYMENT_WEBHOOK_SECRET=

SAFETY_PROVIDER=
SAFETY_API_KEY=
```

要求：

1. `.env` 不提交到版本库。
2. 提供 `.env.example` 说明必填项。
3. 生产环境密钥由部署平台或密钥管理系统注入。
4. 不在前端暴露后端密钥、模型密钥、支付密钥。

## 13. 部署方案

### 13.1 MVP 部署拓扑

| 组件 | 部署方式 |
| --- | --- |
| Web | Node 服务或托管前端平台 |
| API | Docker 容器 |
| Worker | Docker 容器，可水平扩展 |
| PostgreSQL | 托管数据库或独立容器 |
| Redis | 托管 Redis 或独立容器 |
| 对象存储 | 云厂商对象存储 |
| CDN | 云厂商 CDN |

### 13.2 本地开发

本地开发建议使用 Docker Compose 启动依赖：

1. PostgreSQL。
2. Redis。
3. 对象存储模拟服务，可选。
4. API。
5. Worker。
6. Web。

### 13.3 生产建议

1. Web、API、Worker 分开部署。
2. Worker 按队列压力水平扩容。
3. 数据库开启自动备份。
4. Redis 开启持久化或使用托管服务。
5. 对象存储开启生命周期策略，清理软删除和过期文件。
6. 所有服务接入日志采集和告警。

## 14. 可观测性

### 14.1 日志

必须记录：

1. 请求 ID。
2. 用户 ID。
3. 任务 ID。
4. 订单 ID。
5. 模型供应商请求 ID。
6. 错误码。
7. 耗时。

禁止记录：

1. 用户密码。
2. 支付密钥。
3. 模型 API Key。
4. 完整支付敏感字段。

### 14.2 指标

| 指标 | 说明 |
| --- | --- |
| `generation_task_created_total` | 创建任务数 |
| `generation_task_succeeded_total` | 成功任务数 |
| `generation_task_failed_total` | 失败任务数 |
| `generation_task_duration_seconds` | 生成耗时 |
| `generation_queue_wait_seconds` | 队列等待时长 |
| `credit_spent_total` | 积分消耗 |
| `credit_refunded_total` | 积分退款 |
| `payment_success_total` | 支付成功数 |
| `payment_webhook_failed_total` | 支付回调失败数 |

### 14.3 告警

建议告警条件：

1. 生成成功率低于阈值。
2. Worker 队列堆积超过阈值。
3. 支付回调连续失败。
4. 任务失败后退款补偿失败。
5. 对象存储上传失败率异常。
6. 数据库连接数或慢查询异常。

## 15. 测试策略

### 15.1 后端测试

| 类型 | 覆盖范围 |
| --- | --- |
| 单元测试 | 积分计算、参数校验、状态流转、适配器逻辑 |
| 集成测试 | 任务创建事务、积分扣减退款、订单支付回调 |
| E2E 测试 | 注册登录、创建任务、查询结果、下载图片 |

重点测试用例：

1. 余额不足不能创建任务。
2. 创建任务成功后扣积分并写流水。
3. 模型失败后只退款一次。
4. 支付回调重复发送不会重复发积分。
5. 普通用户不能访问他人图片。
6. 普通用户不能访问后台接口。
7. 内容违规不进入模型生成。

### 15.2 前端测试

| 类型 | 覆盖范围 |
| --- | --- |
| 组件测试 | 生成表单、图片网格、套餐卡片、后台表格 |
| 页面测试 | 生成页、历史页、价格页、账户页 |
| E2E 测试 | 登录、生成、轮询、下载、购买流程 |

### 15.3 质量门禁

建议每次合并前执行：

```bash
npm run lint
npm run types
npm test
npm run build
```

TypeScript 要开启 `strict`。公共 API 和跨包类型必须显式定义，不要靠 `any` 装睡。

## 16. MVP 开发拆分

### 16.1 第一阶段：基础工程和账户

交付内容：

1. Monorepo 初始化。
2. Web、API、Worker 基础应用。
3. PostgreSQL、Redis 本地开发环境。
4. Prisma 数据模型和迁移。
5. 注册、登录、退出、当前用户接口。
6. 基础页面框架。

验收：

1. 用户可注册登录。
2. API、Web、Worker 可本地启动。
3. 数据库迁移可重复执行。

### 16.2 第二阶段：生成闭环

交付内容：

1. 生成表单。
2. 积分预估。
3. 任务创建。
4. 队列投递。
5. Worker 调用模型适配器。
6. 图片上传对象存储。
7. 任务状态查询。
8. 图片结果展示和下载。

验收：

1. 用户能完成一次完整图片生成。
2. 任务状态可从 `PENDING` 到 `SUCCEEDED`。
3. 失败任务有错误提示。

### 16.3 第三阶段：积分、历史和图片管理

交付内容：

1. 积分账户。
2. 积分流水。
3. 失败退款。
4. 历史记录。
5. 收藏、删除、再次生成。

验收：

1. 积分扣减和退款准确。
2. 用户只能看自己的历史。
3. 图片管理操作可用。

### 16.4 第四阶段：支付和后台

交付内容：

1. 套餐管理。
2. 创建订单。
3. 支付适配器。
4. 支付回调幂等。
5. 后台用户、任务、图片、订单列表。
6. 管理员操作日志。

验收：

1. 支付成功后积分到账。
2. 重复回调不重复发放。
3. 管理后台可追踪核心数据。

### 16.5 第五阶段：安全、稳定性和发布

交付内容：

1. 内容审核。
2. 限流。
3. 日志和告警。
4. 数据备份。
5. 生产部署配置。
6. E2E 回归测试。

验收：

1. 违规内容被拦截。
2. 关键异常可定位。
3. 生产环境可稳定运行核心流程。

## 17. 错误码设计

| 错误码 | HTTP 状态 | 说明 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 参数校验失败 |
| `UNAUTHENTICATED` | 401 | 未登录 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `INSUFFICIENT_CREDITS` | 409 | 积分余额不足 |
| `CONTENT_BLOCKED` | 422 | 内容安全拦截 |
| `TASK_NOT_RETRYABLE` | 409 | 任务不可重试 |
| `PAYMENT_SIGNATURE_INVALID` | 400 | 支付签名无效 |
| `PAYMENT_EVENT_DUPLICATED` | 200 | 支付事件已处理 |
| `AI_PROVIDER_FAILED` | 502 | 模型供应商失败 |
| `STORAGE_UPLOAD_FAILED` | 502 | 对象存储上传失败 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |
| `INTERNAL_ERROR` | 500 | 系统内部错误 |

## 18. 关键业务一致性要求

### 18.1 创建任务与扣积分

必须在同一个数据库事务中完成：

1. 锁定用户积分账户。
2. 检查余额。
3. 创建任务。
4. 扣减余额。
5. 写入积分流水。

事务成功后再投递队列。如果队列投递失败，任务应标记为 `FAILED` 或由补偿扫描重新投递，不能让用户积分扣了但任务永远没人处理。

### 18.2 失败退款

退款必须满足：

1. 任务状态为失败类状态。
2. 存在扣费流水。
3. 不存在同一任务的退款流水。
4. 使用幂等键防止重复退款。

### 18.3 支付发放

支付成功发放权益必须满足：

1. 回调签名有效。
2. 订单金额和币种匹配。
3. 订单未发放过权益。
4. 支付事件未处理过。
5. 订单状态、积分账户、积分流水在同一事务内更新。

## 19. 后续扩展方案

### 19.1 图生图

新增能力：

1. 参考图上传。
2. 参考图审核。
3. 图片影响强度参数。
4. 上传图片对象存储。
5. 模型适配器扩展 `referenceImageUrl`。

### 19.2 局部重绘

新增能力：

1. 前端画笔和蒙版编辑。
2. 蒙版图片上传。
3. 重绘参数。
4. 对应模型适配器。

### 19.3 批量生成

新增能力：

1. 批量任务表。
2. 子任务拆分。
3. 批量进度统计。
4. 批量下载压缩包。

### 19.4 API 开放平台

新增能力：

1. API Key 管理。
2. 调用额度。
3. 签名认证。
4. 调用日志。
5. 独立限流规则。

## 20. 技术风险与对策

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 模型供应商不稳定 | 生成失败率高、耗时波动 | 适配器隔离，多供应商备用，失败重试 |
| 成本失控 | 用户大量生成导致模型费用过高 | 积分预扣、限流、套餐成本核算、异常告警 |
| 队列堆积 | 用户等待时间过长 | Worker 扩容、并发限制、队列告警 |
| 支付重复回调 | 重复发放积分 | 支付事件幂等、唯一索引、事务 |
| 用户越权 | 访问他人图片或订单 | 所有查询带 `user_id` 过滤，后台单独权限 |
| 图片存储费用上涨 | 历史图片越来越多 | 缩略图、生命周期策略、软删除清理 |
| 内容违规 | 平台合规风险 | 文本审核、图片审核、人工处理、审计日志 |
| 技术范围膨胀 | MVP 久久不能上线 | 严格按 P0 闭环推进，P1/P2 延后 |

## 21. 发布前检查清单

1. 注册、登录、退出流程通过。
2. 创建生成任务、扣积分、投递队列通过。
3. Worker 可生成图片并保存到对象存储。
4. 任务状态轮询正常。
5. 图片预览和下载正常。
6. 历史记录只展示当前用户数据。
7. 积分流水准确。
8. 模型失败可退款。
9. 支付回调幂等。
10. 管理后台权限有效。
11. 内容安全拦截有效。
12. 生产环境密钥未泄露到前端。
13. 日志能关联请求、用户、任务和订单。
14. 数据库迁移已执行。
15. 基础 E2E 测试通过。

## 22. 结论

Imagora 的技术实现应围绕“异步生成任务 + 积分账本 + 可替换供应商 + 私有图片权限”四个核心点展开。首版不要贪多，先把生成闭环、积分一致性、图片管理、支付发放和后台追踪做稳。只要这几块稳住，后面加图生图、局部重绘、模板市场和 API 平台都有清晰扩展路径；如果这几块没稳，功能再多也只是把坑挖得更宽。
