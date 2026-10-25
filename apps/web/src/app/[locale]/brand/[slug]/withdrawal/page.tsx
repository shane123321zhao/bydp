import { getBrandWithdrawals } from '@bydp/core/usecases';
import { db } from '../../../../../lib/db';
import { brandMetadata } from '../../../../../lib/brand-meta';
import { BarRow, Dense, Head, Kpis } from '../../../../../components/atoms';
import { Icon } from '../../../../../components/Icon';
import { href } from '../../../../../lib/seo';

export const generateMetadata = ({ params }: { params: Promise<{ locale: string; slug: string }> }) => brandMetadata(params, 'withdrawal');

const dur = (m: number) => (m < 60 ? `${Math.round(m)} 分` : m < 1440 ? `${Math.round((m / 60) * 10) / 10} 小时` : `${Math.round((m / 1440) * 10) / 10} 天`);

export default async function Withdrawal({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const w = (await getBrandWithdrawals(db(), slug))!;
  const rows = [
    ...(w.buckets ?? []).filter((b) => (b.count ?? 0) > 0).map((b) => ({ a: b.label ?? '', b: `${b.count} 份`, pct: Math.round((b.share ?? 0) * 100), tone: b.label === '拒付' ? ('red' as const) : b.label === '> 3 天' ? ('amber' as const) : ('green' as const), tag: `${Math.round((b.share ?? 0) * 100)}%` })),
    ...(w.officialChecks ?? []).map((o) => ({ a: '官方抽检', b: `${o.at?.slice(5, 10)} ${o.method} ${o.amountUsdt} U${o.minutes != null ? ` · ${dur(o.minutes)}到账` : ''}`, pct: 100, tone: 'green' as const, tag: o.id ?? '' })),
  ];
  return (
    <section className="card glass rise" style={{ minHeight: 300 }}>
      <Head
        title="出款表现"
        sub="用户凭证为主 · 官方实测抽检"
        link={
          <a className="link" href={href(locale, `/me/withdrawal-report?b=${slug}`)}>
            提交凭证 <Icon n="chev" s={12} />
          </a>
        }
      />
      <Kpis
        items={[
          ...(w.medianMinutes != null ? [{ v: dur(w.medianMinutes), k: '中位到账', tone: w.medianMinutes <= 60 ? ('green' as const) : ('amber' as const) }] : []),
          ...(w.refusalRate != null ? [{ v: `${Math.round(w.refusalRate * 1000) / 10}%`, k: '拒付率', tone: w.refusalRate > 0.05 ? ('red' as const) : ('green' as const) }] : []),
          { v: w.sampleSize ?? 0, k: '凭证样本' },
        ]}
      />
      {rows.length ? <Dense items={rows} render={(r, i) => <BarRow key={i} {...r} />} /> : <p className="adv">暂无出款报告。</p>}
    </section>
  );
}
