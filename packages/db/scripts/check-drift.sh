#!/usr/bin/env bash
# schema（TS）与 migrations/ 一致性：在临时副本上跑 drizzle-kit generate，若产生新迁移（或需交互确认重命名）即判定漂移。
# 防止「schema 先行、迁移未生成」导致 seed / 运行时插入不存在的列（2026-09-28 A-007 事故）。
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d ./.drift-XXXX)
trap 'rm -rf "$TMP"' EXIT
cp -R migrations "$TMP/m"
cat > "$TMP/c.ts" <<CFG
import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './src/schema/index.ts', out: '$TMP/m' });
CFG
# drizzle-kit 遇到需交互的重命名时会打印错误但仍以 0 退出——只以「No schema changes」为通过依据，其余一律判漂移
out=$(pnpm -s exec drizzle-kit generate --config "$TMP/c.ts" --name drift </dev/null 2>&1 || true)
if ! grep -q "No schema changes" <<<"$out"; then
  echo "schema 漂移：src/schema 有改动未生成迁移（新增迁移须双签，见 rules/db-migration.md）" >&2
  grep -E "Error|TTY|migration file" <<<"$out" | head -3 >&2
  exit 1
fi
echo "schema 与迁移一致"
