import type { NextConfig } from 'next';

/**
 * 运营后台（admin 契约 v0.2）：与 web 同域挂在 /admin 下（Caddy 按路径转发），共用 Auth.js 会话 cookie；
 * 服务端把会话令牌作为 Bearer 转发给 api `/admin/v1/*`，本应用不直连数据库（ADR-0005 / 0006）。
 */
const nextConfig: NextConfig = {
  basePath: '/admin',
  poweredByHeader: false,
  reactStrictMode: true,
  // 数据请求脱敏件上传（单个 ≤ 20MB，与 core 同口径）
  experimental: { serverActions: { bodySizeLimit: '21mb' } },
  // 防点击劫持：后台页面不允许被任何站点嵌入
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }] }];
  },
};

export default nextConfig;
