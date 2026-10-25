import { defineRouting } from 'next-intl/routing';

/**
 * 架构 §11 / ADR-0004：简体 `/`（zh-Hans）· 繁体 `/zh-hant/`（台湾口径）· 英文 `/en/`。
 * 不按 IP / Accept-Language 自动跳转（rules/seo-page.md），用横幅提示切换。
 */
export const routing = defineRouting({
  locales: ['zh-Hans', 'zh-Hant', 'en'],
  defaultLocale: 'zh-Hans',
  localePrefix: { mode: 'as-needed', prefixes: { 'zh-Hant': '/zh-hant', en: '/en' } },
  localeDetection: false,
  alternateLinks: false, // hreflang 由页面 metadata 输出（含 x-default）
});
export type Locale = (typeof routing.locales)[number];
export const HREFLANG: Record<Locale, string> = { 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant', en: 'en' };
export const PREFIX: Record<Locale, string> = { 'zh-Hans': '', 'zh-Hant': '/zh-hant', en: '/en' };
