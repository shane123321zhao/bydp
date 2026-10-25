import { getBrandComplaints } from '@bydp/core/usecases';
import { db } from '../../../../../lib/db';
import { brandMetadata } from '../../../../../lib/brand-meta';
import { BarRow, Dense, Head, Kpis } from '../../../../../components/atoms';
import { Icon } from '../../../../../components/Icon';

export const generateMetadata = ({ params }: { params: Promise<{ locale: string; slug: string }> }) => brandMetadata(params, 'complaints');

const STATUS: Record<string, [string, 'green' | 'red' | 'amber' | 'muted']> = {
  resolved: ['已解决', 'green'],
  exposed: ['已曝光', 'red'],
  unresolved: ['未解决', 'red'],
  rejected: ['驳回', 'muted'],
  arbitrating: ['仲裁中', 'amber'],
  awaiting_reply: ['待答辩', 'amber'],
  accepted: ['已受理', 'amber'],
  screening: ['待初筛', 'muted'],
};

export default async function Complaints({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string }> }) {
  const { slug } = await params;
  // D-019：相关案件搜索——只搜该品牌已公开案件的公开标题与公开描述（索引不含原文）
  const raw = (await searchParams).q;
  const query = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
  const p = (await getBrandComplaints(db(), slug, undefined, query || undefined))!;
  const st = p.stats ?? {};
  return (
    <section className="card glass rise" style={{ minHeight: 300 }}>
      <Head title="投诉案件" sub={`${st.total ?? 0} 件 · 公开摘要`} />
      <Kpis
        items={[
          { v: st.total ?? 0, k: '公开案件' },
          ...(st.resolveRate != null ? [{ v: `${Math.round(st.resolveRate * 1000) / 10}%`, k: '解决率', tone: st.resolveRate >= 0.75 ? ('green' as const) : ('amber' as const) }] : []),
          ...(st.medianResponseDays != null ? [{ v: `${st.medianResponseDays} 天`, k: '中位响应' }] : []),
        ]}
      />
      {(st.total ?? 0) > 0 ? (
        <form method="get" role="search" className="glass" style={{ minHeight: 36, borderRadius: 'var(--r-pill)', display: 'flex', alignItems: 'center', gap: 'var(--s-4)', padding: '0 var(--s-6)', margin: 'var(--s-4) 0' }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon n="search" s={13} w={2.4} />
          </span>
          <input name="q" defaultValue={query} maxLength={100} placeholder="搜索相关案件（标题 / 公开描述）" aria-label="搜索相关案件" style={{ flexGrow: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--ink)', font: 'inherit', fontSize: 13 }} />
          {query ? (
            <a href="?" style={{ fontSize: 12, color: 'var(--muted)' }}>
              清除
            </a>
          ) : null}
        </form>
      ) : null}
      {(p.items ?? []).length ? (
        <Dense
          items={p.items ?? []}
          render={(c, i) => {
            const [label, tone] = STATUS[c.status ?? 'screening']!;
            const end = c.resolvedAt ?? c.exposedAt;
            return (
              <BarRow key={i} a={`#${c.id}`} b={`${c.title} · ${(c.amountUsdt ?? 0).toLocaleString('en-US')} U · ${c.createdAt?.slice(5, 10)}${end ? ` → ${end.slice(5, 10)}` : ''}`} tone={tone} tag={label} />
            );
          }}
        />
      ) : (
        <p className="adv">{query ? `没有与「${query}」相关的公开案件。` : '暂无公开案件。'}</p>
      )}
      <a className="btn" href={`/complaint?b=${encodeURIComponent(slug)}`} style={{ marginTop: 'var(--s-6)' }}>
        我也遇到了 · 提交投诉 <Icon n="arrow" s={15} w={2.8} />
      </a>
    </section>
  );
}
