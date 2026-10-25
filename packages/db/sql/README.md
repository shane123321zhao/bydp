# packages/db/sql — 已迁入、禁改

A-001 审核草案已于 2026-09-26 逐字迁入迁移（签核对象 commit 95a6e3f）：

| 草案 | 迁移 |
|---|---|
| `00_extensions.sql` | `migrations/0000_extensions.sql` |
| `10_append_only.sql` + `20_roles.sql` | `migrations/0002_guards_roles.sql` |

唯一真源是 `migrations/`。已应用迁移禁改；新增守卫 / 授权一律写新迁移（双签），并在新迁移里重跑 createdAt 触发器循环、同步 GRANT（rules/db-migration.md）。
逐字核对：`cmp migrations/0002_guards_roles.sql <(git show 95a6e3f:packages/db/sql/10_append_only.sql; git show 95a6e3f:packages/db/sql/20_roles.sql)`
