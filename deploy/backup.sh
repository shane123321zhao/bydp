#!/usr/bin/env bash
# 每日数据库备份（D-009 #5 · D-020 #7 R2 硬化）：pg_dump →（统计每表行数）→ gzip → age 公钥加密 → Cloudflare R2。
# - 密钥不进 shell 环境：只从 .env.prod 逐键读取所需值（不 source 整个文件），R2 凭据经 600 权限临时 env 文件传给 aws-cli 容器（--env-file）。
# - 加密：BACKUP_AGE_RECIPIENT（age 公钥，age1…）。**私钥不在服务器**，由 PO 离线保管（docs/ops/go-live.md「备份加密」）；
#   未配置公钥即拒绝上传（不再上传明文备份）并告警。
# - R2 令牌：优先用备份专用 R2_BACKUP_ACCESS_KEY_ID / R2_BACKUP_SECRET_ACCESS_KEY（只授权备份桶，配合桶锁）；
#   测试站未配置时退回 R2_ACCESS_KEY_ID；正式环境必须用备份专用令牌且不得与证据令牌相同。
# - 上传：postgres/<文件>.sql.gz.age · postgres/<文件>.manifest.json（每表行数，供恢复演练核对；不含数据内容）· postgres/LATEST（最新文件名）。
# - 成功：写 Redis bydp:backup:last（worker 每日巡检超过 26 小时无成功备份即告警）；失败：经 worker 推送 admin 告警。
# 安装定时任务（每天 UTC 18:30，即 UTC+8 次日 02:30，错开 02:00 评分）：
#   (crontab -l 2>/dev/null; echo "30 18 * * * bash $HOME/bydp/deploy/backup.sh >> $HOME/bydp-backup.log 2>&1") | crontab -
# 演练用：bash deploy/backup.sh --local-only <目录>   只生成加密备份与清单到本机目录，不上传、不写成功标记。
set -euo pipefail
cd "$(dirname "$0")"
umask 077
LOCAL_DIR=""
[ "${1:-}" = "--local-only" ] && LOCAL_DIR=${2:?--local-only 后须跟目录}

DC="docker compose -f compose.prod.yml --env-file .env.prod"
docker info >/dev/null 2>&1 || DC="sudo $DC"
DK="docker"; docker info >/dev/null 2>&1 || DK="sudo docker"
STEP="准备"
WORK=$(mktemp -d)
trap 'rc=$?; rm -rf "$WORK"; if [ $rc -ne 0 ]; then
  echo "❌ 失败 ｜ 备份在「$STEP」步骤失败（退出码 $rc）"
  $DC exec -T worker ./node_modules/.bin/tsx src/cli/alert.ts backup_failed "数据库备份在「$STEP」步骤失败（退出码 $rc），详见服务器 ~/bydp-backup.log" >/dev/null 2>&1 || true
fi' EXIT

# 只读取需要的键（不 source .env.prod，避免把全部密钥带进 shell 环境）
val() { { grep -E "^$1=" .env.prod || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

STEP="读取配置"
ENVNAME=$(val BYDP_ENV)
RECIPIENT=$(val BACKUP_AGE_RECIPIENT)
# 本机演练（--local-only，不上传）可用 BACKUP_AGE_RECIPIENT_DRILL 指定演练用公钥
[ -n "$LOCAL_DIR" ] && [ -n "${BACKUP_AGE_RECIPIENT_DRILL:-}" ] && RECIPIENT=$BACKUP_AGE_RECIPIENT_DRILL
[[ "$RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]] || { echo "❌ 失败 ｜ 未配置 BACKUP_AGE_RECIPIENT（age 公钥），拒绝上传未加密备份"; exit 3; }
if [ -z "$LOCAL_DIR" ]; then
  ENDPOINT=$(val R2_ENDPOINT); BUCKET=$(val R2_BUCKET_BACKUP)
  AK=$(val R2_BACKUP_ACCESS_KEY_ID); SK=$(val R2_BACKUP_SECRET_ACCESS_KEY)
  if [ -z "$AK" ] || [ -z "$SK" ]; then
    [ "$ENVNAME" = production ] && { echo "❌ 失败 ｜ 正式环境须配置备份专用令牌 R2_BACKUP_ACCESS_KEY_ID / R2_BACKUP_SECRET_ACCESS_KEY"; exit 3; }
    AK=$(val R2_ACCESS_KEY_ID); SK=$(val R2_SECRET_ACCESS_KEY)
  elif [ "$ENVNAME" = production ] && [ "$AK" = "$(val R2_ACCESS_KEY_ID)" ]; then
    echo "❌ 失败 ｜ 备份令牌不得与证据令牌相同（令牌拆分，见 go-live.md）"; exit 3
  fi
  for k in ENDPOINT BUCKET AK SK; do [ -n "${!k}" ] || { echo "❌ 失败 ｜ 缺 R2 备份配置（$k）"; exit 3; }; done
fi

STEP="检查 age"
# age 由 bootstrap 预装（cron 下 sudo 可能要密码，不在此安装）
command -v age >/dev/null 2>&1 || { echo "❌ 失败 ｜ 服务器未安装 age：重跑 bash deploy/bootstrap.sh（会预装）"; exit 3; }

STEP="导出与加密"
F="bydp-$(date -u +%Y%m%dT%H%MZ).sql.gz.age"
# 明文导出只在 600 权限临时目录短暂存在，加密后随 trap 删除；行数从导出内容统计（每个 COPY 块的数据行），与备份逐表一致
$DC exec -T postgres pg_dump -U bydp_owner -d bydp --no-owner > "$WORK/dump.sql"
awk '/^COPY [^ ]+ /{t=$2; n=0; inb=1; next} inb && /^\\\.$/{c[t]=n; inb=0; next} inb{n++} END{for (k in c) print k "\t" c[k]}' "$WORK/dump.sql" > "$WORK/counts.tsv"
gzip -9 -c "$WORK/dump.sql" | age -r "$RECIPIENT" > "$WORK/$F"
rm -f "$WORK/dump.sql"
[ -s "$WORK/$F" ] && [ -s "$WORK/counts.tsv" ] || { echo "❌ 失败 ｜ 导出为空"; exit 4; }
python3 - "$WORK/counts.tsv" "$F" > "$WORK/$F.manifest.json" <<'PY'
import json, sys, datetime
counts = {}
for line in open(sys.argv[1]):
    t, n = line.rstrip('\n').split('\t')
    counts[t] = int(n)
print(json.dumps({"file": sys.argv[2], "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "tables": dict(sorted(counts.items()))}, ensure_ascii=False, indent=1))
PY
SIZE=$(du -h "$WORK/$F" | cut -f1)
TABLES=$(wc -l < "$WORK/counts.tsv" | tr -d ' ')

if [ -n "$LOCAL_DIR" ]; then
  mkdir -p "$LOCAL_DIR" && cp "$WORK/$F" "$WORK/$F.manifest.json" "$LOCAL_DIR/"
  echo "✅ 通过 ｜ 本机演练备份 $F（$SIZE，$TABLES 张表）已写入 $LOCAL_DIR（未上传）"
  exit 0
fi

STEP="上传 R2"
ENVF="$WORK/r2.env"
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=auto\n' "$AK" "$SK" > "$ENVF"
unset AK SK
echo "$F" > "$WORK/LATEST"
for obj in "$F" "$F.manifest.json" LATEST; do
  $DK run --rm -v "$WORK":/b --env-file "$ENVF" amazon/aws-cli s3 cp "/b/$obj" "s3://$BUCKET/postgres/$obj" --endpoint-url "$ENDPOINT" --cli-connect-timeout 20 --cli-read-timeout 120 >/dev/null
done

STEP="记录成功"
$DC exec -T redis redis-cli SET bydp:backup:last "$(date -u +%s)" >/dev/null
echo "✅ 通过 ｜ 备份 $F（$SIZE，$TABLES 张表，age 加密）已上传 R2"
