import type { MetadataRoute } from 'next';

/**
 * robots.txt（D-009）：只有正式环境（BYDP_ENV=production）允许收录；测试 / 本地 / CI 一律全站 Disallow。
 * 按运行时环境变量决定（同一镜像不同环境不会串）。
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  if (process.env.BYDP_ENV === 'production') return { rules: { userAgent: '*', allow: '/' } };
  return { rules: { userAgent: '*', disallow: '/' } };
}
