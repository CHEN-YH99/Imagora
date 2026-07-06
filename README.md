# Imagora

AI 图片生成平台。基于多 Provider 架构，支持图片生成、积分管理、订单支付、安全审核等完整业务流程。

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

- Node.js >= 22
- PostgreSQL 16
- Redis 7
- npm (workspaces)

### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/CHEN-YH99/Imagora.git
cd Imagora

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入实际配置

# 4. 启动基础服务（PostgreSQL + Redis）
docker compose -f infra/docker-compose.yml up -d postgres redis

# 5. 启动开发服务
npm run dev:api       # API 服务 -> http://127.0.0.1:4100
npm run dev:worker    # Worker 任务消费
npm run dev:web       # 前端 -> http://127.0.0.1:3100
```

### Docker Compose 一键启动

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
| `STORAGE_PROVIDER` | 存储 Provider（`inline` / `s3` / `r2`） | `inline` |
| `PAYMENT_PROVIDER` | 支付 Provider（`mock` / `stripe`） | `mock` |
| `DATA_STORE` | 数据存储方式（`json` / `prisma`） | `json` |
| `QUEUE_PROVIDER` | 队列 Provider（`inline` / `bullmq`） | `inline` |
| `MAILER_PROVIDER` | 邮件 Provider（`console` / `smtp`） | `console` |
| `SAFETY_PROVIDER` | 安全审核 Provider（`local` / `http`） | `local` |

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

## 生产部署

### 构建镜像

```bash
docker compose -f infra/docker-compose.prod.yml build
```

### 生产环境变量

生产部署时需要配置：

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

## 测试

```bash
# 运行集成测试（需要先构建 packages 和 apps）
npm run test

# 冒烟测试
npm run smoke
```

## License

Private
