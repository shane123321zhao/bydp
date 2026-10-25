import { redirect } from 'next/navigation';
import { href } from '../../../lib/seo';

/** 表单 GET /check?q= → /check/{identifier}（SEO 路由，rules/seo-page.md） */
export default async function CheckForm({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string }> }) {
  const { locale } = await params;
  const q = ((await searchParams).q ?? '').trim().slice(0, 256);
  redirect(q ? href(locale, `/check/${encodeURIComponent(q)}`) : href(locale, '/'));
}
