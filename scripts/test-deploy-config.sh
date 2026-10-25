#!/usr/bin/env bash
# 部署配置开关的单元测试（CI 调用；不需要 Docker）：覆盖 D-020 #31 AOP 片段生成（deploy/gen-aop.sh）、PO #22 测试站 Bot 覆盖（bootstrap 片段）、正式配置校验（push-env-input.sh）。
set -uo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
n=0; bad=0
check() { n=$((n + 1)); if eval "$2"; then :; else echo "FAIL: $1"; bad=$((bad + 1)); fi; }

# 关：片段为空定义、无 client_auth；即使没有 CA 文件也成功
bash deploy/gen-aop.sh 0 "$T/none.pem" "$T/off.caddy" >/dev/null 2>&1; rc=$?
check "AOP 关 → 成功" '[ $rc -eq 0 ]'
check "AOP 关 → 定义空片段" 'grep -q "^(env_tls) {" "$T/off.caddy" && ! grep -q client_auth "$T/off.caddy"'
bash deploy/gen-aop.sh "" "$T/none.pem" "$T/off2.caddy" >/dev/null 2>&1
check "AOP 未设 → 视为关" '! grep -q client_auth "$T/off2.caddy"'

# 开 + 缺证书 / 空文件 / 非法内容 → 失败（失败即关）
bash deploy/gen-aop.sh 1 "$T/none.pem" "$T/x.caddy" >/dev/null 2>&1; rc=$?
check "AOP 开 + 缺 CA → 失败" '[ $rc -ne 0 ]'
: > "$T/empty.pem"; bash deploy/gen-aop.sh 1 "$T/empty.pem" "$T/x.caddy" >/dev/null 2>&1; rc=$?
check "AOP 开 + 空 CA → 失败" '[ $rc -ne 0 ]'
echo "not a cert" > "$T/junk.pem"; bash deploy/gen-aop.sh 1 "$T/junk.pem" "$T/x.caddy" >/dev/null 2>&1; rc=$?
check "AOP 开 + 非法 CA → 失败" '[ $rc -ne 0 ]'

# 开 + 合法 CA → require_and_verify 且信任该 CA 文件
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=test-ca" -keyout "$T/ca.key" -out "$T/ca.pem" >/dev/null 2>&1
bash deploy/gen-aop.sh 1 "$T/ca.pem" "$T/on.caddy" >/dev/null 2>&1; rc=$?
check "AOP 开 + 合法 CA → 成功" '[ $rc -eq 0 ]'
check "AOP 开 → require_and_verify + 指向 /etc/caddy/aop-ca.pem" 'grep -q "mode require_and_verify" "$T/on.caddy" && grep -q "pem_file /etc/caddy/aop-ca.pem" "$T/on.caddy"'

# Caddyfile 与后台模板都引入了片段
check "主站与后台站点都 import env_tls" 'grep -q "import aop.caddy" deploy/Caddyfile && grep -c "import env_tls" deploy/Caddyfile | grep -q 1 && grep -q "import env_tls" deploy/admin-host.caddy.tpl'

# PO #22：测试站 Bot 覆盖（抽出 bootstrap 中对应片段单独执行）
sed -n '/^# PO #22：测试站专用 Bot/,/^unset ST_TOKEN/p' deploy/bootstrap.sh > "$T/stbot.sh"
stbot() { # $1=PROD $2=额外输入行
  ( cd "$T" && printf 'TELEGRAM_BOT_TOKEN=111:old\nTELEGRAM_BOT_USERNAME=BYDP_001_bot\n%b' "$2" > .env.prod.input \
    && printf 'X=1\nTELEGRAM_BOT_TOKEN=111:old\nTELEGRAM_BOT_USERNAME=BYDP_001_bot\n' > .env.prod.tmp \
    && PROD=$1 && fail() { exit 1; } && . ./stbot.sh && sort .env.prod.tmp | tr '\n' ' ' )
}
o=$(stbot 0 ''); check "测试 Bot 未配置 → 维持原 Bot" '[ "$o" = "TELEGRAM_BOT_TOKEN=111:old TELEGRAM_BOT_USERNAME=BYDP_001_bot X=1 " ]'
o=$(stbot 0 'STAGING_TELEGRAM_BOT_TOKEN=222:new\nSTAGING_TELEGRAM_BOT_USERNAME=@BYDP_test_bot\n'); check "测试站配置测试 Bot → 覆盖令牌与用户名" '[ "$o" = "TELEGRAM_BOT_TOKEN=222:new TELEGRAM_BOT_USERNAME=BYDP_test_bot X=1 " ]'
stbot 1 'STAGING_TELEGRAM_BOT_TOKEN=222:new\nSTAGING_TELEGRAM_BOT_USERNAME=x\n' >/dev/null; rc=$?; check "正式环境配置测试 Bot → 拒绝" '[ $rc -ne 0 ]'
stbot 0 'STAGING_TELEGRAM_BOT_TOKEN=222:new\n' >/dev/null; rc=$?; check "测试 Bot 缺用户名 → 拒绝" '[ $rc -ne 0 ]'

# 正式配置校验：空模板不上传；出现私钥 / 测试站键即失败（均在联网校验前判定）
bash scripts/push-env-input.sh --check-only --file docs/ops/prod.env.input.template >/dev/null 2>&1; rc=$?
check "正式配置空模板 → 校验失败" '[ $rc -ne 0 ]'
{ cat docs/ops/prod.env.input.template; echo "AGE-SECRET-KEY-1XXXX"; echo "STAGING_TELEGRAM_BOT_TOKEN=1"; } > "$T/bad.input"
o=$(bash scripts/push-env-input.sh --check-only --file "$T/bad.input" 2>&1)
check "正式配置含私钥 / STAGING_* → 逐项报错" 'grep -q "AGE-SECRET-KEY" <<<"$o" && grep -q "STAGING_\*" <<<"$o"'

[ $bad -eq 0 ] && echo "部署配置测试 $n 项通过" || { echo "部署配置测试 $bad/$n 项失败"; exit 1; }
