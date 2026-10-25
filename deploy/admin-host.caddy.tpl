# D-020 #3（HANDOVER §9 #22 / #4）：后台独立子域。bootstrap 仅在 .env.prod.input 配置 ADMIN_HOST 时生成 admin-host.caddy（= 本模板），否则为空。
# - 只暴露后台（/admin → admin）与登录（/login、/api/auth/* → auth-admin 实例）；主站其他页面（含 UGC）不与后台同源。
# - 网络层：Cloudflare Access 覆盖整个后台子域（docs/ops/cloudflare-access.md），源站只接受 Cloudflare 回源（firewall-cloudflare.sh）。
{$ADMIN_HOST} {
	import env_tls
	encode zstd gzip
	@not_cloudflare not remote_ip {$CF_TRUSTED_PROXIES}
	request_header @not_cloudflare -CF-IPCountry
	request_header @not_cloudflare -CF-Connecting-IP
	header {
		X-Robots-Tag "noindex, nofollow"
		Strict-Transport-Security "max-age=31536000"
		X-Frame-Options "DENY"
		-Server
	}
	# D-020 #30：每个请求先由 api 校验 Cloudflare Access JWT（只认我们 team 域签发、aud = 后台 Access 应用）；不通过 403。
	# 防他人 Cloudflare 账号把域名指向本源站并改写 Host 绕过 Access（审核 D-020 #2–#5 复核第 1 条）
	forward_auth api:8787 {
		uri /internal/access-check
		header_up -Cookie
	}
	redir / /admin
	@admin path /admin /admin/*
	handle @admin {
		reverse_proxy admin:3200 {
			header_up CF-Connecting-IP {client_ip}
		}
	}
	@auth path /login /*/login /regions /*/regions /api/auth/* /_next/* /icon.svg
	handle @auth {
		reverse_proxy auth-admin:3100 {
			header_up CF-Connecting-IP {client_ip}
		}
	}
	handle {
		respond "Not Found" 404
	}
}
