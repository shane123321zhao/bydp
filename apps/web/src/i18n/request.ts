import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import source from '../../messages/zh-Hans.json';
import { routing } from './routing';

/**
 * 简体为源文（rules/i18n.md）。繁体 / 英文译本需 OpenCC 初转 + 人工定稿后入库（M3 本地化 Agent）；
 * 未定稿的键回退到简体源文，不机器生成、不占位。
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  let translated: Record<string, unknown> = {};
  if (locale !== 'zh-Hans') {
    translated = (await import(`../../messages/${locale}.json`).catch(() => ({ default: {} }))).default;
  }
  return { locale, messages: deepMerge(source as Record<string, unknown>, translated) };
});

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}
