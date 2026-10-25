import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates } from '../../../lib/seo';
import { ListView } from '../../../components/ListView';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '持牌名单 · 牌照核验', alternates: alternates(locale as Locale, '/licensed') };
}

export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ region?: string; sort?: string; q?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  return <ListView locale={locale} lib="licensed" {...(sp.region ? { region: sp.region } : {})} {...(sp.sort ? { sort: sp.sort } : {})} {...(typeof sp.q === 'string' && sp.q ? { q: sp.q } : {})} />;
}
