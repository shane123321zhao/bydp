#!/usr/bin/env bash
# 测试站换用测试 Bot（PO #22）：在开发机执行。读本机 .env.local 的 STAGING_TG_BOT_TOKEN / STAGING_TG_BOT_USERNAME，
# 用 getMe 校验后写入测试站 ~/bydp/deploy/.env.prod.input 的 STAGING_TELEGRAM_BOT_TOKEN / _USERNAME，下次 deploy.sh staging 生效。
#   bash scripts/staging-bot.sh            # 校验并写入测试站
#   bash scripts/staging-bot.sh --check    # 只校验本机 .env.local，不动服务器
# 令牌只经标准输入传给 curl 与 ssh，不进命令行参数、不打印。
set -uo pipefail
cd "$(dirname "$0")/.."
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; exit 1; }
val() { { grep -E "^$1=" .env.local || true; } | tail -1 | cut -d= -f2- | tr -d "\"' \r"; }
T=$(val STAGING_TG_BOT_TOKEN); U=$(val STAGING_TG_BOT_USERNAME); U=${U#@}
[[ "$T" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]] || fail ".env.local 的 STAGING_TG_BOT_TOKEN 未填或格式不对（应为 数字:字母串）"
[ "$T" != "$(val TELEGRAM_BOT_TOKEN)" ] || fail "STAGING_TG_BOT_TOKEN 与正式 Bot（TELEGRAM_BOT_TOKEN）相同，须是新建的测试 Bot"
ME=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$T" | curl -s --max-time 15 -K - || true)
GOT=$(printf '%s' "$ME" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["result"]; print(r["username"], r.get("can_join_groups")) if d.get("ok") else None' 2>/dev/null)
[ -n "$GOT" ] || fail "STAGING_TG_BOT_TOKEN 无效（getMe 失败）"
[ -z "$U" ] || [ "${GOT% *}" = "$U" ] || fail "令牌对应 @${GOT% *}，与 STAGING_TG_BOT_USERNAME=$U 不符"
U=${GOT% *}
pass "测试 Bot 令牌有效，对应 @$U"
[ "${GOT#* }" = False ] && pass "测试 Bot 已关闭拉群" || echo "⚠️ 提醒 ｜ @$U 还能被拉进群：@BotFather → /setjoingroups → 选 @$U → Disable"
[ "${1:-}" = --check ] && exit 0
# D-030：服务器地址与 SSH 密钥路径不写死——取环境变量，未设置时读仓库根目录 .env.local（都不是密钥）
localcfg() { [ -n "${!1:-}" ] && { printf '%s' "${!1}"; return; }; { grep -E "^$1=" "$(dirname "$0")/../.env.local" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | tr -d "\"'\r"; }
KEY=$(localcfg BYDP_STAGING_SSH_KEY); HOST=$(localcfg BYDP_STAGING_HOST)
[ -n "$KEY" ] && [ -n "$HOST" ] || fail "未配置 BYDP_STAGING_HOST / BYDP_STAGING_SSH_KEY（环境变量或 .env.local）"
printf 'STAGING_TELEGRAM_BOT_TOKEN=%s\nSTAGING_TELEGRAM_BOT_USERNAME=%s\n' "$T" "$U" | ssh -p 2222 -i "${KEY/#\~/$HOME}" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST" \
  'cd ~/bydp/deploy && umask 077 && { grep -vE "^STAGING_TELEGRAM_BOT_(TOKEN|USERNAME)=" .env.prod.input; cat; } > .env.prod.input.new && mv .env.prod.input.new .env.prod.input && chmod 600 .env.prod.input' \
  || fail "写入测试站失败（SSH 2222 / 密钥）"
unset T ME
pass "已写入测试站 .env.prod.input；下一步 bash scripts/deploy.sh staging 生效（之后测试站登录与推送改走 @$U）"
