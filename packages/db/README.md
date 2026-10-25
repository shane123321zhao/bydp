# packages/db

Drizzle schema 与 migrations — 已应用迁移禁改；新增迁移需审核会话签核（双签，`mailbox/.approvals/db`）

- `src/schema/`：架构 v1.3 §7 七域 42 实体（`operator` `trust` `commerce` `user` `guarantee` `content` `governance`）；表名 snake_case、字段 camelCase。
- `migrations/`：0000 pg_trgm · 0001 表 DDL（drizzle 生成）· 0002 只追加 / 服务端时间戳 / 身份列不可改 / 状态留痕触发器 + `bydp_app`、`bydp_scoring_ro` 授权。**唯一真源**；`sql/` 草案已迁入并删除（见 `sql/README.md`）。
- 已知边界：表 owner 可 `DISABLE TRIGGER` / 删改绑定——只由迁移审查防护；生产应用一律以 `bydp_app` 连接。
- `src/seed/`：fixtures → seed（纯函数 `buildSeed`，缺陷行跳过并列明，不占位）。

```bash
pnpm db:generate            # 生成迁移（需 .approvals/db）
pnpm db:migrate             # drizzle-kit migrate
pnpm db:seed                # 空库灌 fixtures
pnpm db:seed:check          # 各表 count(*) 对比 fixtures 条数
DATABASE_URL=... pnpm --filter @bydp/db test   # 守卫集成测试（只追加 / boundAt / scoring_ro 隔离）
```

无 Docker 时可用 `scripts/dev-db.sh`（Postgres.app initdb 起临时实例）做本地验证。

### 迁移 0005 注意（A-007 R3）
`conversion` 新增的 `externalEventId` / `operatorAccountIdHash` 为 NOT NULL 且无默认值：只能在 conversion 为空的库上执行。已有转化数据的库须先补数据迁移再应用，否则 0005 失败。
