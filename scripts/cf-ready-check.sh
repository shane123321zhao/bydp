#!/usr/bin/env bash
# Cloudflare 就绪自检（HANDOVER §9 #2 / #3 · D-020）：每项输出「✅ 通过 ｜ …」或「❌ 失败 ｜ …」，有失败则退出码 1。
# 用法（任意电脑，需 curl + python3）：
#   bash scripts/cf-ready-check.sh <域名> <源站公网 IP> [--admin <后台子域>] [--server]
#     --admin   另查后台子域：经 Cloudflare 代理、未登录 Access 时被拦（跳转 Cloudflare Access 登录）
#     --server  在源站服务器 ~/bydp 内执行，另查防火墙（IPv4 / IPv6）与 Caddy 配置
# 不读取、不打印任何密钥；只看状态码与响应头。
set -uo pipefail
DOMAIN=${1:?用法：cf-ready-check.sh <域名> <源站 IP> [--admin <后台子域>] [--server]}
ORIGIN=${2:?缺源站 IP}
shift 2
SERVER=""; ADMIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER=--server ;;
    --admin) ADMIN=${2:?--admin 后须跟后台子域}; shift ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
  shift
done
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FAILS=0
pass() { printf '✅ 通过 ｜ %s\n' "$1"; }
fail() { printf '❌ 失败 ｜ %s\n' "$1"; FAILS=$((FAILS + 1)); }

# ① DNS：域名解析出的全部地址都在 Cloudflare 回源段内（= 已开橙云代理，源站 IP 不暴露）
dns_check() {
  local host=$1 out
  out=$(python3 - "$host" "$ROOT/deploy/cloudflare-ips.txt" <<'PY'
import ipaddress, json, socket, sys, urllib.request
nets = [ipaddress.ip_network(l.strip()) for l in open(sys.argv[2]) if l.strip() and not l.startswith('#')]
# 用 DoH（Cloudflare 1.1.1.1）查公网解析：本机代理软件常把 DNS 改成 198.18.x 假 IP，不能用本机解析判断
addrs = []
for t in ('A', 'AAAA'):
    try:
        req = urllib.request.Request(f'https://cloudflare-dns.com/dns-query?name={sys.argv[1]}&type={t}', headers={'accept': 'application/dns-json'})
        for ans in json.load(urllib.request.urlopen(req, timeout=10)).get('Answer', []):
            if ans.get('type') in (1, 28): addrs.append(ans['data'])
    except Exception:
        pass
if not addrs:
    try:
        addrs = [a[4][0] for a in socket.getaddrinfo(sys.argv[1], 443, proto=socket.IPPROTO_TCP)]
    except socket.gaierror:
        print('NXDOMAIN'); sys.exit()
addrs = sorted(set(addrs))
bad = [a for a in addrs if not any(ipaddress.ip_address(a) in n for n in nets)]
print(('OK ' if addrs and not bad else 'BAD ') + str(len(addrs)) + ' ' + ' '.join(bad))
PY
)
  case "$out" in
    OK*) pass "DNS：$host 的 $(echo "$out" | awk '{print $2}') 个地址都属 Cloudflare（橙云代理已开）" ;;
    NXDOMAIN) fail "DNS：$host 无解析" ;;
    *) fail "DNS：$host 有地址不属 Cloudflare（源站 IP 暴露 / 未开代理）：$(echo "$out" | cut -d' ' -f3-)" ;;
  esac
}
dns_check "$DOMAIN"

# ② 经 Cloudflare 访问：响应头带 cf-ray
H=$(curl -sS -o /dev/null -D - --max-time 15 "https://$DOMAIN/" 2>/dev/null | tr -d '\r')
CODE=$(printf '%s\n' "$H" | awk 'toupper($1) ~ /^HTTP/{c=$2} END{print c}')
if printf '%s\n' "$H" | grep -qi '^cf-ray:'; then pass "经 Cloudflare 访问正常（HTTP ${CODE:-?}，带 cf-ray）"
else fail "经 Cloudflare 访问：响应无 cf-ray（HTTP ${CODE:-无响应}）——流量没有经过 Cloudflare"; fi

# ③④ 直连源站 443 / 80 应被防火墙丢弃（连接超时或被拒）
for port in 443 80; do
  scheme=$([ $port = 443 ] && echo https || echo http)
  # 连续两次都连不上才算被拒（单次网络抖动不能当作防火墙生效）
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -k --resolve "$DOMAIN:$port:$ORIGIN" "$scheme://$DOMAIN:$port/" 2>/dev/null)
  [ "$c" = "000" ] && c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -k --resolve "$DOMAIN:$port:$ORIGIN" "$scheme://$DOMAIN:$port/" 2>/dev/null)
  if [ "$c" = "000" ]; then pass "直连源站 $ORIGIN:$port 被拒（只接受 Cloudflare 回源）"
  else fail "直连源站 $ORIGIN:$port 仍可访问（HTTP $c）——源站防火墙未生效：sudo bash deploy/firewall-cloudflare.sh --persist"; fi
done

# ⑤ 客户端伪造 CF-IPCountry 无效：经 Cloudflare 请求首页（/regions 本身豁免地区判断，不能用来测），带与不带伪造 CN 结果应一致
#    （测试者若本身在中国大陆，两者都会是 451——同样一致；源站直连带伪造头的情形由 ③④ 防火墙覆盖）
c1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/")
c2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H 'CF-IPCountry: CN' -H 'CF-Connecting-IP: 203.0.113.9' "https://$DOMAIN/")
if [ "$c1" = "$c2" ]; then pass "伪造 CF-IPCountry / CF-Connecting-IP 不改变结果（均为 HTTP $c1）"
else fail "伪造国家头改变了结果（正常 $c1 / 伪造 $c2）——国家头未按回源值处理"; fi

# ⑥ 证书：经 Cloudflare 的 HTTPS 能建立（Full (strict) 下源站证书无效会是 525 / 526）
case "$CODE" in 525|526) fail "源站证书无效（HTTP $CODE）：见 cloudflare-access.md 第 2 节「先灰云签证书再开橙云」" ;; "") ;; *) pass "源站证书有效（未出现 525 / 526）" ;; esac

# ⑦ 后台子域：经代理；未通过 Access 时应被拦（302 到 *.cloudflareaccess.com）
if [ -n "$ADMIN" ]; then
  dns_check "$ADMIN"
  loc=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "https://$ADMIN/admin")
  case "$loc" in
    30[0-9]\ *cloudflareaccess.com*) pass "后台 $ADMIN 未登录 Access 时被拦（跳转 Cloudflare Access 登录）" ;;
    *) fail "后台 $ADMIN 未被 Cloudflare Access 拦截（HTTP ${loc%% *}）——检查 Zero Trust → Access → Applications" ;;
  esac
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -k --resolve "$ADMIN:443:$ORIGIN" "https://$ADMIN/admin" 2>/dev/null)
  [ "$c" = "000" ] && pass "直连源站访问后台被拒" || fail "直连源站可访问后台（HTTP $c）——源站防火墙未生效"
fi

if [ "$SERVER" = "--server" ]; then
  cd "$ROOT/deploy" 2>/dev/null || { fail "未在源站代码目录"; exit 1; }
  n=$(sudo iptables -S BYDP-CF 2>/dev/null | grep -c RETURN || true)
  j=$(sudo iptables -S DOCKER-USER 2>/dev/null | grep -c 'BYDP-CF' || true)
  if [ "${n:-0}" -ge 10 ] && [ "${j:-0}" -ge 2 ]; then pass "源站防火墙：BYDP-CF 链 $n 段 · DOCKER-USER 80/443 已挂接"
  else fail "源站防火墙未就绪（BYDP-CF $n 段 · 挂接 $j）：sudo bash deploy/firewall-cloudflare.sh --persist"; fi
  if sudo ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE '^\[::\]:(80|443)$|^\*:(80|443)$'; then fail "80/443 在 IPv6 上监听（会绕过防火墙）：compose 端口须绑 0.0.0.0"
  else pass "80/443 只在 IPv4 监听（IPv6 无法绕过防火墙）"; fi
  systemctl is-enabled bydp-cf-firewall.service >/dev/null 2>&1 && pass "防火墙开机自动重放已启用" || fail "防火墙未设开机重放（--persist）"
  t=$(grep -E '^CF_TRUSTED_PROXIES=' .env.prod 2>/dev/null | cut -d= -f2- | wc -w | tr -d ' ')
  if [ "${t:-0}" -ge 10 ]; then pass "Caddy 信任 Cloudflare 回源段 $t 段（.env.prod CF_TRUSTED_PROXIES）"
  else fail "Caddy 未配置 Cloudflare 回源段（.env.prod.input 设 BYDP_BEHIND_CLOUDFLARE=1 后重跑 bootstrap）"; fi
  # D-020 #31：AOP 开启时，本机直连源站（不经防火墙、不带回源客户端证书）TLS 握手必须失败
  if grep -qE '^CF_AOP_ENABLED="?1"?$' .env.prod 2>/dev/null; then
    # 按 curl 退出码判断：35 / 56 = TLS 握手被拒（通过）；7 = 连不上（Caddy 未运行 / 端口不通，不能当作通过）；0 = 竟然能访问
    curl -s -o /dev/null --max-time 8 -k --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" 2>/dev/null; rc=$?
    case $rc in
      35|56) pass "AOP：不带回源客户端证书的 TLS 握手被拒" ;;
      0) fail "AOP 已开启但无客户端证书仍可访问——检查 aop.caddy 与 Caddy 热加载" ;;
      7) fail "AOP 检查无法进行：Caddy 未运行或 443 端口不通（curl 退出码 7）" ;;
      *) fail "AOP 检查结果不明（curl 退出码 $rc）" ;;
    esac
  fi
  docker compose -f compose.prod.yml --env-file .env.prod exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    && pass "Caddy 配置校验通过" || fail "Caddy 配置校验失败"
fi

[ "$FAILS" -eq 0 ] && echo "—— 全部通过" || { echo "—— $FAILS 项失败"; exit 1; }
