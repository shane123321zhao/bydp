#!/usr/bin/env bash
# 上线一条命令自检（D-020 #6 · HANDOVER §9）：在**正式服务器** ~/bydp 内执行 `bash scripts/go-live-check.sh`。
# 每项一行「✅ 通过 ｜ …」或「❌ 失败 ｜ …」，有失败退出码 1。只看状态码 / 计数，不打印任何密钥。
# 覆盖：服务健康 · DNS / 证书 / Cloudflare / Access / 源站防火墙（复用 cf-ready-check）· IMDSv2 · 正式库数据守卫 · 备份 · 告警通道 · 可收录 / 无 Basic Auth · canonical 指向正式域名。
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/deploy" || { echo "❌ 失败 ｜ 未在代码目录"; exit 1; }
FAILS=0
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; FAILS=$((FAILS + 1)); }
val() { { grep -E "^$1=" .env.prod || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
DC="docker compose -f compose.prod.yml --env-file .env.prod"
docker info >/dev/null 2>&1 || DC="sudo $DC"

[ "$(val BYDP_ENV)" = production ] && pass "BYDP_ENV=production" || fail "BYDP_ENV 不是 production（本脚本只用于正式环境）"
DOMAIN=$(val AUTH_URL | sed 's#^https://##'); ADMIN=$(val ADMIN_HOST)

# ① 服务健康
W=$($DC ps --format '{{.Service}}={{.Health}}' web admin api auth-admin 2>/dev/null | tr '\n' ' ')
[ "$(grep -o '=healthy' <<<"$W" | wc -l)" -ge 4 ] && pass "服务健康：$W" || fail "服务未全部健康：$W"

# ② IMDSv2：不带令牌的元数据请求必须被拒（401）；同时取公网 IP 给 ③ 用
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://169.254.169.254/latest/meta-data/ || true)
case "$c" in 401) pass "IMDSv2：不带令牌的元数据请求被拒（仅 v2）" ;; 200) fail "IMDS 仍接受 v1（无令牌可读）：AWS 控制台把元数据改为「仅 IMDSv2」" ;; *) fail "IMDS 检查失败（HTTP ${c:-无响应}）" ;; esac
TOKEN=$(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' --max-time 3 http://169.254.169.254/latest/api/token || true)
ORIGIN=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 || true)
unset TOKEN

# ③ DNS / 证书 / Cloudflare / Access / 源站防火墙 / Caddy（cf-ready-check）
if [ -n "$DOMAIN" ] && [[ "$ORIGIN" =~ ^[0-9.]+$ ]]; then
  OUT=$(bash "$ROOT/scripts/cf-ready-check.sh" "$DOMAIN" "$ORIGIN" ${ADMIN:+--admin "$ADMIN"} --server 2>&1)
  printf '%s\n' "$OUT" | grep -E '^(✅|❌)'
  FAILS=$((FAILS + $(printf '%s\n' "$OUT" | grep -c '^❌')))
else
  fail "取不到域名或源站公网 IP，跳过 Cloudflare 自检"
fi

# ④ 正式库数据守卫（无演示 / 测试站数据、角色齐全）
G=$($DC run --rm --no-deps migrate ./node_modules/.bin/tsx scripts/seed-prod.ts 2>/dev/null | grep -E '^(✅|❌)')
printf '%s\n' "$G"
FAILS=$((FAILS + $(printf '%s\n' "$G" | grep -c '^❌')))
[ -n "$G" ] || fail "数据守卫未能运行"

# ⑤ 备份：已配置加密公钥 + 定时任务 + 26 小时内有成功备份
[[ "$(val BACKUP_AGE_RECIPIENT)" =~ ^age1 ]] && pass "备份加密公钥已配置" || fail "未配置 BACKUP_AGE_RECIPIENT（go-live.md「备份」第 1 步）"
crontab -l 2>/dev/null | grep -q 'deploy/backup.sh' && pass "备份定时任务已安装" || fail "未安装备份定时任务（见 deploy/backup.sh 头部）"
LAST=$($DC exec -T redis redis-cli GET bydp:backup:last 2>/dev/null | tr -dc '0-9')
if [ -n "$LAST" ] && [ $(( $(date -u +%s) - LAST )) -lt $((26 * 3600)) ]; then pass "最近一次成功备份在 $(( ($(date -u +%s) - LAST) / 3600 )) 小时前"
else fail "26 小时内没有成功备份（首次上线可先手动跑一次：bash deploy/backup.sh）"; fi

# ⑥ 告警通道：Bot 令牌 + 至少 1 个 admin 绑定 TG（只计数不发送）
A=$($DC exec -T worker ./node_modules/.bin/tsx src/cli/alert.ts --check 2>/dev/null | tail -1)
if echo "$A" | grep -q '"botToken":true' && ! echo "$A" | grep -q '"adminTelegram":0'; then pass "告警通道：Bot 已配置，$(echo "$A" | sed -E 's/.*"adminTelegram":([0-9]+).*/\1/') 个管理员可收 TG 告警（须已对机器人发过 /start）"
else fail "告警通道不完整（$A）：需 Bot 令牌且至少 1 个 admin 用 Telegram 登录过"; fi

# ⑦ 正式站可收录、不再有 Basic Auth
R=$(curl -s --max-time 15 "https://$DOMAIN/robots.txt" | tr -d '\r')
if printf '%s\n' "$R" | grep -qxi 'Allow: /' && ! printf '%s\n' "$R" | grep -qxi 'Disallow: /'; then pass "robots 允许收录"
else fail "robots 未允许收录：$(printf '%s' "$R" | tr '\n' ' ')"; fi
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/")
[ "$c" != 401 ] && pass "主站无 Basic Auth（HTTP $c）" || fail "主站仍要求 Basic Auth：须以 bootstrap --prod 部署"
# W3#074 补充：canonical 指向正式主站域名（AUTH_URL 错填 / 未内联时会落到 localhost 或测试站，搜索收录随之出错）
CAN=$(curl -s --max-time 15 "https://$DOMAIN/" | grep -oE '<link rel="canonical" href="[^"]+"' | head -1 | sed -E 's/.*href="([^"]+)"/\1/')
[ "${CAN%/}" = "https://$DOMAIN" ] && pass "首页 canonical 指向正式主站（$CAN）" || fail "首页 canonical 不是 https://$DOMAIN（实际：${CAN:-无}）：检查 .env.prod 的 AUTH_URL 后重新部署（构建期内联）"

[ "$FAILS" -eq 0 ] && echo "—— 上线自检全部通过" || { echo "—— $FAILS 项失败"; exit 1; }
