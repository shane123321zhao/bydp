#!/usr/bin/env bash
# BYDP 测试环境一键部署（D-009）。在服务器上、代码目录 ~/bydp 内执行：bash deploy/bootstrap.sh
# 每步输出「✅ 通过 ｜ 摘要」或「❌ 失败 ｜ 摘要」，失败即停；不需要任何手工输入。可重复执行（幂等）。
# 前置：deploy/.env.prod.input（TELEGRAM_BOT_TOKEN / RESEND_API_KEY / EMAIL_FROM / TELEGRAM_BOT_USERNAME / SITE_DOMAIN），
#       由开发会话经 SSH 上传（600），或 PO 按 README 填写。其余密钥本脚本首次运行时随机生成，写入 deploy/.env.prod（600），不打印。
# D-020 #4：bash deploy/bootstrap.sh --prod = 正式环境（BYDP_ENV=production、无门禁、可收录、只跑 seed:prod 数据守卫、
#           必须配置后台独立子域 ADMIN_HOST、拒绝 BYDP_DEV_SESSION）；不带参数 = 测试站（演示数据 + Cookie 门禁 + noindex）。
# W2#010：测试站门禁由 Basic Auth 改为口令页 + Cookie（Basic Auth 下 React 偶发 #418）；正式站禁止启用 Basic Auth。
set -uo pipefail
cd "$(dirname "$0")"
# 模式必须明确（自检 I5）：--prod / --staging；不带参数仅在已有 .env.prod 为测试站时沿用，新机器漏写参数直接拒绝（避免正式机灌入演示数据）
case "${1:-}" in
  --prod) PROD=1 ;;
  --staging) PROD=0 ;;
  "") if grep -qE '^BYDP_ENV=staging$' .env.prod 2>/dev/null; then PROD=0; else echo "❌ 失败 ｜ 新机器须明确模式：bash deploy/bootstrap.sh --staging 或 --prod"; exit 1; fi ;;
  *) echo "❌ 失败 ｜ 未知参数 $1（只接受 --staging / --prod）"; exit 1 ;;
esac
MODE=$([ $PROD = 1 ] && echo production || echo staging)
DC="docker compose -f compose.prod.yml --env-file .env.prod"
step() { printf '\n== %s\n' "$1"; }
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; exit 1; }
rnd() { openssl rand -base64 32 | tr -d '\n'; }
rndpw() { openssl rand -hex 24; }

# 本机验证用：BYDP_BOOTSTRAP_LOCALTEST=1 跳过第 1–3 步（Linux 主机操作），只跑容器编排部分
if [ "${BYDP_BOOTSTRAP_LOCALTEST:-0}" != "1" ]; then
step "1/8 预检（系统 / 内存 / 磁盘）"
. /etc/os-release
MEM_GB=$(awk '/MemTotal/{printf "%.1f", $2/1048576}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
# 重复部署时磁盘多被 Docker 构建缓存占用：不足 20GB 先清构建缓存与悬空镜像（不动数据卷）再判断
if [ "${DISK_GB:-0}" -lt 20 ] && command -v docker >/dev/null 2>&1; then
  docker builder prune -af >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
fi
SUM="$PRETTY_NAME · 内存 ${MEM_GB}GB · 可用磁盘 ${DISK_GB}GB"
awk "BEGIN{exit !($MEM_GB >= 3.5)}" || fail "$SUM（内存需 ≥ 4GB，请在 AWS 控制台改实例类型）"
[ "${DISK_GB:-0}" -ge 20 ] || fail "$SUM（可用磁盘需 ≥ 20GB）"
pass "$SUM"

step "2/8 Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq ca-certificates curl gnupg >/dev/null || fail "apt 安装依赖失败"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg || fail "下载 Docker 官方签名失败"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null || fail "安装 Docker 失败"
  sudo usermod -aG docker "$USER"
fi
if ! docker info >/dev/null 2>&1; then DC="sudo $DC"; fi
# D-020 #7：备份加密工具 age 在此预装（backup.sh 由 cron 运行，只检查不安装）
command -v age >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age >/dev/null 2>&1 || fail "安装 age 失败"
pass "$(docker --version 2>/dev/null | cut -d, -f1) · $($DC version --short 2>/dev/null | sed 's/^/compose /')"

step "3/8 防火墙与 SSH 加固（只开 22 / 2222 / 80 / 443；禁止密码与 root 登录）"
# 2222：PO 所在网络经代理只能走非 22 端口（审核 SSH 替代方案）；先放行再启用，避免把自己锁在外面
sudo ufw allow 22/tcp >/dev/null && sudo ufw allow 2222/tcp >/dev/null && sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443/tcp >/dev/null && sudo ufw --force enable >/dev/null || fail "ufw 设置失败"
SSHD=$(sudo sshd -T 2>/dev/null)
echo "$SSHD" | grep -qx 'passwordauthentication no' || fail "sshd 允许密码登录（须 PasswordAuthentication no，见 README 顶部命令）"
echo "$SSHD" | grep -qx 'permitrootlogin no' || fail "sshd 允许 root 登录（须 PermitRootLogin no）"
pass "$(sudo ufw status | grep -cE 'ALLOW') 条放行规则（22/2222/80/443，含 IPv6）· sshd 仅密钥登录、禁 root"
else
  docker info >/dev/null 2>&1 || fail "本机 Docker 不可用"
  printf '\n== 1–3/8 跳过（BYDP_BOOTSTRAP_LOCALTEST=1）\n'
fi

step "4/8 环境变量（.env.prod，600，密钥不打印）"
[ -f .env.prod.input ] || fail "缺少 deploy/.env.prod.input（TG token / Resend key 等），模板见 deploy/env.prod.input.example"
umask 077
# 正式环境不得混入开发会话（X-Dev-User）开关
if [ $PROD = 1 ] && grep -qE '^BYDP_DEV_SESSION=.+' .env.prod.input .env.prod 2>/dev/null; then fail "正式环境不得设置 BYDP_DEV_SESSION（HANDOVER §9 #9）"; fi
if [ -f .env.prod ] && ! grep -qE "^BYDP_ENV=$MODE$" .env.prod; then fail "已有 .env.prod 的 BYDP_ENV 与本次模式（$MODE）不一致：测试站与正式环境不得共用一套配置"; fi
if [ ! -f .env.prod ]; then
  {
    echo "# 由 bootstrap.sh 生成 $(date -u +%FT%TZ)；不入库、不外传"
    echo "BYDP_ENV=$MODE"
    echo "POSTGRES_PASSWORD=$(rndpw)"
    echo "DB_APP_PASSWORD=$(rndpw)"
    echo "DB_SCORING_RO_PASSWORD=$(rndpw)"
    echo "DB_AGENT_PASSWORD=$(rndpw)"
    echo "AUTH_SECRET=$(rnd)"
    echo "IDENTITY_HMAC_KEY=$(rnd)"
    echo "AUTH_PII_KEY=$(rnd)"
    echo "BINDING_HMAC_KEY=$(rnd)"
    echo "BYDP_TRUST_PROXY=1"
    echo "SCORING_DAILY_ENABLED=false"
  } > .env.prod
fi
# A-017：已有 .env.prod 缺 Agent 角色密码时补一行（随机生成，不打印）
grep -qE '^DB_AGENT_PASSWORD=.+' .env.prod || echo "DB_AGENT_PASSWORD=$(rndpw)" >> .env.prod
# D-020：测试站磁盘告警阈值临时放宽到 15GB（正式环境不写，默认 25GB）
[ $PROD = 0 ] && { grep -qE '^DISK_ALERT_GB=' .env.prod || echo "DISK_ALERT_GB=15" >> .env.prod; }
# W2#010：测试站门禁口令（PO 在口令页输入）与 Cookie 值（十六进制，Caddy 正则匹配）；随机生成，不打印。正式环境不写
if [ $PROD = 0 ]; then
  grep -qE '^STAGING_GATE_PASSWORD=.+' .env.prod || echo "STAGING_GATE_PASSWORD=$(rndpw)" >> .env.prod
  grep -qE '^STAGING_GATE_TOKEN=[a-f0-9]{64}$' .env.prod || { grep -v '^STAGING_GATE_TOKEN=' .env.prod > .env.prod.tmp; echo "STAGING_GATE_TOKEN=$(openssl rand -hex 32)" >> .env.prod.tmp; mv .env.prod.tmp .env.prod; chmod 600 .env.prod; }
fi
# D-017：Telegram webhook secret token（随机生成，不打印；只用于校验 Telegram 回调）
grep -qE '^TG_WEBHOOK_SECRET=.+' .env.prod || echo "TG_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env.prod
# D-019：Meilisearch master key（随机生成，不打印；仅内网，api / web / worker 经 env_file 读取）
grep -qE '^MEILI_MASTER_KEY=.+' .env.prod || echo "MEILI_MASTER_KEY=$(openssl rand -hex 32)" >> .env.prod
# 只读搜索 key：按 Meili 规则 key = HMAC-SHA256(master, uid) 派生（uid 固定，见 core search/meili.ts SEARCH_KEY_UID；worker 启动时在 Meili 建该 key）。不打印
MEILI_SEARCH_KEY_UID=6f0c9f2e-5b1d-4c39-9a57-bd1a9e0c4d21
MK=$(grep -E '^MEILI_MASTER_KEY=' .env.prod | head -1 | cut -d= -f2-)
SK=$(printf %s "$MEILI_SEARCH_KEY_UID" | openssl dgst -sha256 -hmac "$MK" | awk '{print $NF}')
grep -vE '^MEILI_SEARCH_KEY=' .env.prod > .env.prod.tmp && echo "MEILI_SEARCH_KEY=$SK" >> .env.prod.tmp && cat .env.prod.tmp > .env.prod && rm -f .env.prod.tmp
unset MK SK
# 合并 PO 提供项（覆盖同名），并派生 AUTH_URL
IN_KEYS='TELEGRAM_BOT_TOKEN|RESEND_API_KEY|EMAIL_FROM|TELEGRAM_BOT_USERNAME|SITE_DOMAIN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ENDPOINT|R2_BUCKET_EVIDENCE|R2_BUCKET_BACKUP|BYDP_BEHIND_CLOUDFLARE|ADMIN_HOST|ADMIN_TELEGRAM_BOT_TOKEN|ADMIN_TELEGRAM_BOT_USERNAME|CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD|BACKUP_AGE_RECIPIENT|R2_BACKUP_ACCESS_KEY_ID|R2_BACKUP_SECRET_ACCESS_KEY|CF_AOP_ENABLED'
grep -vE "^(${IN_KEYS}|AUTH_URL|CF_TRUSTED_PROXIES|ADMIN_PATHS_ON_MAIN|BACKUP_EXPECTED)=" .env.prod > .env.prod.tmp
grep -E "^(${IN_KEYS})=" .env.prod.input >> .env.prod.tmp
# PO #22：测试站专用 Bot。.env.prod.input 填了 STAGING_TELEGRAM_BOT_TOKEN / _USERNAME 时测试站改用测试 Bot（覆盖上面合并的 TELEGRAM_BOT_*）；
# 未填维持原 Bot。正式环境不得出现（测试 Bot 只给测试站）。令牌不打印
ST_TOKEN=$( { grep -E '^STAGING_TELEGRAM_BOT_TOKEN=' .env.prod.input || true; } | tail -1 | cut -d= -f2- | tr -d "\"' \r")
TG_NOTE="Bot @$( { grep -E '^TELEGRAM_BOT_USERNAME=' .env.prod.input || true; } | tail -1 | cut -d= -f2- | tr -d "\"' \r")"
if [ -n "$ST_TOKEN" ]; then
  [ $PROD = 1 ] && fail "正式环境不得配置 STAGING_TELEGRAM_BOT_TOKEN（测试 Bot 只给测试站）"
  ST_USER=$( { grep -E '^STAGING_TELEGRAM_BOT_USERNAME=' .env.prod.input || true; } | tail -1 | cut -d= -f2- | tr -d "\"' \r@")
  [ -n "$ST_USER" ] || fail "配置测试 Bot 时须同时填 STAGING_TELEGRAM_BOT_USERNAME"
  grep -vE '^TELEGRAM_BOT_(TOKEN|USERNAME)=' .env.prod.tmp > .env.prod.tmp2
  { echo "TELEGRAM_BOT_TOKEN=$ST_TOKEN"; echo "TELEGRAM_BOT_USERNAME=$ST_USER"; } >> .env.prod.tmp2
  mv .env.prod.tmp2 .env.prod.tmp
  TG_NOTE="测试 Bot @$ST_USER"
fi
unset ST_TOKEN
SITE_DOMAIN=$(grep -E '^SITE_DOMAIN=' .env.prod.input | cut -d= -f2-)
[ -n "$SITE_DOMAIN" ] || fail ".env.prod.input 缺 SITE_DOMAIN"
echo "AUTH_URL=https://$SITE_DOMAIN" >> .env.prod.tmp
# D-020 #2：经 Cloudflare 时 Caddy 只信任 Cloudflare 回源段（在线拉取，校验格式与条数；失败用 cloudflare-ips.txt 兜底）；否则不信任任何代理
CF_SRC=""
BEHIND_CF=$(grep -E '^BYDP_BEHIND_CLOUDFLARE=' .env.prod.input | cut -d= -f2- | tr -d '"'"'"' \r')
# 正式环境必须在 Cloudflare 后（自检 I4）：否则回源被当作非 Cloudflare，国家头 / 真实 IP 全被丢弃，451 兜底失效、限流误伤
[ $PROD = 1 ] && [ "$BEHIND_CF" != "1" ] && fail "正式环境须在 .env.prod.input 设 BYDP_BEHIND_CLOUDFLARE=1（先完成 docs/ops/cloudflare-access.md）"
if [ "$BEHIND_CF" = "1" ]; then
  CF_LIST=$( { curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4; echo; curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6; } 2>/dev/null | grep -E '^[0-9a-f:.]+/[0-9]{1,3}$' || true)
  if [ "$(printf '%s\n' "$CF_LIST" | grep -c .)" -ge 10 ]; then CF_SRC="在线拉取"
  else CF_LIST=$(grep -E '^[0-9a-f:.]+/[0-9]{1,3}$' cloudflare-ips.txt); CF_SRC="内置兜底"; fi
  echo "CF_TRUSTED_PROXIES=\"$(printf '%s\n' "$CF_LIST" | tr '\n' ' ' | sed 's/ *$//')\"" >> .env.prod.tmp
else
  echo "CF_TRUSTED_PROXIES=127.0.0.1/32" >> .env.prod.tmp
fi
# D-020 #7：配置了备份桶即期望每日备份（worker 巡检 26 小时无成功备份告警）；正式环境必须有 age 公钥与备份专用令牌
grep -qE '^R2_BUCKET_BACKUP=.+' .env.prod.input && echo "BACKUP_EXPECTED=1" >> .env.prod.tmp
if [ $PROD = 1 ]; then
  for k in BACKUP_AGE_RECIPIENT R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY; do grep -qE "^$k=.+" .env.prod.input || fail "正式环境须在 .env.prod.input 填 $k（见 docs/ops/go-live.md「备份」）"; done
fi
# D-020 #3：后台独立子域。配置 ADMIN_HOST → 生成 admin-host.caddy、主站不再转发 /admin、启动 auth-admin；否则维持 /admin 路径
ADMIN_HOST=$(grep -E '^ADMIN_HOST=' .env.prod.input | cut -d= -f2- | tr -d ' ')
# 正式环境主站公开、无 Basic Auth：后台必须走独立子域 + Cloudflare Access（§9 #22 / #4），否则 /admin 会暴露在主站
[ $PROD = 1 ] && [ -z "$ADMIN_HOST" ] && fail "正式环境必须在 .env.prod.input 配置 ADMIN_HOST（后台独立子域）"
# D-020 #30：后台子域必须配置 Access JWT 校验（团队域 + 应用 AUD，均非密钥）；否则后台全部 403，正式环境直接拒绝部署
if [ -n "$ADMIN_HOST" ]; then
  for k in CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD; do grep -qE "^$k=.+" .env.prod.input || fail "配置 ADMIN_HOST 时须在 .env.prod.input 填 $k（见 docs/ops/cloudflare-access.md 第 4 节）"; done
fi
# D-031：测试站门禁开关——.env.prod 中 STAGING_GATE=off 时用公开片段（noindex 照旧、不设门禁）；缺省 / 其他值一律开启门禁（失败即关）
GATE_OFF=0
[ $PROD = 0 ] && grep -qE '^STAGING_GATE=off$' .env.prod 2>/dev/null && GATE_OFF=1
if [ $GATE_OFF = 1 ]; then cp site-mode.staging-open.caddy site-mode.caddy; else cp "site-mode.$MODE.caddy" site-mode.caddy; fi
# D-020 #31：AOP 开关（默认关）。aop-ca.pem 不存在时建空文件（避免 Docker 把缺失的挂载源建成目录）；开关为 1 而证书缺失 / 非法 → 拒绝部署
AOP=$(grep -E '^CF_AOP_ENABLED=' .env.prod.input | cut -d= -f2- | tr -d "\"' \r" || true)
[ -e aop-ca.pem ] || : > aop-ca.pem
bash gen-aop.sh "${AOP:-0}" aop-ca.pem aop.caddy >/tmp/bydp-aop.log 2>&1 || fail "$(tail -1 /tmp/bydp-aop.log | sed 's/^❌ 失败 ｜ //')"
if [ -n "$ADMIN_HOST" ]; then
  [ "$ADMIN_HOST" != "$SITE_DOMAIN" ] || fail "ADMIN_HOST 不能与 SITE_DOMAIN 相同"
  cp admin-host.caddy.tpl admin-host.caddy
  echo "ADMIN_PATHS_ON_MAIN=/__admin_moved_to_subdomain__" >> .env.prod.tmp
  UP_EXTRA="auth-admin"
else
  echo "# 未配置 ADMIN_HOST：后台走主站 /admin 路径（测试站）" > admin-host.caddy
  echo 'ADMIN_PATHS_ON_MAIN="/admin /admin/*"' >> .env.prod.tmp
  UP_EXTRA=""
fi
mv .env.prod.tmp .env.prod && chmod 600 .env.prod .env.prod.input
for k in TELEGRAM_BOT_TOKEN RESEND_API_KEY EMAIL_FROM; do grep -qE "^$k=.+" .env.prod || fail ".env.prod 缺 $k"; done
pass "域名 $SITE_DOMAIN · $TG_NOTE · 变量 $(grep -cE '^[A-Z0-9_]+=' .env.prod) 项（值不显示）· Cloudflare 回源段：${CF_SRC:-未启用（不经 Cloudflare）}"

step "5/8 构建镜像（首次约 5–10 分钟）"
# 每次构建约留下 15GB 缓存：先清 24h 前的构建缓存与悬空镜像（不动数据卷），避免 1/8 磁盘检查失败
docker builder prune -f --filter until=24h >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
$DC build migrate >/tmp/bydp-build.log 2>&1 || fail "镜像构建失败（日志 /tmp/bydp-build.log 末尾：$(tail -1 /tmp/bydp-build.log)）"
pass "bydp-app:$MODE 构建完成"

step "6/8 数据库：启动 → 迁移 → 角色密码 → 演示数据"
$DC up -d postgres redis meilisearch >/dev/null 2>&1 || fail "postgres / redis / meilisearch 启动失败"
$DC run --rm migrate >/tmp/bydp-migrate.log 2>&1 || fail "迁移失败（$(tail -1 /tmp/bydp-migrate.log)）"
# 角色密码经 stdin 传入 psql，不出现在命令行
set -a; . ./.env.prod; set +a
# A-017 审核条件 2：Agent 角色限连接数 5、单语句 30 秒，Agent 出 bug 也拖不垮数据库
printf "ALTER ROLE bydp_app PASSWORD '%s'; ALTER ROLE bydp_scoring_ro PASSWORD '%s'; ALTER ROLE bydp_agent PASSWORD '%s' CONNECTION LIMIT 5; ALTER ROLE bydp_agent SET statement_timeout = '30s';\n" "$DB_APP_PASSWORD" "$DB_SCORING_RO_PASSWORD" "$DB_AGENT_PASSWORD" \
  | $DC exec -T postgres psql -q -U bydp_owner -d bydp -v ON_ERROR_STOP=1 >/dev/null || fail "设置角色密码失败"
# D-020 #4 / §9 #7：数据库会话时区必须 UTC
TZDB=$($DC exec -T postgres psql -tA -U bydp_owner -d bydp -c 'show timezone' | tr -d '[:space:]')
[ "$TZDB" = "UTC" ] || [ "$TZDB" = "Etc/UTC" ] || fail "数据库时区为 $TZDB，须为 UTC"
BRANDS=$($DC exec -T postgres psql -tA -U bydp_owner -d bydp -c 'select count(*) from brand')
if [ $PROD = 1 ]; then
  # 正式环境：不灌任何演示数据；每次部署都跑数据守卫（发现演示 / 测试站数据即停）
  $DC run --rm migrate ./node_modules/.bin/tsx scripts/seed-prod.ts >/tmp/bydp-seed.log 2>&1 || fail "正式库数据守卫未通过（$(grep -m1 '❌' /tmp/bydp-seed.log || tail -1 /tmp/bydp-seed.log)）"
elif [ "${BRANDS:-0}" = "0" ]; then
  $DC run --rm migrate ./node_modules/.bin/tsx scripts/seed.ts >/tmp/bydp-seed.log 2>&1 || fail "seed 失败（$(tail -1 /tmp/bydp-seed.log)）"
  $DC run --rm migrate ./node_modules/.bin/tsx scripts/seed-demo.ts >>/tmp/bydp-seed.log 2>&1 || fail "seed:demo 失败（$(tail -1 /tmp/bydp-seed.log)）"
fi
MIG=$($DC exec -T postgres psql -tA -U bydp_owner -d bydp -c 'select count(*) from drizzle.__drizzle_migrations')
BRANDS=$($DC exec -T postgres psql -tA -U bydp_owner -d bydp -c 'select count(*) from brand')
pass "迁移 $MIG 条 · 品牌 $BRANDS 个 · 时区 UTC$( [ $PROD = 1 ] && echo ' · 正式库数据守卫通过')"

step "7/8 启动服务（web / admin / api / worker / tg-bot / caddy）"
$DC ${UP_EXTRA:+--profile admin-host} up -d web admin api worker tg-bot $UP_EXTRA caddy >/tmp/bydp-up.log 2>&1 || fail "服务启动失败（$(tail -1 /tmp/bydp-up.log)）"
# Caddyfile / admin-host.caddy 为挂载文件：内容变化不会触发容器重建，显式热加载（同时校验配置，失败即停）
# 容器刚重建时管理端口尚未就绪（connection refused）：重试至多约 20 秒；配置错误则立即失败
RELOADED=0
for i in $(seq 1 10); do
  if $DC exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/bydp-caddy.log 2>&1; then RELOADED=1; break; fi
  grep -q 'connection refused' /tmp/bydp-caddy.log || break
  sleep 2
done
[ $RELOADED = 1 ] || fail "Caddy 配置加载失败（$(tail -1 /tmp/bydp-caddy.log | cut -c1-200)）"
W=""
for i in $(seq 1 40); do
  W=$($DC ps --format '{{.Service}}={{.Health}}' web admin api 2>/dev/null | tr '\n' ' ')
  [ "$(grep -o '=healthy' <<<"$W" | wc -l)" -eq 3 ] && break
  sleep 3
done
[ "$(grep -o '=healthy' <<<"$W" | wc -l)" -eq 3 ] && pass "健康：$W" || fail "健康检查未通过：$W"

# D-023 / F3：预热（容器内直连 web，不经门禁 / DNS）：首页 · 首页上第一个品牌页 · 一个查验页，各 1 次；失败不影响部署
WARM=$($DC exec -T web node -e "const B='http://127.0.0.1:3100',t=Date.now();fetch(B+'/').then(r=>r.text()).then(h=>{const m=/href=\"(\/brand\/[a-z0-9-]+)\"/.exec(h);return Promise.all([m?fetch(B+m[1]):null,fetch(B+'/check/example.com')])}).then(()=>console.log((Date.now()-t)+'ms'),()=>console.log('失败'))" 2>/dev/null || true)
echo "预热：首页 / 品牌页 / 查验页 ${WARM:-未执行}"

step "8/8 对外访问（HTTPS 证书$( [ $PROD = 0 ] && echo ' + 门禁')）"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$SITE_DOMAIN/" || true)
if [ $PROD = 1 ]; then
  ROBOTS=$(curl -s --max-time 20 "https://$SITE_DOMAIN/robots.txt" | tr '\n' ' ' || true)
  ADM=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$SITE_DOMAIN/admin" || true)
  if [ "$CODE" = "200" ] && [ "$ADM" != "200" ]; then pass "https://$SITE_DOMAIN 返回 200 · 主站 /admin 返回 $ADM（后台只在 $ADMIN_HOST）· robots: $ROBOTS"
  else printf '⚠️ 待定 ｜ https://%s 返回 %s，/admin 返回 %s：DNS / 证书未就绪或配置异常\n' "$SITE_DOMAIN" "${CODE:-无响应}" "${ADM:-无响应}"; fi
  echo; echo "正式环境部署完成。Cloudflare 就绪自检：bash scripts/cf-ready-check.sh $SITE_DOMAIN <服务器IP> --server"
  exit 0
fi
if [ $GATE_OFF = 1 ]; then
  # D-031 公开模式：无 Cookie 直接 200，且仍带 noindex 头
  NOINDEX=$(curl -s -D - -o /dev/null --max-time 20 "https://$SITE_DOMAIN/" | grep -ci '^x-robots-tag: noindex' || true)
  ROBOTS=$(curl -s --max-time 20 "https://$SITE_DOMAIN/robots.txt" | tr '\n' ' ' || true)
  if [ "$CODE" = "200" ] && [ "${NOINDEX:-0}" -ge 1 ]; then pass "https://$SITE_DOMAIN 公开访问（STAGING_GATE=off）返回 200，仍带 noindex · robots: $ROBOTS"
  elif [ -n "$CODE" ] && [ "$CODE" != "000" ]; then fail "公开模式异常：无 Cookie 返回 $CODE · noindex 头 ${NOINDEX:-0}"
  else printf '⚠️ 待定 ｜ https://%s 返回 %s：DNS 未指向本机或证书尚未签发\n' "$SITE_DOMAIN" "${CODE:-无响应}"; fi
  echo; echo "测试站访问：公开模式（STAGING_GATE=off），无需口令；恢复门禁：删掉该行后重跑 bootstrap"
  exit 0
fi
# 门禁：无 Cookie → 401 口令页（不含站点内容）；带 Cookie（经 stdin 传给 curl，不出现在命令行）→ 200
GATE=$(curl -s --max-time 20 "https://$SITE_DOMAIN/" | grep -c 'action="/__gate"' || true)
OK=$(printf 'cookie = "bydp_gate=%s"\n' "$STAGING_GATE_TOKEN" | curl -s -K - -o /dev/null -w '%{http_code}' --max-time 20 "https://$SITE_DOMAIN/" || true)
ROBOTS=$(printf 'cookie = "bydp_gate=%s"\n' "$STAGING_GATE_TOKEN" | curl -s -K - --max-time 20 "https://$SITE_DOMAIN/robots.txt" | tr '\n' ' ' || true)
if [ "$CODE" = "401" ] && [ "${GATE:-0}" -ge 1 ] && [ "$OK" = "200" ]; then pass "https://$SITE_DOMAIN 无 Cookie 返回 401 口令页、带 Cookie 返回 200（门禁生效）· robots: $ROBOTS"
elif [ -n "$CODE" ] && [ "$CODE" != "000" ]; then fail "门禁异常：无 Cookie $CODE（口令页 ${GATE:-0}）· 带 Cookie ${OK:-无响应}"
else printf '⚠️ 待定 ｜ https://%s 返回 %s：DNS 未指向本机或证书尚未签发（A 记录生效后 caddy 自动重试）\n' "$SITE_DOMAIN" "${CODE:-无响应}"; fi
echo
echo "测试站访问：浏览器打开站点会出现口令页；口令见服务器 ~/bydp/deploy/.env.prod 的 STAGING_GATE_PASSWORD（开发会话同步到 PO 本机 ~/bydp-keys/staging-gate.txt，不发进会话）"
