#!/usr/bin/env bash
# 部署 / 回滚（D-020 #6）：在开发机执行，把某个已提交版本（默认 HEAD）部署到测试站或正式服务器，并等待 bootstrap 结果。
#   bash scripts/deploy.sh staging                         # 测试站，部署 HEAD
#   bash scripts/deploy.sh prod --host <正式机 IP>          # 正式环境（bootstrap --prod）
#   bash scripts/deploy.sh prod --host <IP> --ref <提交>     # 回滚 / 指定版本：部署该提交（数据库迁移只前进，见 go-live.md「回滚」）
# - 只部署 git 已提交内容（git archive），本地未提交改动不会上服务器；
# - 服务器上的配置与密钥文件永不覆盖：.env.prod / .env.prod.input / 生成的 Caddy 片段 / aop-ca.pem；
# - 不打印任何密钥；SSH 端口 2222，用户 ubuntu。
# - 服务器与密钥：测试站 BYDP_STAGING_HOST / BYDP_STAGING_SSH_KEY，正式环境 --host + BYDP_PROD_SSH_KEY（缺省 ~/.ssh/bydp-prod.pem）；
#   取环境变量，未设置时读 .env.local（见 .env.example）。
set -uo pipefail
# D-030：服务器地址与 SSH 密钥路径不写死——取环境变量，未设置时读仓库根目录 .env.local（都不是密钥）
localcfg() { [ -n "${!1:-}" ] && { printf '%s' "${!1}"; return; }; { grep -E "^$1=" "$(dirname "$0")/../.env.local" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | tr -d "\"'\r"; }
TARGET=${1:-}; shift || true
HOST=""; REF=HEAD
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=${2:?}; shift ;;
    --ref) REF=${2:?}; shift ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
  shift
done
case "$TARGET" in
  staging) HOST=${HOST:-$(localcfg BYDP_STAGING_HOST)}; KEY=$(localcfg BYDP_STAGING_SSH_KEY); MODE=--staging
    [ -n "$HOST" ] && [ -n "$KEY" ] || { echo "❌ 失败 ｜ 未配置 BYDP_STAGING_HOST / BYDP_STAGING_SSH_KEY（环境变量或 .env.local）"; exit 2; } ;;
  prod) [ -n "$HOST" ] || { echo "❌ 失败 ｜ 正式环境须指定 --host <正式机 IP>"; exit 2; }; KEY=$(localcfg BYDP_PROD_SSH_KEY); KEY=${KEY:-~/.ssh/bydp-prod.pem}; MODE=--prod ;;
  *) echo "用法：$0 staging|prod [--host IP] [--ref 提交]"; exit 2 ;;
esac
KEY=${KEY/#\~/$HOME}
[ -r "$KEY" ] || { echo "❌ 失败 ｜ SSH 私钥不可读：$KEY"; exit 2; }
[[ "$HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "❌ 失败 ｜ --host 须为 IPv4 地址"; exit 2; }
[ -r "$KEY" ] || { echo "❌ 失败 ｜ 缺 SSH 私钥 $KEY"; exit 1; }
cd "$(dirname "$0")/.."
SHA=$(git rev-parse --verify --short "$REF^{commit}" 2>/dev/null) || { echo "❌ 失败 ｜ 找不到提交 $REF"; exit 1; }
SSH=(ssh -p 2222 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

git archive --format=tar.gz -o "$TMP/bydp.tgz" "$SHA" || { echo "❌ 失败 ｜ 打包 $SHA 失败"; exit 1; }
scp -q -P 2222 -i "$KEY" -o BatchMode=yes "$TMP/bydp.tgz" "ubuntu@$HOST:~/bydp.tgz" || { echo "❌ 失败 ｜ 上传到 $HOST 失败（SSH 2222 / 密钥）"; exit 1; }
"${SSH[@]}" "rm -rf ~/bydp-src && mkdir ~/bydp-src && tar -xzf ~/bydp.tgz -C ~/bydp-src && mkdir -p ~/bydp && \
  rsync -a --delete --exclude deploy/.env.prod --exclude deploy/.env.prod.input --exclude deploy/admin-host.caddy \
    --exclude deploy/site-mode.caddy --exclude deploy/aop.caddy --exclude deploy/aop-ca.pem ~/bydp-src/ ~/bydp/ && \
  echo $SHA > ~/bydp/DEPLOYED_SHA && cd ~/bydp && (setsid nohup bash deploy/bootstrap.sh $MODE > ~/bydp-bootstrap.log 2>&1 < /dev/null &)" \
  || { echo "❌ 失败 ｜ 服务器解包或启动 bootstrap 失败"; exit 1; }
echo "… 已上传 $SHA 到 $TARGET（$HOST），bootstrap $MODE 运行中（首次约 10 分钟）"
for i in $(seq 1 90); do
  sleep 15
  OUT=$("${SSH[@]}" "grep -aE '^❌|^✅ 通过 ｜ https://|^⚠️ 待定|^正式环境部署完成' ~/bydp-bootstrap.log | tail -1" 2>/dev/null)
  case "$OUT" in
    ❌*) "${SSH[@]}" "grep -aE '^❌|^✅|^⚠' ~/bydp-bootstrap.log | tail -3 | cut -c1-200"; exit 1 ;;
    ✅*|⚠*|正式环境*) "${SSH[@]}" "grep -aE '^❌|^✅|^⚠' ~/bydp-bootstrap.log | tail -4 | cut -c1-200"; echo "—— $TARGET 已部署 $SHA"; exit 0 ;;
  esac
done
echo "❌ 失败 ｜ 等待 bootstrap 超时（22 分钟），查看服务器 ~/bydp-bootstrap.log"; exit 1
