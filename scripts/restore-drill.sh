#!/usr/bin/env bash
# 备份恢复演练（D-020 #7 · HANDOVER §9 #6）：下载最新备份 → age 私钥解密 → 导入临时 PostgreSQL 16 容器 → 按清单逐表核对行数。
# 每步输出「✅ 通过 ｜ …」或「❌ 失败 ｜ …」，有失败退出码 1。全程不打印任何密钥；解密后的明文只在临时目录，结束即删。
# 在 **PO 本机**执行（备份私钥不放服务器）；需要 Docker 与 age（mac：brew install age；无 age 时自动用容器）。
# 用法：
#   bash scripts/restore-drill.sh --env-file <含 R2 只读令牌的文件> --identity <age 私钥文件>        # 从 R2 取最新备份
#   bash scripts/restore-drill.sh --env-file <…> --identity <…> --file bydp-20261005T1830Z.sql.gz.age # 指定某次备份
#   bash scripts/restore-drill.sh --local <目录> --identity <…>                                       # 用本机目录里的备份（演练 / 测试）
# env 文件需含：R2_ENDPOINT、R2_BUCKET_BACKUP，以及 R2_RESTORE_ACCESS_KEY_ID / R2_RESTORE_SECRET_ACCESS_KEY（只读令牌，见 go-live.md）。
set -uo pipefail
ENVFILE=""; IDENTITY=""; FILE=""; LOCAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENVFILE=${2:?}; shift ;;
    --identity) IDENTITY=${2:?}; shift ;;
    --file) FILE=${2:?}; shift ;;
    --local) LOCAL=${2:?}; shift ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
  shift
done
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; cleanup; exit 1; }
WORK=$(mktemp -d); chmod 700 "$WORK"
PG="bydp-restore-drill-$$"
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

[ -n "$IDENTITY" ] && [ -r "$IDENTITY" ] || fail "缺少可读的 age 私钥文件（--identity）"
docker info >/dev/null 2>&1 || fail "Docker 未运行"

# ① 取得备份与清单
if [ -n "$LOCAL" ]; then
  [ -d "$LOCAL" ] || fail "本机目录 $LOCAL 不存在"
  [ -n "$FILE" ] || FILE=$(cd "$LOCAL" && ls -1 bydp-*.sql.gz.age 2>/dev/null | sort | tail -1)
  # 文件名先校验再使用（两种模式同一正则；解密步骤会把文件名拼进容器命令）
  [[ "$FILE" =~ ^bydp-[0-9]{8}T[0-9]{4}Z\.sql\.gz\.age$ ]] || fail "备份文件名不合规：${FILE:-（无）}"
  cp "$LOCAL/$FILE" "$LOCAL/$FILE.manifest.json" "$WORK/" 2>/dev/null || fail "本机目录 $LOCAL 中没有备份或清单"
  pass "使用本机备份 $FILE"
else
  [ -n "$ENVFILE" ] && [ -r "$ENVFILE" ] || fail "缺少 --env-file"
  val() { { grep -E "^$1=" "$ENVFILE" || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
  ENDPOINT=$(val R2_ENDPOINT); BUCKET=$(val R2_BUCKET_BACKUP)
  AK=$(val R2_RESTORE_ACCESS_KEY_ID); SK=$(val R2_RESTORE_SECRET_ACCESS_KEY)
  for k in ENDPOINT BUCKET AK SK; do [ -n "${!k}" ] || fail "env 文件缺 R2 配置（$k）"; done
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=auto\n' "$AK" "$SK" > "$WORK/r2.env"; unset AK SK
  s3() { docker run --rm -v "$WORK":/b --env-file "$WORK/r2.env" amazon/aws-cli s3 "$@" --endpoint-url "$ENDPOINT" --cli-connect-timeout 20 --cli-read-timeout 300 >/dev/null 2>&1; }
  if [ -z "$FILE" ]; then
    s3 cp "s3://$BUCKET/postgres/LATEST" /b/LATEST || fail "下载 postgres/LATEST 失败（令牌 / 桶名 / 网络）"
    FILE=$(tr -d '[:space:]' < "$WORK/LATEST")
  fi
  [[ "$FILE" =~ ^bydp-[0-9]{8}T[0-9]{4}Z\.sql\.gz\.age$ ]] || fail "备份文件名不合规：$FILE"
  s3 cp "s3://$BUCKET/postgres/$FILE" "/b/$FILE" && s3 cp "s3://$BUCKET/postgres/$FILE.manifest.json" "/b/$FILE.manifest.json" || fail "下载 $FILE 或清单失败"
  pass "已下载最新备份 $FILE（$(du -h "$WORK/$FILE" | cut -f1)）与清单"
fi

# ② 解密 + 解压
if command -v age >/dev/null 2>&1; then
  age -d -i "$IDENTITY" "$WORK/$FILE" 2>/dev/null | gunzip > "$WORK/dump.sql" 2>/dev/null
else
  cp "$IDENTITY" "$WORK/id.key"
  docker run --rm -v "$WORK":/w alpine:3.20 sh -c "apk add -q age >/dev/null && age -d -i /w/id.key /w/$FILE | gunzip > /w/dump.sql" 2>/dev/null
  rm -f "$WORK/id.key"
fi
[ -s "$WORK/dump.sql" ] && grep -q '^-- PostgreSQL database dump' "$WORK/dump.sql" || fail "解密失败（私钥与备份公钥不匹配，或文件损坏）"
pass "解密成功（$(du -h "$WORK/dump.sql" | cut -f1) 明文，仅在临时目录）"

# ③ 导入临时库（预建运行期角色，导出里的 GRANT 才能执行）
docker run -d --name "$PG" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=bydp postgres:16 -c timezone=UTC >/dev/null || fail "启动临时 PostgreSQL 失败"
# 官方镜像首启会先起临时实例做初始化再重启：等日志出现「init process complete」后再判就绪
for i in $(seq 1 60); do docker logs "$PG" 2>&1 | grep -q 'PostgreSQL init process complete' && docker exec "$PG" pg_isready -U postgres -d bydp >/dev/null 2>&1 && break; sleep 1; done
docker exec "$PG" psql -q -U postgres -d bydp -c "CREATE ROLE bydp_app NOLOGIN; CREATE ROLE bydp_scoring_ro NOLOGIN; CREATE ROLE bydp_agent NOLOGIN;" >/dev/null 2>&1
docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d bydp < "$WORK/dump.sql" >/dev/null 2>"$WORK/restore.err" || fail "导入失败：$( (grep -m1 ERROR "$WORK/restore.err" || tail -1 "$WORK/restore.err") | cut -c1-200)"
rm -f "$WORK/dump.sql"
pass "已导入临时库"

# ④ 按清单逐表核对行数
python3 - "$WORK/$FILE.manifest.json" "$PG" <<'PY'
import json, re, subprocess, sys
m = json.load(open(sys.argv[1]))
bad, n = [], 0
NAME = re.compile(r'^(public|drizzle)\.("?[a-z_][a-z0-9_]*"?)$')
tables = m.get("tables")
if not isinstance(tables, dict) or not tables:
    print("❌ 失败 ｜ 清单格式不对（无 tables）"); sys.exit(1)
for table, want in tables.items():
    # 清单来自桶：表名先过白名单正则、行数须为非负整数，否则判失败（不拼进 SQL）
    if not NAME.match(table) or not isinstance(want, int) or want < 0:
        print(f"❌ 失败 ｜ 清单含不合规条目：{table[:60]!r}"); sys.exit(1)
    got = subprocess.run(["docker", "exec", sys.argv[2], "psql", "-tA", "-U", "postgres", "-d", "bydp", "-c", f'select count(*) from {table}'], capture_output=True, text=True).stdout.strip()
    n += 1
    if got != str(want):
        bad.append(f"{table} 期望 {want} 实际 {got or '读取失败'}")
if bad:
    print("❌ 失败 ｜ 行数不一致：" + "；".join(bad[:5]) + ("…" if len(bad) > 5 else ""))
    sys.exit(1)
print(f"✅ 通过 ｜ {n} 张表行数与备份清单一致（备份时间 {m['createdAt']}）")
PY
[ $? -eq 0 ] || exit 1
echo "—— 恢复演练通过"
