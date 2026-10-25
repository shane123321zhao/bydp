#!/usr/bin/env bash
# 源站防火墙（HANDOVER §9 #2 · D-020）：宿主 80 / 443 只接受 Cloudflare 回源 IP 的新连接；SSH（2222）由主机 sshd 监听，不受本脚本影响。
# - Docker 发布的端口绕过 ufw / INPUT 链，规则放在 DOCKER-USER 链：经外网网卡进入、**原始目的端口**（DNAT 前，--ctorigdstport）
#   为 80 / 443 的新连接 → BYDP-CF 子链：Cloudflare 段放行，其余丢弃。容器主动出网不经外网网卡进入，不受影响。
# - compose 只把 80 / 443 绑在 IPv4（0.0.0.0）：未开 Docker IPv6 时 [::]:443 会经 docker-proxy 走 INPUT 链绕过 DOCKER-USER（自检 I1），
#   所以 IPv6 不对外提供 80 / 443；ip6tables 规则仅在 Docker 启用了 ip6tables 时作为兜底挂接。
# 用法（服务器上，需 sudo）：
#   bash deploy/firewall-cloudflare.sh                 # 只打印将执行的规则（默认，不改动）
#   sudo bash deploy/firewall-cloudflare.sh --apply    # 应用（幂等；重复执行刷新为最新回源段）
#   sudo bash deploy/firewall-cloudflare.sh --persist  # 应用并装 systemd 单元，开机 / Docker 重启后自动重放
#   sudo bash deploy/firewall-cloudflare.sh --remove   # 撤销（含 systemd 单元；演练回滚用）
# **只在站点已切到 Cloudflare 代理后执行**；测试站（直连）执行会把所有访客挡在外面。
set -euo pipefail
cd "$(dirname "$0")"
MODE=${1:-}
CHAIN=BYDP-CF
UNIT=/etc/systemd/system/bydp-cf-firewall.service
EXT_IF=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')
[ -n "$EXT_IF" ] || { echo "❌ 失败 ｜ 找不到默认路由网卡"; exit 1; }

ranges() {
  local list
  list=$( { curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4; echo; curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6; } 2>/dev/null | grep -E '^[0-9a-f:.]+/[0-9]{1,3}$' || true)
  [ "$(printf '%s\n' "$list" | grep -c .)" -ge 10 ] || list=$(grep -E '^[0-9a-f:.]+/[0-9]{1,3}$' cloudflare-ips.txt)
  printf '%s\n' "$list"
}
hook() { echo "DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctstate NEW --ctorigdstport $1 -j $CHAIN"; }

plan() {
  local bin=$1 cidrs
  if [ "$bin" = iptables ]; then cidrs=$(ranges | grep -v ':'); else cidrs=$(ranges | grep ':'); fi
  echo "$bin -N $CHAIN 2>/dev/null || true"
  echo "$bin -F $CHAIN"
  for c in $cidrs; do echo "$bin -A $CHAIN -s $c -j RETURN"; done
  echo "$bin -A $CHAIN -j DROP"
  for p in 80 443; do echo "$bin -C $(hook $p) 2>/dev/null || $bin -I $(hook $p | sed 's/^DOCKER-USER/DOCKER-USER 1/')"; done
}

hooked() { # 该族 80 与 443 两条挂接都在
  local bin=$1
  for p in 80 443; do $bin -C $(hook $p) 2>/dev/null || return 1; done
}

remove() {
  for bin in iptables ip6tables; do
    for p in 80 443; do while $bin -D $(hook $p) 2>/dev/null; do :; done; done
    # 网卡变更后的残留挂接：按链名清理
    while read -r rule; do [ -n "$rule" ] && $bin ${rule/-A /-D } 2>/dev/null || true; done < <($bin -S DOCKER-USER 2>/dev/null | grep -- "-j $CHAIN" || true)
    $bin -F $CHAIN 2>/dev/null || true
    $bin -X $CHAIN 2>/dev/null || true
  done
}

case "$MODE" in
  "")
    echo "# 预览（未改动）：外网网卡 $EXT_IF"
    plan iptables
    plan ip6tables ;;
  --apply|--persist)
    [ "$(id -u)" = 0 ] || { echo "❌ 失败 ｜ 需 sudo"; exit 1; }
    iptables -L DOCKER-USER -n >/dev/null 2>&1 || { echo "❌ 失败 ｜ 无 DOCKER-USER 链（Docker 未运行？）"; exit 1; }
    plan iptables | bash
    hooked iptables || { echo "❌ 失败 ｜ IPv4 挂接 DOCKER-USER 未生效"; exit 1; }
    n4=$(iptables -S $CHAIN | grep -c RETURN)
    v6="IPv6 不对外提供 80/443（compose 只绑 IPv4）"
    if ip6tables -L DOCKER-USER -n >/dev/null 2>&1; then
      plan ip6tables | bash
      hooked ip6tables && v6="IPv6 兜底 $(ip6tables -S $CHAIN | grep -c RETURN) 段" || v6="IPv6 兜底挂接失败（不影响：80/443 未绑 IPv6）"
    fi
    if [ "$MODE" = --persist ]; then
      cat > "$UNIT" <<UNITEOF
[Unit]
Description=BYDP origin firewall (Cloudflare only on 80/443)
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/bin/bash $(pwd)/firewall-cloudflare.sh --apply
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNITEOF
      systemctl daemon-reload && systemctl enable bydp-cf-firewall.service >/dev/null
    fi
    echo "✅ 通过 ｜ 80/443 只放行 Cloudflare 回源段（IPv4 $n4 段 · $v6）$( [ "$MODE" = --persist ] && echo '· 已设开机自动重放')" ;;
  --remove)
    [ "$(id -u)" = 0 ] || { echo "❌ 失败 ｜ 需 sudo"; exit 1; }
    remove
    systemctl disable bydp-cf-firewall.service >/dev/null 2>&1 || true
    rm -f "$UNIT" && systemctl daemon-reload 2>/dev/null || true
    echo "✅ 通过 ｜ 已撤销源站 Cloudflare 限制（80/443 恢复对外，systemd 单元已删除）" ;;
  *) echo "用法：$0 [--apply|--persist|--remove]"; exit 2 ;;
esac
