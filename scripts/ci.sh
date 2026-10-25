#!/usr/bin/env bash
# 本地 CI（D-003 M1 首项；repo 暂无远程）。用法：pnpm run ci
# 1) lint / typecheck / deps:check  2) 临时 PG16：正式迁移 → seed → seed:check  3) 全部测试（含 DB 通用断言）
# 通用断言（A-001 签核条件 3）：createdAt INSERT+UPDATE 触发器全覆盖、scoring 白名单 = ADR-0006 清单 15 张
#   —— 位于 packages/db/test/guards.test.ts，需要 DATABASE_URL，故必须经本脚本跑，不能跳过。
set -euo pipefail
cd "$(dirname "$0")/.."
# 0/4 双签闸门（工具无关）：常态由 .githooks/pre-commit 在提交时强制；CI 抽查模式 CI_CHECK_APPROVALS=1 时复核最近一次提交（签核文件用完即删，故默认不在 CI 复核）
[ "$(git config core.hooksPath)" = ".githooks" ] || { echo "CI FAIL: core.hooksPath 未设为 .githooks（双签闸门被关闭）。执行: git config core.hooksPath .githooks"; exit 1; }
rm -f packages/scoring/src/__isolation_probe__.ts  # 上次中断残留的隔离探针，避免 deps:check 误报
if [ "${CI_CHECK_APPROVALS:-0}" = "1" ]; then bash .claude/hooks/approvals-check.sh head || { echo "CI FAIL: 双签闸门"; exit 1; }; fi
PGBIN=${PGBIN:-/Applications/Postgres.app/Contents/Versions/16/bin}
PORT=${CI_PG_PORT:-55499}
DATA=$(mktemp -d /tmp/bydp-ci-XXXX)
cleanup() { DATA="$DATA" PGBIN="$PGBIN" bash packages/db/scripts/dev-db.sh stop 2>/dev/null || true; rm -rf "$DATA"; }
trap cleanup EXIT

echo "== 1/4 lint · typecheck · deps:check"
pnpm -s turbo run lint typecheck --output-logs=errors-only
pnpm -s deps:check
node scripts/check-ranking-isolation.mjs
bash packages/db/scripts/check-drift.sh
bash scripts/test-deploy-config.sh   # D-020 #31：部署配置开关（AOP 片段）

echo "== 2/4 临时 PG16（$PORT）：migrate → seed → seed:check"
export DATABASE_URL
DATABASE_URL=$(DATA="$DATA" PORT="$PORT" PGBIN="$PGBIN" bash packages/db/scripts/dev-db.sh start)
pnpm -s db:migrate >/dev/null
# bydp_scoring_ro 为 LOGIN 无密码角色（密码带外设置）；临时库上设测试密码供 scoring / worker 测试
"$PGBIN/psql" "$DATABASE_URL" -qc "ALTER ROLE bydp_scoring_ro PASSWORD 'ci'"
export DATABASE_URL_SCORING_RO="postgres://bydp_scoring_ro:ci@localhost:$PORT/bydp"
# D-020 #5（§9 #12）：bydp_app 登录身份测试组（packages/core/test/app-role.test.ts）——临时库设测试密码，真实以 bydp_app 连接
"$PGBIN/psql" "$DATABASE_URL" -qc "ALTER ROLE bydp_app PASSWORD 'ci'"
export DATABASE_URL_APP="postgres://bydp_app:ci@localhost:$PORT/bydp"
# A-011：绑定账号加密密钥——CI 固定用 seed 测试密钥（与 packages/db/src/seed/build.ts SEED_PII_KEY 相同），seed 与测试可互解；绝不用真实密钥
export AUTH_PII_KEY="$(printf 'bydp-seed-only-pii-key-not-prod!' | base64)"
pnpm -s db:seed >/dev/null
pnpm -s db:seed:check

# Redis 联调（apps/worker/test/redis.test.ts）：本机 6379 可达（docker compose up -d redis）时启用，否则明示跳过
if [ -z "${REDIS_URL:-}" ] && (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null; then export REDIS_URL=redis://localhost:6379; fi
if [ -n "${REDIS_URL:-}" ]; then echo "   Redis 联调：已启用（$REDIS_URL）"; else echo "   Redis 联调：跳过（6379 不可达；docker compose up -d redis 后重跑）"; fi

echo "== 3/4 test（DATABASE_URL 已注入，DB 通用断言不会被跳过）"
# 各包 DB 测试共用同一临时库：串行执行，避免跨包事务互相加锁形成死锁（D-016 起 Agent 测试加入后出现过一次 40P01）
BYDP_CI=1 pnpm -s turbo run test --output-logs=errors-only --force --concurrency=1
echo "== 3b 演示数据（seed:demo）→ scoring 重算 = fixtures 快照（方案 A 核对）"
pnpm -s db:seed:demo >/dev/null
pnpm -s demo:verify

echo "== 4/4 web：生产构建 + 冒烟（五个查验用例、SEO、大陆 451）"
pnpm -s --filter @bydp/web build >/dev/null
# A-009：Auth.js 路由冒烟需要 AUTH_SECRET；CI 用一次性随机值（非真实密钥，不落盘）
AUTH_SECRET=$(openssl rand -base64 32) pnpm -s --filter @bydp/web smoke
echo "CI OK"
