import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates } from '../../../lib/seo';
import { TrustPage } from '../../../components/TrustPage';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '服务地区与大陆排除声明', alternates: alternates(locale as Locale, '/regions') };
}

export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ blocked?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const blocked = (await searchParams).blocked === "1";
  return (
    <TrustPage locale={locale} title="服务地区" sub="服务范围 · 大陆排除 · 18+">
      {blocked ? (
        <p style={{ color: "var(--red)", fontWeight: 700 }}>你所在的地区不在服务范围内，本站内容不向中国大陆居民提供。</p>
      ) : null}
      <h2>不向中国大陆居民提供服务</h2>
      <p>BYDP 永久不面向中国大陆提供服务，不做面向大陆的内容与投放。本声明在全站、Telegram Bot 与所有终端常驻展示。</p>
      <h2>首发服务地区</h2>
      <p>新加坡、马来西亚、菲律宾、泰国、越南、柬埔寨等东南亚华语区，以及香港、澳门、台湾。</p>
      <h2>年龄与负责任博彩</h2>
      <p>仅限 18 岁及以上。本站提供自我排除与防沉迷入口；不宣传「稳定获利策略」。</p>
      <h2>隐私</h2>
      <p>首发市场适用新加坡 PDPA、马来西亚 PDPA 与台湾个资法。用户可请求脱敏或删除个人证据原文；证据哈希与状态日志按审计要求保留。</p>
    </TrustPage>
  );
}
