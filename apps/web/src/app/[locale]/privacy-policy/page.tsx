import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates, href } from '../../../lib/seo';
import { TrustPage } from '../../../components/TrustPage';
import { Markdown } from '../../../components/Markdown';
import { loadLegal } from '../../../lib/legal';

export const dynamic = 'force-dynamic';

/** D-021：正文取自 docs/legal（草稿）。上线放行前为草稿：顶部提示 + noindex；【待替换】【待定】照原样显示 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '隐私政策', alternates: alternates(locale as Locale, '/privacy-policy'), robots: { index: false, follow: true } };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const L = (p: string) => href(locale, p);
  return (
    <TrustPage locale={locale} title="隐私政策" sub="收集什么 · 如何使用 · 保存多久 · 你的权利 · Cookie">
      <p className="adv">草稿，上线前补全：文中【待替换】【待定】处将在上线前按实际信息填写；在此之前以简体草稿为准。</p>
      <Markdown blocks={loadLegal('privacy')} L={L} />
    </TrustPage>
  );
}
