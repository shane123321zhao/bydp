import { brandDetail } from '../../../../lib/brand';
import { brandMetadata } from '../../../../lib/brand-meta';
import { href, SITE } from '../../../../lib/seo';
import { Icon } from '../../../../components/Icon';
import { BarRow, Dense, Head, Kpis } from '../../../../components/atoms';

export const generateMetadata = ({ params }: { params: Promise<{ locale: string; slug: string }> }) => brandMetadata(params, '');

export default async function Overview({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const L = (p: string) => href(locale, p);
  const b = (await brandDetail(slug))!;
  const { getBrandScore } = await import('@bydp/core/usecases');
  const { db } = await import('../../../../lib/db');
  const s = await getBrandScore(db(), slug);
  const factors = s?.factors ?? [];
  const reviews = factors.find((f) => f.key === 'playerReviews')?.sampleSize;
  const years = b.operator?.foundedYear ? new Date().getFullYear() - b.operator.foundedYear : null;
  // 结构化数据：Organization + AggregateRating（仅认证 / 观察且有评分，rules/seo-page.md）
  // 审查 #9：ratingCount 必须是真实样本数，缺样本就不输出 AggregateRating（不占位）
  const rated = b.status !== 'blacklist' && s?.score != null && (reviews ?? 0) > 0;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: b.name.zhHans,
    alternateName: b.name.en,
    url: `${SITE}/brand/${slug}`,
    ...(rated ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: s!.score, bestRating: 100, worstRating: 0, ratingCount: reviews } } : {}),
  };
  return (
    <section className="card glass rise" style={{ minHeight: 300 }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') /* 审查 #8：防 </script> 注入 */ }} />
      <Head title="评分因子" sub={b.status === 'blacklist' ? '黑名单不计分' : `${s?.factorsAvailable ?? 0}/${s?.factorsTotal ?? 5} 可用 · ${s?.algorithmVersion ?? ''}`} />
      <Kpis
        items={[
          { v: `${s?.factorsAvailable ?? 0}/${s?.factorsTotal ?? 5}`, k: '因子可用', tone: (s?.factorsAvailable ?? 0) >= 5 ? 'green' : 'amber' },
          ...(reviews != null ? [{ v: reviews.toLocaleString('en-US'), k: '可信评价' }] : []),
          ...(years != null ? [{ v: `${years} 年`, k: '运营年限' }] : []),
        ]}
      />
      {factors.length ? (
        <Dense
          items={factors}
          render={(f, i) => (
            <BarRow
              key={i}
              a={f.label ?? ''}
              b={f.detail}
              pct={f.score ?? 0}
              tone={f.available ? ((f.score ?? 0) >= 75 ? 'green' : 'amber') : 'muted'}
              tag={f.available ? `${f.score} · ${f.weight}%` : '样本不足'}
              link={
                f.key === 'playerReviews' ? (
                  <a className="link" href={L(`/me/review?b=${slug}`)} style={{ fontSize: 12 }}>
                    写评价 <Icon n="chev" s={12} />
                  </a>
                ) : undefined
              }
            />
          )}
        />
      ) : (
        <p className="adv">暂无评分快照。</p>
      )}
    </section>
  );
}
