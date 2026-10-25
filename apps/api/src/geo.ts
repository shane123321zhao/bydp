/**
 * 大陆屏蔽应用层兜底（ADR-0007 / 架构 §2）：边缘 WAF 为主，此处读 CF-IPCountry 再拦一次。
 * 与语言逻辑解耦；451 Unavailable For Legal Reasons，响应体带服务地区声明链接。
 */
import type { MiddlewareHandler } from 'hono';

export const geoBlockedCountries = (env = process.env.GEO_BLOCK_COUNTRIES) => (env ?? 'CN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

/** exemptPrefixes：豁免路径前缀（D-008 #1：仅 /v1/postback/，由该路由自行记录来源地区） */
export function geoBlock(countries = geoBlockedCountries(), exemptPrefixes: string[] = []): MiddlewareHandler {
  const blocked = new Set(countries);
  return async (c, next) => {
    if (exemptPrefixes.some((p) => c.req.path.startsWith(p))) return next();
    const cc = c.req.header('CF-IPCountry')?.toUpperCase();
    if (cc && blocked.has(cc)) {
      return c.json({ error: 'region_unavailable', message: '本服务不向中国大陆居民提供。', regions: '/regions' }, 451);
    }
    await next();
  };
}
