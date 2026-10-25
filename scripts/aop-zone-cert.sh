#!/usr/bin/env bash
# D-020 #31 按 zone 的 Authenticated Origin Pulls（PO 本机执行，约 2 分钟）：
#   ① 本机生成我方回源 CA 与客户端证书（私钥只在本机 ~/bydp-keys/aop/，不上服务器、不进会话）；
#   ② 用 Cloudflare API 把客户端证书上传到本 zone，并开启 zone 级 AOP；
#   ③ 输出 CA 证书（公开信息）路径——交给开发放到服务器 deploy/aop-ca.pem，并在 .env.prod.input 设 CF_AOP_ENABLED=1。
# 与 Cloudflare 全局回源证书的区别：全局证书所有 Cloudflare 客户共用，挡不住他人账号回源；zone 证书只有我们的 zone 会出示。
# 用法：bash scripts/aop-zone-cert.sh --env-file ~/bydp-keys/cloudflare.env            # 首次：生成 CA + 客户端证书并上传、开启
#       bash scripts/aop-zone-cert.sh --env-file ~/bydp-keys/cloudflare.env --renew    # 换证（825 天有效，签发日 + 800 天前）：沿用 CA、换新客户端证书并删除旧证书
#   env 文件需含：CF_API_TOKEN（权限：Zone → SSL and Certificates → Edit，只授权本 zone）、CF_ZONE_ID（域名概览页右下角 Zone ID）
# 每步输出「✅ 通过 ｜ …」或「❌ 失败 ｜ …」；不打印令牌与私钥。
set -uo pipefail
ENVFILE=""; RENEW=0
while [ $# -gt 0 ]; do case "$1" in --env-file) ENVFILE=${2:?}; shift ;; --renew) RENEW=1 ;; *) echo "未知参数 $1"; exit 2 ;; esac; shift; done
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; exit 1; }
[ -n "$ENVFILE" ] && [ -r "$ENVFILE" ] || fail "缺少 --env-file（含 CF_API_TOKEN 与 CF_ZONE_ID）"
val() { { grep -E "^$1=" "$ENVFILE" || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
TOKEN=$(val CF_API_TOKEN); ZONE=$(val CF_ZONE_ID)
[ -n "$TOKEN" ] || fail "env 文件缺 CF_API_TOKEN"
[[ "$ZONE" =~ ^[0-9a-f]{32}$ ]] || fail "CF_ZONE_ID 须为 32 位十六进制"
command -v openssl >/dev/null && command -v python3 >/dev/null && command -v curl >/dev/null || fail "需要 openssl / python3 / curl"

DIR="$HOME/bydp-keys/aop"; mkdir -p "$DIR"; chmod 700 "$DIR"; umask 077
issue_client() {
  openssl req -newkey rsa:2048 -nodes -subj "/CN=BYDP Cloudflare Origin Pull" -keyout "$DIR/client.key" -out "$DIR/client.csr" >/dev/null 2>&1 || fail "生成客户端密钥失败"
  printf 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n' > "$DIR/ext.cnf"
  openssl x509 -req -in "$DIR/client.csr" -CA "$DIR/ca.pem" -CAkey "$DIR/ca.key" -CAcreateserial -days 825 -extfile "$DIR/ext.cnf" -out "$DIR/client.pem" >/dev/null 2>&1 || fail "签发客户端证书失败"
  rm -f "$DIR/client.csr" "$DIR/ext.cnf"
}
if [ ! -s "$DIR/ca.pem" ]; then
  [ $RENEW = 1 ] && fail "没有已生成的 CA（$DIR/ca.pem），换证须沿用原 CA；首次请去掉 --renew"
  openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -subj "/CN=BYDP Origin Pull CA" -keyout "$DIR/ca.key" -out "$DIR/ca.pem" >/dev/null 2>&1 || fail "生成 CA 失败"
  issue_client
  pass "本机生成回源 CA 与客户端证书（$DIR；私钥只在本机）"
elif [ $RENEW = 1 ] || [ ! -s "$DIR/client.pem" ]; then
  issue_client
  pass "沿用原 CA，签发新的客户端证书（有效 825 天，到期日 $(openssl x509 -in "$DIR/client.pem" -noout -enddate | cut -d= -f2)）"
else
  pass "沿用已生成的回源证书（$DIR）"
fi

api() { curl -sS --max-time 30 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
BODY=$(python3 -c 'import json,sys; print(json.dumps({"certificate": open(sys.argv[1]).read(), "private_key": open(sys.argv[2]).read()}))' "$DIR/client.pem" "$DIR/client.key")
R=$(api -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/origin_tls_client_auth" --data "$BODY")
unset BODY
echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)' 2>/dev/null \
  || fail "上传客户端证书失败：$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("; ".join(e.get("message","") for e in d.get("errors",[]))[:200])' 2>/dev/null)"
NEW_ID=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])')
pass "客户端证书已上传到本 zone"
if [ $RENEW = 1 ]; then
  # 换证：新证书生效后删除本 zone 其余旧证书（避免过期证书残留）
  for old in $(api "https://api.cloudflare.com/client/v4/zones/$ZONE/origin_tls_client_auth" | python3 -c 'import json,sys; [print(c["id"]) for c in json.load(sys.stdin).get("result",[]) if c["id"] != sys.argv[1]]' "$NEW_ID"); do
    api -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE/origin_tls_client_auth/$old" >/dev/null && pass "已删除旧客户端证书 ${old:0:8}…"
  done
fi
R=$(api -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE/origin_tls_client_auth/settings" --data '{"enabled":true}')
echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") and d["result"].get("enabled") else 1)' 2>/dev/null || fail "开启 zone 级 AOP 失败"
pass "本 zone 已开启 Authenticated Origin Pulls"
unset TOKEN
echo
echo "下一步：把 $DIR/ca.pem 交给开发（这是公开的 CA 证书，不是私钥），放到服务器 deploy/aop-ca.pem，"
echo "并在 .env.prod.input 设 CF_AOP_ENABLED=1 后重跑部署；ca.key / client.key 只留在本机（可离线备份）。"
