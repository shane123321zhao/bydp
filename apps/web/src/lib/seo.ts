import type { Metadata } from 'next';
import { HREFLANG, PREFIX, type Locale } from '../i18n/routing';

/**
 * 站点绝对地址（canonical / hreflang / 结构化数据）。D-025 发现：部署从未设置 NEXT_PUBLIC_SITE_URL（构建期内联），线上 canonical 落到 localhost。
 * 现按优先级取：NEXT_PUBLIC_SITE_URL → 运行期 AUTH_URL（bootstrap 由 SITE_DOMAIN 派生为 https://<域名>）→ 本地开发默认。仅服务端组件使用。
 */
export const SITE = (process.env.NEXT_PUBLIC_SITE_URL || process.env.AUTH_URL || 'http://localhost:3100').replace(/\/+$/, '');

/** hreflang：zh-Hans `/`、zh-Hant `/zh-hant/`、en `/en/` + x-default（rules/seo-page.md） */
/**
 * 已人工定稿译本的语言（rules/i18n.md）。M1 只有简体源文：繁 / 英路由可访问但 noindex，且不在 hreflang 中声明，
 * 避免未翻译的重复页被当成其他语言收录（审查 #12）。M3 译本入库后在此追加。
 */
export const TRANSLATED: readonly Locale[] = ['zh-Hans'];

export function alternates(locale: Locale, path: string): Metadata['alternates'] {
  const p = path === '/' ? '' : path;
  const languages = Object.fromEntries(TRANSLATED.map((l) => [HREFLANG[l], `${SITE}${PREFIX[l]}${p || '/'}`]));
  return { canonical: `${SITE}${PREFIX[locale]}${p || '/'}`, languages: { ...languages, 'x-default': `${SITE}${p || '/'}` } };
}

export function href(locale: string, path: string) {
  return `${PREFIX[locale as Locale] ?? ''}${path}`;
}
