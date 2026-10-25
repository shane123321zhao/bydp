import type { Metadata } from 'next';
import type { Locale } from '../i18n/routing';
import { brandDetail } from './brand';
import { alternates } from './seo';

const SUFFIX: Record<string, string> = { '': '靠谱吗', complaints: '投诉记录', withdrawal: '能出款吗', domains: '官网与仿冒站', bonus: '优惠码' };

export async function brandMetadata(params: Promise<{ locale: string; slug: string }>, tab: '' | 'complaints' | 'withdrawal' | 'domains' | 'bonus'): Promise<Metadata> {
  const { locale, slug } = await params;
  const b = await brandDetail(slug);
  if (!b) return {};
  const name = b.name.zhHans ?? b.name.en ?? slug;
  const status = { certified: '平台认证', watch: '观察', blacklist: '黑名单' }[b.status];
  return {
    title: `${name}${SUFFIX[tab]}？${status}${b.score?.score != null && b.status !== 'blacklist' ? ` · 评分 ${b.score.score}` : ''}`,
    description: `${name}（${b.name.en ?? ''}）信任状态：${status}。出款表现、仲裁记录、官方标识与关联图谱。`,
    alternates: alternates(locale as Locale, `/brand/${slug}${tab ? `/${tab}` : ''}`),
  };
}
