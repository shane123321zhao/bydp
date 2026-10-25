import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates } from '../../../lib/seo';
import { TrustPage } from '../../../components/TrustPage';
import { getRelatedPartyBrands } from '@bydp/core/usecases';
import { db } from '../../../lib/db';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '联盟关系与利益冲突披露', alternates: alternates(locale as Locale, '/disclosure') };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const related = await getRelatedPartyBrands(db());
  return (
    <TrustPage locale={locale} title="联盟关系披露" sub="收入来源 · 关联方 · 赞助标注">
      <p>BYDP 的主要收入来自联盟佣金。认证不收费；赞助位与独家位必须标注「赞助」，不影响评分与排序。</p>
      <h2>关联方</h2>
      <p>与创始人存在关联的运营商、游戏商可被收录并在品牌页公开披露，但永不进入认证库、永不结算佣金、不接入优惠码付费独家位。</p>
      {related.length ? (
        <>
          <h2>当前已披露的关联方品牌</h2>
          <ul>{related.map((b) => (<li key={b.slug}><a href={`/brand/${b.slug}`}>{b.name}</a></li>))}</ul>
        </>
      ) : null}
      <h2>黑名单</h2>
      <p>黑名单品牌永不接入商业合作，不结算佣金。</p>
    </TrustPage>
  );
}
