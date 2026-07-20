# Imagora

AI 图片生成平台。基于多 Provider 架构，支持图片生成、积分管理、订单支付、安全审核等完整业务流程。

## 这是什么

Imagora 是一个**面向 C 端付费用户的 AI 出图 SaaS**，完整实现了"注册 → 充值 → 消耗积分出图 → 管理"的商业闭环：

- **用户侧**：邮箱注册并验证 → 购买套餐充值积分 → 用积分提交出图任务（文生图 / 图生图）→ 查看历史、收藏、下载。
- **运营侧**：管理后台管理套餐定价、审核内容、处理申诉、订单对账与退款、查看运营指标与告警。
- **平台方（部署者）**：持有全局密钥（OpenAI / 存储 / 支付 / 邮件 / 安全审核），承担出图成本，靠用户充值覆盖。

整个系统围绕**积分（credits）**运转：出图前先扣积分，任务失败自动退还，充值通过套餐订单 + 支付回调发放。所有积分变动走一张带幂等键的流水账（ledger），可追溯、防重复发放。

> 面向普通用户的部署里，**用户不接触任何 API 密钥**——密钥是平台方的，藏在服务端。只有 clone 本仓库自建部署的人，才需要配置自己的密钥（见「环境变量」与「生产部署」）。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16 + React 19 + Tailwind CSS + Lucide Icons |
| 后端 | Fastify 5 + Zod + Pino |
| Worker | Node.js 异步任务消费 |
| 数据库 | PostgreSQL 16 + Prisma ORM |
| 缓存/队列 | Redis 7 |
| 存储 | 可切换（内联 / S3 兼容） |
| AI | 可切换（Mock / OpenAI，默认模型 `openai:gpt-image-2`） |
| 支付 | 可切换（Mock / Stripe） |
| 安全审核 | 可切换（本地规则 / 外部服务） |
| 容器化 | Docker Compose |

## 项目结构

```
imagora/
├── apps/
│   ├── api/           # REST API 服务（Fastify）
│   ├── web/           # 前端应用（Next.js）
│   └── worker/        # 后台任务消费（图片生成）
├── packages/
│   ├── shared/        # 公共类型、工具函数
│   ├── database/      # Prisma schema 与数据访问层
│   ├── ai-providers/  # AI 图片生成 Provider 抽象
│   ├── storage/       # 对象存储 Provider 抽象
│   ├── payments/      # 支付 Provider 抽象
│   ├── safety/        # 内容安全审核 Provider 抽象
│   └── queue/         # 任务队列抽象
├── infra/             # Docker Compose、Dockerfile、运维脚本
├── tests/             # 集成测试
└── .env.example       # 环境变量模板
```

## 快速开始

### 环境要求

- **必需**：Node.js >= 22、npm（自带 workspaces）
- **可选**：PostgreSQL 16、Redis 7 —— 本地开发默认用 JSON 文件存储 + 内存队列，**不装这两个也能跑**（见下方说明）

### 本地开发（零外部依赖，最快上手）

clone 下来 `npm install` 后即可运行，无需 Postgres、Redis 或任何真实密钥：

```bash
# 1. 克隆仓库
git clone https://github.com/CHEN-YH99/Imagora.git
cd Imagora

# 2. 安装依赖（workspaces 单体仓，根目录一次装全部子包）
npm install

# 3. 构建内部依赖包（shared/database 等是 api/web 的依赖，先编译一次）
npm run build:packages

# 4. 生成环境变量文件
cp .env.example .env
# 直接用默认值即可跑通全链路（见下方“默认能跑到什么程度”）

# 5. 分别在三个终端启动三个服务
npm run dev:api       # API 服务   -> http://127.0.0.1:4100
npm run dev:web       # 前端        -> http://127.0.0.1:3100
npm run dev:worker    # Worker 任务消费（出图靠它）
```

打开 http://127.0.0.1:3100，用内置管理员账号登录：

- 邮箱：`admin@imagora.local`
- 密码：`ChangeMe123!`

> dev 脚本会自动跑 `infra/scripts/dev-preflight.mjs`，清理 Windows 上残留的端口占用和 Prisma 临时文件，无需手动处理。

### 默认能跑到什么程度

`.env.example` 的默认值全部走本地兜底，clone 后开箱可用：

| 能力 | 默认表现 |
|---|---|
| 数据存储 | JSON 文件（`data/imagora-store.json`），不需要 Postgres。即便 `DATA_STORE=prisma`，开发环境下 Prisma 连不上也会自动回退 JSON store |
| 任务队列 | 内存内联（`QUEUE_PROVIDER=inline`），不需要 Redis |
| 图片存储 | base64 内联（`STORAGE_PROVIDER=inline`），不落磁盘 |
| 出图 | 不填 `OPENAI_API_KEY` 时自动走 `mock`，返回占位图；填了真 key 才出真图 |
| 支付 | `mock`，模拟下单，不真实收费 |
| 邮件 | 验证码/邮件直接打印到控制台，不真发信 |
| 安全审核 | `local`，本地关键词 + 图片格式校验 |
| 验证码 | `builtin`，内置 SVG 点选 |

也就是说：**只想在本地把整套流程点一遍（注册、出图、积分、订单、后台）——什么密钥都不用配。** 只有想出真图，才需要在 `.env` 填 `OPENAI_API_KEY`。

### 用 Postgres + Redis 跑（可选，贴近生产形态）

想在本地验证 Prisma/BullMQ 真实链路时，先起数据库和 Redis：

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis
```

然后在 `.env` 中设置 `DATA_STORE=prisma`、`QUEUE_PROVIDER=bullmq`，并确保 `DATABASE_URL`、`REDIS_URL` 指向上面起的服务。

### Docker Compose 一键启动（开发形态全套）

```bash
docker compose -f infra/docker-compose.yml up -d
```

启动后访问：
- 前端：http://127.0.0.1:3100
- API：http://127.0.0.1:4100

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动前端开发服务 |
| `npm run dev:api` | 启动 API 开发服务 |
| `npm run dev:worker` | 启动 Worker 开发服务 |
| `npm run build` | 构建全部 |
| `npm run typecheck` | 全量类型检查 |
| `npm run test` | 运行集成测试 |
| `npm run lint` | ESLint 检查 |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm run format` | Prettier 格式化 |
| `npm run format:check` | Prettier 检查 |
| `npm run smoke` | 冒烟测试 |
| `npm run p0:check` | P0 生产就绪检查 |
| `npm run start` | 生产模式启动前端 |
| `npm run start:api` | 生产模式启动 API |
| `npm run start:worker` | 生产模式启动 Worker |

## 环境变量

完整变量见 `.env.example`，核心配置说明：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `API_PORT` | API 服务端口 | `4100` |
| `WEB_ORIGIN` | 前端地址 | `http://127.0.0.1:3100` |
| `DATABASE_URL` | PostgreSQL 连接串 | - |
| `REDIS_URL` | Redis 连接串 | - |
| `IMAGE_PROVIDER_DEFAULT` | 默认图片 Provider（`mock` / `openai`） | 自动：有 `OPENAI_API_KEY` 则 `openai`，否则 `mock` |
| `IMAGE_MODEL_DEFAULT` | 默认图片模型（如 `openai:gpt-image-2`） | Provider 内置默认 |
| `OPENAI_API_KEY` | OpenAI API Key | - |
| `STORAGE_PROVIDER` | 存储 Provider（`inline` / `filesystem` / `s3` / `r2`） | `inline` |
| `PAYMENT_PROVIDER` | 支付 Provider（`mock` / `stripe`） | `mock` |
| `DATA_STORE` | 数据存储方式（非 `prisma` 即走 JSON 文件） | `prisma`（开发环境连不上会自动回退 JSON） |
| `QUEUE_PROVIDER` | 队列 Provider（`inline` / `bullmq`） | `inline` |
| `SAFETY_PROVIDER` | 安全审核 Provider（`local` / `http`） | `local` |
| `CAPTCHA_PROVIDER` | 验证码 Provider（`builtin` / `turnstile`） | `builtin` |

兼容说明：旧字段 `AI_PROVIDER`、`OPENAI_IMAGE_MODEL` 仍可识别，但新配置统一建议使用 `IMAGE_PROVIDER_DEFAULT`、`IMAGE_MODEL_DEFAULT`。本地开发如果只填写 `OPENAI_API_KEY`，系统会自动切到 `openai`；不填则默认走 `mock`。

## 架构设计

### 多 Provider 模式

核心业务模块均采用 Provider 抽象，通过环境变量切换实现：

- **AI Provider**：`mock`（开发用）/ `openai`（生产用），模型通过 `IMAGE_MODEL_DEFAULT` 选择；如果未显式指定 Provider，本地会在检测到 `OPENAI_API_KEY` 时自动切到 `openai`
- **Storage Provider**：`inline`（本地文件）/ `s3`、`r2`（S3 兼容存储）
- **Payment Provider**：`mock`（模拟支付）/ `stripe`（Stripe 真实支付）
- **Queue Provider**：`inline`（内存队列）/ `bullmq`（Redis 队列）
- **Mailer Provider**：`console`（开发输出）/ `smtp`（真实邮件投递）
- **Safety Provider**：`local`（本地规则）/ `http`（第三方审核服务）

### 请求流程

```
用户 -> Web (Next.js) -> API (Fastify)
                          ├── 验证 & 限流
                          ├── 创建生成任务 -> Queue
                          └── 返回任务 ID

Worker <- Queue 消费任务
  ├── Safety 审核
  ├── AI Provider 生成图片
  ├── Storage 上传存储
  └── 更新任务状态

用户 -> Web 轮询任务状态 -> 获取结果
```

### 前端页面

| 路径 | 功能 |
|---|---|
| `/` | 首页 |
| `/generate` | 图片生成 |
| `/history` | 生成历史 |
| `/favorites` | 收藏夹 |
| `/pricing` | 套餐定价 |
| `/orders` | 订单管理 |
| `/account` | 账户设置 |
| `/admin` | 管理后台 |
| `/login` | 登录 |
| `/register` | 注册 |

## 核心概念

理解这几个领域概念，才能看懂业务流转：

| 概念 | 说明 |
|---|---|
| **积分 Credits** | 平台内的消费货币。每个用户一个积分账户（余额 / 累计获得 / 累计消耗）。出图消耗、充值发放、失败退还都作用于它。 |
| **积分流水 Ledger** | 每一笔积分变动（`GRANT` 发放 / `SPEND` 消费 / `REFUND` 退还 / `EXPIRE` 过期 / `ADJUST` 调整）都记一条带**唯一幂等键**的流水，防止重复扣费或重复发放。 |
| **套餐 Plan** | 充值商品，定义价格、货币、发放积分数、有效期。管理后台维护。 |
| **订单 Order** | 用户购买套餐产生的订单，状态机 `PENDING → PAID / CANCELED / REFUNDED / CLOSED`。价格以服务端套餐快照为准，不信任前端传值。 |
| **支付事件 PaymentEvent** | 支付 Provider 回调（webhook）落库的原始事件，按 `(provider, providerEventId)` 唯一，校验金额后通过 `order-grant:{orderId}` 幂等发放积分。 |
| **生成任务 Task** | 一次出图请求，状态机 `PENDING → RUNNING → SUCCEEDED / FAILED / CANCELED / BLOCKED`。创建时校验积分、安全、幂等（`clientRequestId`），由 worker 消费；失败通过 `task-refund:{taskId}` 幂等退款一次。 |
| **安全审核 Safety** | 提示词与上传图片先过审核，结果 `PASSED / BLOCKED / REVIEW_REQUIRED`。命中拦截返回 `CONTENT_BLOCKED`，用户可发起申诉（Appeal）走人工复核。 |

### 出图积分链路（一次典型流程）

```
提交任务 → 校验(功能开关/登录/安全/积分余额/幂等) → 扣积分(SPEND) → 入队
   worker 消费 → Safety 审核 → AI 出图 → 存储落库 → 标记 SUCCEEDED
   若失败 → 标记 FAILED → 退还积分(REFUND，幂等一次)
```

## 数据模型

完整定义见 [`packages/database/prisma/schema.prisma`](packages/database/prisma/schema.prisma)。核心表：

| 分组 | 表 |
|---|---|
| 账号 | `User`、`Session`、`EmailVerificationToken`、`PasswordResetToken` |
| 积分 | `UserCreditAccount`、`CreditLedgerEntry` |
| 出图 | `GenerationTask`、`GeneratedImage`、`ReferenceImage`、`ImageProject`、`ImageFavorite` |
| 交易 | `Plan`、`Order`、`PaymentEvent` |
| 安全 | `SafetyEvent`、`SafetyAppeal`、`SafetyRule` |
| 运维 | `AdminAuditLog`、`OperationalIncident`、`AlertNotification` |

## 延伸文档

代码里已有一套完整的维护与运维文档，按需查阅：

| 文档 | 内容 |
|---|---|
| [`docs/maintenance/00-项目总览.md`](docs/maintenance/00-项目总览.md) | 代码分层、模块责任、推荐阅读顺序 |
| [`docs/maintenance/01`~`07`](docs/maintenance/) | 本地启动、认证、出图主链路、积分支付、存储预览、后台安全、问题排查 |
| [`docs/maintenance/generated/`](docs/maintenance/generated/) | 自动生成地图：API 路由、Web 页面、包结构、环境变量（`npm run docs:maintenance` 更新） |
| [`infra/README.md`](infra/README.md) | API 契约、错误码表、告警阈值、回滚与事故处置 runbook |
| [`docs/生产部署与验证手册.md`](docs/生产部署与验证手册.md) | Docker Compose 生产形态部署与验证流程 |

## 生产部署

### 构建镜像

```bash
docker compose -f infra/docker-compose.prod.yml build
```

### 生产环境变量

生产部署时需要配置：

- 从 `.env.production.example` 复制到部署平台的环境变量/Secret 管理处，并替换所有示例值；不要把真实密钥写回仓库。
- `DATABASE_URL`：指向生产 PostgreSQL
- `REDIS_URL`：指向生产 Redis
- `IMAGE_PROVIDER_DEFAULT=openai` + `OPENAI_API_KEY`
- 可选：`IMAGE_MODEL_DEFAULT=openai:gpt-image-2`
- `STORAGE_PROVIDER=s3` 或 `STORAGE_PROVIDER=r2` + S3 兼容存储配置
- `PAYMENT_PROVIDER=stripe` + Stripe 相关配置
- `MAILER_PROVIDER=smtp` + `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`
- `SAFETY_PROVIDER=http` + `SAFETY_TEXT_ENDPOINT` / `SAFETY_IMAGE_ENDPOINT`
- `SESSION_COOKIE_SECURE=true`

### P0 生产就绪检查

仓库内 P0 收口命令：

```bash
npm run p0:check
```

它会强制执行生产配置、构建产物、备份恢复和灰度清单检查。真实 OpenAI、S3/R2、Stripe、SMTP、第三方安全审核必须在灰度环境拿真实账号与密钥再做 smoke，不能用本地 mock 结果冒充。

最终灰度签收使用强制外部验收入口：

```bash
npm run p0:check:external
```

这个命令要求 `P0_EXTERNAL_SMOKE_PASSED=1` 且 `P0_EXTERNAL_SMOKE_EVIDENCE` 指向灰度 smoke/load 运行记录。

## 测试

```bash
# 运行集成测试（需要先构建 packages 和 apps）
npm run test

# 冒烟测试
npm run smoke
```

## License

Private
