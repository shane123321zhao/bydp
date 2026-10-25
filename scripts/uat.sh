#!/usr/bin/env bash
# D-022 测试站全链路验收（UAT）：在开发机执行 `bash scripts/uat.sh`。
# ① 真浏览器（Playwright · 桌面 1280 + 手机 390）按用户视角跑 e2e/uat/*.spec.ts；
# ② 服务器内直连检查（外部无法伪造的部分）：大陆 CF-IPCountry: CN → 451 文案。
# 每项一行「✅ 通过 ｜ … / ❌ 失败 ｜ …（截图路径）」；失败截图在 e2e/.out/。门禁 Cookie（STAGING_GATE_TOKEN）从 .env.local 读取，只传给子进程、不打印。
#   bash scripts/uat.sh [--grep 关键字]     # 只跑标题匹配的用例（排查用；放行以全量为准）
set -uo pipefail
cd "$(dirname "$0")/.."
FAILS=0
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; FAILS=$((FAILS + 1)); }
val() { { grep -E "^$1=" .env.local || true; } | tail -1 | cut -d= -f2- | tr -d "\"'\r"; }
# D-030：测试站地址与 SSH 密钥路径取自 .env.local（BYDP_STAGING_HOST / BYDP_STAGING_SSH_KEY），不写死
HOST=$(val BYDP_STAGING_HOST); KEY=$(val BYDP_STAGING_SSH_KEY); KEY=${KEY/#\~/$HOME}
[ -n "$HOST" ] && [ -r "$KEY" ] || { echo "❌ 失败 ｜ .env.local 未配置 BYDP_STAGING_HOST / BYDP_STAGING_SSH_KEY"; exit 2; }
echo "== 测试站 UAT · 部署版本 $(ssh -p 2222 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 ubuntu@$HOST 'cat ~/bydp/DEPLOYED_SHA 2>/dev/null' 2>/dev/null || echo 未知) · $(date -u +%FT%TZ)"

# ① 浏览器旅程
rm -rf e2e/.out
# 本次运行编号：测试账号（专用 Gmail 的 +uat<编号>… 别名）与 UAT 测试品牌都按它新建，互不影响
RUN=$(date -u +%y%m%d%H%M)
echo "== 运行编号 $RUN（测试账号 +uat$RUN…；凭据从 .env.local 读取，不打印）"
UAT_SSH_HOST=$HOST UAT_SSH_KEY=$KEY UAT_RUN=$RUN UAT_IMAP_USER=$(val UAT_IMAP_USER) UAT_IMAP_APP_PASSWORD=$(val UAT_IMAP_APP_PASSWORD) \
UAT_GATE_TOKEN=$(val STAGING_GATE_TOKEN) \
  pnpm exec playwright test -c e2e/playwright.config.ts "$@"
[ $? -eq 0 ] || FAILS=$((FAILS + 1))

# 收回本次授予测试账号的后台角色（admin / arbitrator），不留可用的测试管理员
if [ -s e2e/.out/granted.txt ]; then
  while read -r uid role; do
    [[ "$uid" =~ ^u_[A-Za-z0-9_]+$ && "$role" =~ ^(admin|arbitrator)$ ]] || continue
    ssh -n -p 2222 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 ubuntu@$HOST \
      "cd ~/bydp/deploy && sudo docker compose -f compose.prod.yml --env-file .env.prod run --rm --no-deps migrate ./node_modules/.bin/tsx scripts/grant-role.ts $uid $role --revoke" >/dev/null 2>&1 \
      && pass "已收回测试账号 ${uid:0:10}… 的 $role" || fail "收回测试账号 ${uid:0:10}… 的 $role 失败（须手动收回）"
  done < e2e/.out/granted.txt
fi

# W2#011：驳回本轮测试账号仍待审的出款凭证 / 评价（走正常判定路径、留审计），后台「提交审核」列表不随每轮累积
C=$(ssh -n -p 2222 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 ubuntu@$HOST \
  "cd ~/bydp/deploy && sudo docker compose -f compose.prod.yml --env-file .env.prod exec -T worker ./node_modules/.bin/tsx src/cli/uat-cleanup.ts --run $RUN" 2>/dev/null | tail -1)
[[ "$C" == UAT\ 清理* && "$C" != *失败* ]] && pass "$C" || fail "UAT 清理未完成：${C:-无输出}"

# ② 服务器内：大陆请求 451（测试站不在 Cloudflare 后，外部伪造的国家头会被 Caddy 丢弃，只能在容器内直连 web 验证）
R=$(ssh -p 2222 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 ubuntu@$HOST \
  "cd ~/bydp/deploy && sudo docker compose -f compose.prod.yml --env-file .env.prod exec -T web node -e \"Promise.all(['/brand/jinlong','/check/jinlong88.com','/en/certified','/regions'].map(p=>fetch('http://127.0.0.1:3100'+p,{headers:{'CF-IPCountry':'CN'}}).then(async r=>p+'='+r.status+(/不在服务范围内/.test(await r.text())?'+文案':'')))).then(a=>console.log(a.join(' ')))\"" 2>/dev/null)
if [[ "$R" == *"/brand/jinlong=451+文案"* && "$R" == *"/check/jinlong88.com=451+文案"* && "$R" == *"/en/certified=451"* && "$R" == *"/regions=200"* ]]; then pass "旅程 12 · 大陆请求 451 并显示不在服务范围文案；/regions 声明页可达（$R）"
else fail "旅程 12 · 大陆 451 检查不符：${R:-无输出}"; fi

[ "$FAILS" -eq 0 ] && echo "—— UAT 全部通过" || { echo "—— UAT 有失败（截图见 e2e/.out/）"; exit 1; }
