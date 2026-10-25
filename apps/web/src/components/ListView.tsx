import { getList, type Lib } from '@bydp/core/usecases';
import { db } from '../lib/db';
import { href } from '../lib/seo';
import { Icon } from './Icon';
import { Dense, Head, Kpis, Legal, Logo, Ring, StatusBadge, zhName } from './atoms';

export const LIB_ROUTE: Record<Lib, string> = { certified: '/certified', watch: '/watchlist', licensed: '/licensed', blacklist: '/blacklist' };
const LIB_TITLE: Record<Lib, [string, string]> = {
  certified: ['平台认证名单', '通过认证 + 保证金 · 不收费不可购买'],
  watch: ['非认证名单', '已收录 · 观察中'],
  licensed: ['持牌名单', '牌照经监管名录核验 · 筛选视图'],
  blacklist: ['黑名单', '证据链 + 答辩期后判定'],
};
const REGIONS = ['MY', 'SG', 'PH', 'TH', 'VN', 'TW', 'HK'] as const;
type Region = (typeof REGIONS)[number];

export async function ListView({ locale, lib, region, sort, q }: { locale: string; lib: Lib; region?: string; sort?: string; q?: string }) {
  const L = (p: string) => href(locale, p);
  const r = REGIONS.includes(region as Region) ? (region as Region) : undefined;
  const s = sort === 'score_desc' || sort === 'listed_at_desc' ? sort : undefined;
  // D-019：名单内搜索（Meilisearch，简繁 / 港澳写法归一；不可用时走 Postgres）
  const query = q?.trim().slice(0, 100) || undefined;
  const page = await getList(db(), lib, { ...(r ? { region: r } : {}), ...(s ? { sort: s } : {}), ...(query ? { q: query } : {}) });
  const effective = s ?? (lib === 'blacklist' ? 'listed_at_desc' : 'score_desc');
  const qs = (o: { region?: string; sort?: string }) => {
    const p = new URLSearchParams();
    if (o.region) p.set('region', o.region);
    if (o.sort) p.set('sort', o.sort);
    if (query) p.set('q', query);
    const t = p.toString();
    return t ? `?${t}` : '';
  };
  const clearHref = (() => {
    const p = new URLSearchParams();
    if (r) p.set('region', r);
    if (s) p.set('sort', s);
    const t = p.toString();
    return L(LIB_ROUTE[lib]) + (t ? `?${t}` : '');
  })();
  const [title, sub] = LIB_TITLE[lib];
  const c = page.counts ?? {};
  return (
    <main>
      <header className="hdr">
        <a className="back" href={L('/')} aria-label="返回首页">
          <Icon n="back" />
        </a>
        <div className="hdr-t">
          <h1 style={{ margin: 0, fontSize: 17 }}>名单</h1>
          <small className="num">每日 02:00 重算 · 排序只按公开评分</small>
        </div>
      </header>
      <form action={L(LIB_ROUTE[lib])} method="get" role="search" className="glass rise" style={{ minHeight: 38, borderRadius: 'var(--r-pill)', display: 'flex', alignItems: 'center', gap: 'var(--s-4)', padding: '0 var(--s-7)', margin: 'var(--s-4) var(--s-4) 0' }}>
        <span style={{ color: 'var(--accent)' }}>
          <Icon n="search" s={14} w={2.4} />
        </span>
        <input name="q" defaultValue={query ?? ''} maxLength={100} placeholder="在本名单中搜索品牌名 / 域名（简繁皆可）" aria-label="搜索" style={{ flexGrow: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--ink)', font: 'inherit', fontSize: 13 }} />
        {r ? <input type="hidden" name="region" value={r} /> : null}
        {s ? <input type="hidden" name="sort" value={s} /> : null}
        {query ? (
          <a href={clearHref} style={{ fontSize: 12, color: 'var(--muted)' }}>
            清除
          </a>
        ) : null}
      </form>
      <nav className="seg glass rise" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginTop: 'var(--s-4)' }} aria-label="四库">
        {(
          [
            ['certified', '认证', c.certified, 'green'],
            ['watch', '非认证', c.watch, 'amber'],
            ['licensed', '持牌', c.licensed, 'ink'],
            ['blacklist', '黑名单', c.blacklist, 'red'],
          ] as const
        ).map(([k, label, n, tone]) => (
          <a key={k} href={L(LIB_ROUTE[k])} aria-current={k === lib ? 'page' : undefined}>
            {label}
            <small className="num" style={{ color: `var(--${tone})` }}>
              {n ?? 0}
            </small>
          </a>
        ))}
      </nav>
      <nav className="chips rise" aria-label="地区与排序">
        <a className="chip num" href={L(LIB_ROUTE[lib]) + qs({ ...(s ? { sort: s } : {}) })} aria-current={!r ? 'true' : undefined}>
          全部
        </a>
        {REGIONS.map((x) => (
          <a key={x} className="chip num" href={L(LIB_ROUTE[lib]) + qs({ region: x, ...(s ? { sort: s } : {}) })} aria-current={r === x ? 'true' : undefined}>
            {x}
          </a>
        ))}
        <a className="chip num" href={L(LIB_ROUTE[lib]) + qs({ ...(r ? { region: r } : {}), sort: effective === 'score_desc' ? 'listed_at_desc' : 'score_desc' })}>
          {effective === 'score_desc' ? '评分 ↓' : '列入时间 ↓'}
        </a>
      </nav>
      <section className="card glass rise">
        <Head title={title} sub={sub} />
        <Kpis items={(page.kpi ?? []).map((k) => ({ v: k.v ?? '', k: k.k ?? '', tone: k.tone }))} />
        {(page.items ?? []).length ? (
          <Dense
            items={page.items ?? []}
            limit={5}
            render={(b, i) => (
              <a key={b.id} className="row" style={{ gridTemplateColumns: '16px 44px 1fr auto 14px', minHeight: 64 }} href={L(`/brand/${b.slug}`)}>
                <span className="num d">{i + 1}</span>
                <Logo b={b} size={44} />
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                  <span className="s" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
                    <b>{zhName(b)}</b>
                    <StatusBadge b={b} />
                  </span>
                  <span className="num d">
                    {[b.primaryDomain, b.summaryLine ?? (b.score?.score == null && b.status !== 'blacklist' ? '样本不足 · 暂无评分' : (b.markets ?? []).join(' '))]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <Ring score={b.score?.score} black={b.status === 'blacklist'} size={40} stroke={3.5} />
                <span style={{ color: 'var(--muted)' }}>
                  <Icon n="chev" s={14} />
                </span>
              </a>
            )}
          />
        ) : (
          <p className="adv">{query ? `本名单中没有与「${query}」匹配的品牌。可换个写法，或直接查验该名称 / 域名。` : '当前筛选下暂无品牌。'}</p>
        )}
      </section>
      <div className="rise" style={{ margin: 'var(--s-7) var(--s-10) 0', display: 'flex', gap: 'var(--s-4)' }}>
        <span style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 'var(--s-1)' }}>
          <Icon n="info" s={14} />
        </span>
        <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>{page.note}</span>
      </div>
      <Legal
        links={[
          ['评分方法', L('/methodology')],
          ['认证标准', L('/certification')],
          ['联盟披露', L('/disclosure')],
        ]}
      />
    </main>
  );
}
