#!/usr/bin/env bash
# D-020 #31 Authenticated Origin Pulls：生成 Caddy 片段 aop.caddy（定义 (env_tls)，主站与后台站点均 import）。
# 用法：bash deploy/gen-aop.sh <CF_AOP_ENABLED 值> <CA 证书文件> <输出文件>
# - 开关非 1：片段为空（与未接入 AOP 时的配置完全一致）；
# - 开关为 1：CA 文件必须存在且是合法的 PEM 证书，否则退出码 1（失败即关：避免「开了却没生效」）；
#   片段要求 TLS 客户端证书（require_and_verify），只信任该 CA——即只接受带我方 zone 证书（或 Cloudflare 回源证书）的回源连接。
set -euo pipefail
ENABLED=${1:-0}; CA=${2:?缺 CA 文件路径}; OUT=${3:?缺输出文件}
if [ "$ENABLED" != "1" ]; then
  printf '# CF_AOP_ENABLED≠1：未启用 Authenticated Origin Pulls\n(env_tls) {\n}\n' > "$OUT"
  exit 0
fi
[ -s "$CA" ] || { echo "❌ 失败 ｜ CF_AOP_ENABLED=1 但缺回源 CA 证书 $(basename "$CA")（见 docs/ops/cloudflare-access.md「AOP」）"; exit 1; }
openssl x509 -in "$CA" -noout >/dev/null 2>&1 || { echo "❌ 失败 ｜ $(basename "$CA") 不是合法的 PEM 证书"; exit 1; }
cat > "$OUT" <<'SNIP'
# CF_AOP_ENABLED=1：只接受出示回源客户端证书（由 aop-ca.pem 签发）的 TLS 连接——直连源站或他人 Cloudflare 账号的回源握手失败
(env_tls) {
	tls {
		client_auth {
			mode require_and_verify
			trust_pool file {
				pem_file /etc/caddy/aop-ca.pem
			}
		}
	}
}
SNIP
echo "✅ 通过 ｜ AOP 已启用（CA：$(openssl x509 -in "$CA" -noout -subject 2>/dev/null | sed 's/^subject=//' | cut -c1-80)）"
