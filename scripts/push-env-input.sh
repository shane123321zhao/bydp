#!/usr/bin/env bash
# 上传正式配置（PO #23 · go-live.md ③）：在开发机执行，把 PO 填好的 ~/bydp-keys/prod.env.input 校验后上传到正式机 ~/bydp/deploy/.env.prod.input（600）。
#   bash scripts/push-env-input.sh --host <正式机 IP> [--file ~/bydp-keys/prod.env.input]
# - 只校验「是否已填 / 格式是否对」，不打印任何值；内容经 SSH 标准输入传输，不出现在命令行参数里；
# - 上传后由 deploy.sh prod 合并进 .env.prod（deploy.sh 永不覆盖服务器上的 .env.prod.input）；
# - 每项一行「✅ 通过 ｜ …」或「❌ 失败 ｜ …」，有失败即退出、不上传。
set -uo pipefail
HOST=""; FILE="$HOME/bydp-keys/prod.env.input"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=${2:?}; shift ;;
    --file) FILE=${2:?}; shift ;;
    --check-only) HOST=-; ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
  shift
done
FAILS=0
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; FAILS=$((FAILS + 1)); }
[ -n "$HOST" ] || { echo "用法：$0 --host <正式机 IP> [--file 路径]（或 --check-only 只校验不上传）"; exit 2; }
[ "$HOST" = - ] || [[ "$HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "❌ 失败 ｜ --host 须为 IPv4 地址"; exit 2; }
[ -r "$FILE" ] || { echo "❌ 失败 ｜ 找不到 $FILE（先把 docs/ops/prod.env.input.template 复制过去并填写）"; exit 1; }
val() { { grep -E "^$1=" "$FILE" || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' | tr -d '\r'; }

REQ="SITE_DOMAIN ADMIN_HOST BYDP_BEHIND_CLOUDFLARE TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME ADMIN_TELEGRAM_BOT_TOKEN ADMIN_TELEGRAM_BOT_USERNAME RESEND_API_KEY EMAIL_FROM R2_BUCKET_EVIDENCE R2_BUCKET_BACKUP R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD"
MISSING=""
for k in $REQ; do [ -n "$(val "$k")" ] || MISSING="$MISSING $k"; done
[ -z "$MISSING" ] && pass "必填项已全部填写（$(echo $REQ | wc -w | tr -d ' ') 项，值不显示）" || fail "未填：$MISSING"

host_re='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
[[ "$(val SITE_DOMAIN)" =~ $host_re ]] && pass "SITE_DOMAIN 格式正确（$(val SITE_DOMAIN)）" || fail "SITE_DOMAIN 须为小写域名、不带 https://"
[[ "$(val ADMIN_HOST)" =~ $host_re ]] && [ "$(val ADMIN_HOST)" != "$(val SITE_DOMAIN)" ] && pass "ADMIN_HOST 格式正确（$(val ADMIN_HOST)）" || fail "ADMIN_HOST 须为与主站不同的子域名"
[ "$(val BYDP_BEHIND_CLOUDFLARE)" = 1 ] && pass "BYDP_BEHIND_CLOUDFLARE=1" || fail "正式站须 BYDP_BEHIND_CLOUDFLARE=1"
case "$(val SITE_DOMAIN)" in staging.*) fail "SITE_DOMAIN 是测试站域名" ;; esac
grep -qE '^(BYDP_DEV_SESSION|STAGING_[A-Z_]+)=' "$FILE" && fail "正式配置里不得出现 BYDP_DEV_SESSION / STAGING_* 键"

tok_re='^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$'
for p in TELEGRAM ADMIN_TELEGRAM; do
  t=$(val ${p}_BOT_TOKEN); u=$(val ${p}_BOT_USERNAME)
  if [[ "$t" =~ $tok_re ]]; then
    # getMe 校验令牌与用户名对得上；令牌只经 curl 配置的标准输入传入，不进命令行参数
    me=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$t" | curl -s --max-time 15 -K - || true)
    got=$(printf '%s' "$me" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"]["username"] if d.get("ok") else "")' 2>/dev/null)
    [ -n "$got" ] && [ "$got" = "$u" ] && pass "${p}_BOT_TOKEN 有效，对应 @$got" || fail "${p}_BOT_TOKEN 无效或与用户名 ${u:-（空）} 不符"
  else fail "${p}_BOT_TOKEN 格式不对（应为 数字:字母串）"; fi
done
unset t me
[ -n "$(val TELEGRAM_BOT_TOKEN)" ] && [ "$(val TELEGRAM_BOT_TOKEN)" = "$(val ADMIN_TELEGRAM_BOT_TOKEN)" ] && fail "前台与后台 Bot 不能是同一个（一个 Bot 只能绑一个域名）"

[[ "$(val RESEND_API_KEY)" =~ ^re_[A-Za-z0-9_]{20,}$ ]] && pass "RESEND_API_KEY 格式正确" || fail "RESEND_API_KEY 格式不对（应以 re_ 开头）"
[[ "$(val R2_ENDPOINT)" =~ ^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com$ ]] && pass "R2_ENDPOINT 格式正确" || fail "R2_ENDPOINT 应形如 https://<32位账户ID>.r2.cloudflarestorage.com"
EB=$(val R2_BUCKET_EVIDENCE); BB=$(val R2_BUCKET_BACKUP)
if [ "$EB" = bydp-evidence ] || [ "$BB" = bydp-backup ] || [ "$EB" = "$BB" ]; then fail "正式站须用自己的两个桶（不能与测试站 bydp-evidence / bydp-backup 共用，也不能同一个桶）"
else pass "R2 桶：证据 $EB · 备份 $BB"; fi
[ -n "$(val R2_ACCESS_KEY_ID)" ] && [ "$(val R2_ACCESS_KEY_ID)" = "$(val R2_BACKUP_ACCESS_KEY_ID)" ] && fail "备份令牌不得与证据令牌相同（go-live.md「备份」第 2 步）"
[[ "$(val BACKUP_AGE_RECIPIENT)" =~ ^age1[0-9a-z]{58}$ ]] && pass "BACKUP_AGE_RECIPIENT 是 age 公钥" || fail "BACKUP_AGE_RECIPIENT 应为 age1 开头的公钥（不是 AGE-SECRET-KEY 私钥）"
grep -q 'AGE-SECRET-KEY' "$FILE" && fail "文件里出现了 age 私钥（AGE-SECRET-KEY），立即删掉那一行；私钥不放服务器"
[[ "$(val CF_ACCESS_TEAM_DOMAIN)" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] && pass "CF_ACCESS_TEAM_DOMAIN 格式正确" || fail "CF_ACCESS_TEAM_DOMAIN 应形如 <团队名>.cloudflareaccess.com"
[[ "$(val CF_ACCESS_AUD)" =~ ^[0-9a-f]{64}$ ]] && pass "CF_ACCESS_AUD 格式正确" || fail "CF_ACCESS_AUD 应为 64 位十六进制"

[ "$FAILS" -eq 0 ] || { echo "—— $FAILS 项失败，未上传；改好后重跑"; exit 1; }
[ "$HOST" = - ] && { echo "—— 校验全部通过（--check-only，未上传）"; exit 0; }
# D-030：服务器地址与 SSH 密钥路径不写死——取环境变量，未设置时读仓库根目录 .env.local（都不是密钥）
localcfg() { [ -n "${!1:-}" ] && { printf '%s' "${!1}"; return; }; { grep -E "^$1=" "$(dirname "$0")/../.env.local" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | tr -d "\"'\r"; }
KEY=$(localcfg BYDP_PROD_SSH_KEY); KEY=${KEY:-$HOME/.ssh/bydp-prod.pem}; KEY=${KEY/#\~/$HOME}
[ -r "$KEY" ] || { echo "❌ 失败 ｜ 缺 SSH 私钥 $KEY（BYDP_PROD_SSH_KEY）"; exit 1; }
N=$(ssh -p 2222 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST" \
  'umask 077 && mkdir -p ~/bydp/deploy && cat > ~/bydp/deploy/.env.prod.input.new && mv ~/bydp/deploy/.env.prod.input.new ~/bydp/deploy/.env.prod.input && chmod 600 ~/bydp/deploy/.env.prod.input && grep -cE "^[A-Z0-9_]+=" ~/bydp/deploy/.env.prod.input' \
  < "$FILE" 2>/dev/null) || { echo "❌ 失败 ｜ 上传到 $HOST 失败（SSH 2222 / 密钥）"; exit 1; }
pass "已上传到正式机 $HOST:~/bydp/deploy/.env.prod.input（$N 项，600 权限）"
echo "—— 下一步：bash scripts/deploy.sh prod --host $HOST"
