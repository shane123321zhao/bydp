# BYDP 博弈点评

面向东南亚华语用户的博彩平台信任与查验站：存钱前先查一下。
核心功能——**查验**（网址 / TG / 收款地址 → 五态判定：认证 · 观察 · 黑名单 · 仿冒 · 未收录）、**品牌页与评分**（出款、仲裁、硬指标、玩家评价、稳定性五因子，算法版本化）、**投诉与仲裁**（证据哈希只追加、答辩期、曝光与脱敏公开）、**优惠与真实价值换算**（按条款打满流水后的期望净值）、**用户提交**（出款凭证、评价，后台审核）、**隐私与自我排除**、运营**后台**（RBAC + 审计日志）、Telegram Bot。

> 不向中国大陆居民提供服务。

## 技术栈

pnpm workspace + Turborepo · Node.js ≥ 22 · TypeScript · Next.js（web / admin）· Hono + OpenAPI（api）· BullMQ（worker）· grammY（tg-bot）· Drizzle ORM + PostgreSQL 16 · Redis · Meilisearch · Auth.js（Telegram / 邮箱 magic link）· Vitest · Playwright · Caddy（自动 HTTPS）· Docker Compose 部署。

## 目录结构

```
apps/
  web/        用户站点（H5 / PWA，Next.js）
  admin/      运营后台（Next.js，basePath /admin）
  api/        对外接口（Hono + OpenAPI，/v1、/admin/v1）
  worker/     后台任务（评分、通知推送、搜索索引、维护任务、运维 CLI）
  tg-bot/     Telegram Bot（webhook）
packages/
  core/          领域用例（apps 只是薄壳）
  db/            Drizzle schema、迁移、seed、数据库守卫测试
  scoring/       评分与排序（只读数据库角色）
  tracking/      点击 / 转化 / 佣金归因
  entity-graph/  标识规范化、形近识别、判定
  agents/        采集 / 监控 / 本地化等 Agent 的提议结构
  i18n/          多语言文案
deploy/       Dockerfile、compose、Caddy、bootstrap / backup 脚本、部署手册
scripts/      CI、部署、UAT、恢复演练等脚本
docs/         架构、ADR、设计规范与字段映射、接口契约、运维文档
e2e/          测试站全链路验收（Playwright）
```

## 本地启动

```bash
pnpm i
cp .env.example .env.local        # 按注释填写本地开发所需项（本地可用随机值）
docker compose up -d              # Postgres 16 / Redis / Meilisearch
pnpm db:migrate && pnpm db:seed   # 建表 + 基础数据（可再 pnpm db:seed:demo 灌演示数据）
pnpm dev                          # 启动各应用（web 默认 http://localhost:3100）
```

## 测试与检查

```bash
pnpm run ci        # 全量：lint · typecheck · 依赖边界 · 临时 PG16 上迁移 + seed + 全部测试 · web 冒烟
pnpm test          # 只跑单元 / 集成测试（需 DATABASE_URL）
pnpm deps:check    # 包依赖边界（scoring 不得依赖 tracking 等）
```

测试站全链路验收：`bash scripts/uat.sh`（需要测试站与 `.env.local` 中的 UAT 配置，见 `.env.example`）。

## 部署

从零部署到一台新服务器：见 **[deploy/README.md](deploy/README.md)**（先决条件 → 外部账号与 DNS → 填配置 → `scripts/deploy.sh` → 第一个管理员 → 备份）。
正式上线的额外前置（Cloudflare、后台 Access、源站防火墙、备份硬化、回滚）：见 [docs/ops/go-live.md](docs/ops/go-live.md)、[docs/ops/cloudflare-access.md](docs/ops/cloudflare-access.md)。

品牌资料：用 `docs/ops/brand-import-template.xlsx` 填写，`pnpm db:import:brands <文件> --requested-by <管理员 userId> --dry-run` 预检后导入；优惠的真实价值由系统按 [architecture §8.1](docs/architecture-v1.md) 计算。

## 环境变量（只列键名，值不入库）

| 位置 | 键 |
|---|---|
| 本地开发 `.env.local`（模板 `.env.example`） | `DATABASE_URL` `DATABASE_URL_SCORING_RO` `REDIS_URL` `MEILI_URL` `MEILI_MASTER_KEY` `S3_*` `BINDING_HMAC_KEY` `AUTH_SECRET` `AUTH_URL` `IDENTITY_HMAC_KEY` `AUTH_PII_KEY` `TELEGRAM_BOT_TOKEN` `RESEND_API_KEY` `EMAIL_FROM` 等；运维脚本：`BYDP_STAGING_HOST` `BYDP_STAGING_SSH_KEY` `BYDP_PROD_SSH_KEY`；UAT：`STAGING_GATE_TOKEN` `UAT_IMAP_USER` `UAT_IMAP_APP_PASSWORD` |
| 服务器 `deploy/.env.prod.input`（模板 `deploy/env.prod.input.example`，部署者填写） | `SITE_DOMAIN` `TELEGRAM_BOT_TOKEN` `TELEGRAM_BOT_USERNAME` `RESEND_API_KEY` `EMAIL_FROM` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_ENDPOINT` `R2_BUCKET_EVIDENCE` `R2_BUCKET_BACKUP` `BACKUP_AGE_RECIPIENT` `ADMIN_HOST` `CF_ACCESS_TEAM_DOMAIN` `CF_ACCESS_AUD` 等 |
| 服务器 `deploy/.env.prod`（`bootstrap.sh` 首次运行随机生成，600，不打印） | 数据库各角色密码、`AUTH_SECRET`、`IDENTITY_HMAC_KEY`、`AUTH_PII_KEY`、`BINDING_HMAC_KEY`、`MEILI_MASTER_KEY`、`TG_WEBHOOK_SECRET`、测试站门禁 `STAGING_GATE_PASSWORD` / `STAGING_GATE_TOKEN` 等 |

密钥（token / key / secret / 私钥）一律只放上述不入库的文件或服务器环境变量，不进代码与仓库。

## 文档

- 架构：[docs/architecture-v1.md](docs/architecture-v1.md) · 决策记录：[docs/adr/](docs/adr/)
- 设计规范：[docs/design/design-system.md](docs/design/design-system.md) · 字段映射：[docs/design/field-mapping.md](docs/design/field-mapping.md) · 接口契约：[docs/design/api-contract.yaml](docs/design/api-contract.yaml)
- 运维：[deploy/README.md](deploy/README.md) · [docs/ops/](docs/ops/)
