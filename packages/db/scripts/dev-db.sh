#!/usr/bin/env bash
# 本地一次性验证库（无 Docker 时的替代）：用 Postgres.app 的 initdb 在临时目录起一个独立实例。
# 时区固定 UTC（与测试站 / 生产 postgres timezone=UTC 一致；current_date 等日期按 UTC，D-019 午夜后本地时区导致用例漂移）。
# 用法：PGBIN=/Applications/Postgres.app/Contents/Versions/16/bin DATA=/tmp/bydp-pg PORT=55432 bash scripts/dev-db.sh start|stop
set -euo pipefail
PGBIN=${PGBIN:-/Applications/Postgres.app/Contents/Versions/16/bin}
DATA=${DATA:?DATA 目录必填}
PORT=${PORT:-55432}
case "${1:-start}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      # UTF8：与测试站 / 生产（postgres:16 镜像默认 UTF8）一致；SQL_ASCII 下 char_length 按字节计，中文长度约束会失真
      "$PGBIN/initdb" -D "$DATA" -U bydp --auth=trust -E UTF8 --locale=C >/dev/null
    fi
    "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=localhost -c timezone=UTC -k ''" -l "$DATA/log" -w start >/dev/null
    "$PGBIN/psql" -h localhost -p "$PORT" -U bydp -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='bydp'" | grep -q 1 \
      || "$PGBIN/createdb" -h localhost -p "$PORT" -U bydp bydp
    echo "postgres://bydp@localhost:$PORT/bydp"
    ;;
  stop) "$PGBIN/pg_ctl" -D "$DATA" -w stop >/dev/null ;;
esac
