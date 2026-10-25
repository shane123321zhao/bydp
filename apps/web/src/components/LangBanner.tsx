import { headers } from 'next/headers';
import { PREFIX, type Locale } from '../i18n/routing';

/** 不按 IP / 浏览器语言自动跳转（rules/seo-page.md）：浏览器偏好与当前语言不同则横幅提示 */
const LABEL: Record<Locale, string> = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English' };
export async function LangBanner({ locale }: { locale: string }) {
  const al = ((await headers()).get('accept-language') ?? '').toLowerCase();
  const pref: Locale | null = /zh-(tw|hk|mo|hant)/.test(al) ? 'zh-Hant' : /^en/.test(al) ? 'en' : null;
  if (!pref || pref === locale) return null;
  return (
    <aside className="lang-banner glass" aria-label="语言">
      <span>检测到你的浏览器偏好 {LABEL[pref]}</span>
      <a className="link" href={PREFIX[pref] || '/'}>
        切换
      </a>
    </aside>
  );
}
