import type { Metadata, Viewport } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '../../i18n/routing';
import { Nav } from '../../components/Nav';
import { viewerSelfExclusion } from '../../lib/viewer';
import { THEME_BOOT } from '../../components/Theme';
import { LangBanner } from '../../components/LangBanner';
import { IS_STAGING, StagingMark } from '../../components/StagingMark';
import { SITE, TRANSLATED } from '../../lib/seo';
import type { Locale } from '../../i18n/routing';
import '../../styles/tokens.css';
import '../../styles/app.css';
// 数字字体 Space Grotesk 自托管（design-system §14 / D-004）：构建与运行不依赖 Google Fonts；只取拉丁子集 500 / 700
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-700.css';

// 中文用系统字体栈（iOS PingFang SC / Android Noto Sans CJK SC / Windows 微软雅黑）：
// Noto Sans SC 网络字体产生 ~100KB 阻塞渲染 CSS + 大量字体分片，移动端 LCP ~7.7s，达不到 Lighthouse ≥ 90（见 to-po）

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return {
    metadataBase: new URL(SITE),
    // D-009：测试环境标题带「测试环境」前缀，且全站 noindex
    title: IS_STAGING
      ? { default: '【测试环境】BYDP 博弈点评 · 存前一查', template: '【测试环境】%s · BYDP 博弈点评' }
      : { default: 'BYDP 博弈点评 · 存前一查', template: '%s · BYDP 博弈点评' },
    description: '黑盘识别、仿冒识别、出款表现与仲裁记录——存钱前先查一下。不向中国大陆居民提供服务。',
    // 未定稿译本的语言页不收录（审查 #12）
    ...(IS_STAGING
      ? { robots: { index: false, follow: false } }
      : TRANSLATED.includes(locale as Locale)
        ? {}
        : { robots: { index: false, follow: true } }),
  };
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return (
    <html lang={locale} data-accent="green" data-bg="night" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <NextIntlClientProvider>
          <div className="app">
            <StagingMark />
            <LangBanner locale={locale} />
            {children}
          </div>
          <Nav hideOffers={!!(await viewerSelfExclusion())} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
