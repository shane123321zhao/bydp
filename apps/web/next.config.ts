import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
  // workspace 包以 TS 源码导出
  transpilePackages: ['@bydp/core', '@bydp/db', '@bydp/entity-graph', '@bydp/scoring'],
  serverExternalPackages: ['postgres'],
  poweredByHeader: false,
  reactStrictMode: true,
  // 05 投诉：证据随表单提交（单个 ≤ 20MB，与 core / api 同口径；每次最多 1 个文件 + 交易哈希）
  experimental: { serverActions: { bodySizeLimit: '21mb' } },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
