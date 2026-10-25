# ADR-0005 技术栈确认

- 日期：2026-09-23 · 状态：已采纳 · 裁定：PO
- 关联：架构 §16；HANDOVER 第 7 节；审计 B1–B9

## 决策
以架构 §16 表为准。审计新增并确认的选型：
- 对外 API：Hono + `@hono/zod-openapi`；契约格式 OpenAPI 3.1 + zod（设计阶段 API 契约交付物按此格式）。不选 tRPC：postback、TG、B2B 均为对外 REST。
- ORM：Drizzle。理由：SQL 透明、迁移文件可逐行审计、递归 CTE 直接写；取舍：生态小于 Prisma，Prisma 抽象层更易被 AI 会话改坏。
- 身份：Auth.js（TG Login Widget + 邮箱 magic link）。不用 SaaS 身份服务：博彩相关条款与数据出境风险。
- 领域层：`packages/core` 承载全部业务用例，web/admin/api 为薄壳。
- 队列消费者独立为 `apps/worker`。
- Next.js 多实例配置 Redis cache handler。
- Meilisearch 索引与查询均经 OpenCC 归一到简体。
- 仿冒匹配：pg_trgm + entity-graph 内的规范化层（punycode、homoglyph、字母数字替换）。
- 可观测与备份：Sentry + OpenTelemetry；Postgres 每日异地备份至 R2；敏感字段加密。
- 部署：Docker Compose / IaC，至少两家托管商可切换，选择前核对 AUP。

## 后果
目录骨架增 `apps/worker`、`packages/core`、`packages/agents`；设计阶段 API 契约用 OpenAPI 3.1。
