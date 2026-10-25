import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { getOffers, type OfferFilter } from '@bydp/core/usecases';
import type { Locale } from '../../../i18n/routing';
import { db } from '../../../lib/db';
import { alternates, href } from '../../../lib/seo';
import { Icon } from '../../../components/Icon';
import { Legal, Logo, Ring, StatusBadge, zhName } from '../../../components/atoms';
import { exclusionNotice, viewerSelfExclusion } from '../../../lib/viewer';
import { ClaimBox } from '../../../components/ClaimBox';
import { auth } from '../../../auth';

export const dynamic = 'force-dynamic';
const FILTERS: [OfferFilter, string][] = [
  ['all', '全部'],
  ['cert', '仅认证'],
  ['pos', '正期望'],
  ['sports', '体育'],
  ['live', '真人'],
  ['slots', '老虎机'],
];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '优惠 · 真实价值换算', alternates: alternates(locale as Locale, '/offers') };
}

export default async function Offers({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ filter?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const f = ((await searchParams).filter ?? 'all') as OfferFilter;
  const filter = FILTERS.some(([k]) => k === f) ? f : 'all';
  const L = (x: string) => href(locale, x);
  // D-019：排除期用户不展示优惠列表与领码入口
  const ex = await viewerSelfExclusion();
  if (ex) {
    return (
      <main>
        <header className="hdr">
          <div className="hdr-t">
            <h1 style={{ margin: 0, fontSize: 17 }}>优惠</h1>
          </div>
        </header>
        <section className="card glass rise">
          <p className="adv">{exclusionNotice(ex)}</p>
          <a className="btn muted" href={L('/me/rg')} style={{ marginTop: 'var(--s-6)' }}>
            查看自律设置
          </a>
        </section>
      </main>
    );
  }
  const p = await getOffers(db(), filter);
  // D-023：未登录「登录领码」跳登录页并带回本页（含筛选）
  const loggedIn = !!(await auth())?.user?.id;
  const loginHref = L(`/login?callbackUrl=${encodeURIComponent(L(`/offers${filter === 'all' ? '' : `?filter=${filter}`}`))}`);
  return (
    <main>
      <header className="hdr">
        <div className="hdr-t">
          <h1 style={{ margin: 0, fontSize: 17 }}>优惠</h1>
          <small className="num">每个优惠都换算「真实价值」· 96% RTP 打满流水</small>
        </div>
      </header>
      <nav className="chips rise" aria-label="筛选">
        {FILTERS.map(([k, l]) => (
          <a key={k} className="chip" href={L(`/offers${k === 'all' ? '' : `?filter=${k}`}`)} aria-current={k === filter ? 'true' : undefined}>
            {l}
          </a>
        ))}
      </nav>
      <section className="rise tiles" style={{ margin: 'var(--s-7) var(--s-10) 0', gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="tile glass">
          <span>正期望</span>
          <b className="num t-green">{p.stats?.positive ?? 0}</b>
        </div>
        <div className="tile glass">
          <span>流水补贴型</span>
          <b className="num t-amber">{p.stats?.subsidy ?? 0}</b>
        </div>
        <div className="tile glass">
          <span>已领码</span>
          <b className="num">{(p.stats?.claimed ?? 0).toLocaleString('en-US')}</b>
        </div>
      </section>
      {(p.items ?? []).map((o) => {
        const b = o.brand!;
        const ev = o.trueValue?.netExpectedValueUsdt ?? 0;
        const cert = b.status === 'certified';
        const terms = [o.terms?.rolloverMultiple ? `${o.terms.rolloverMultiple}× 流水` : '无流水', (o.terms?.eligibleGames ?? []).join('/'), o.terms?.validDays ? `${o.terms.validDays} 天` : null, o.terms?.maxWithdrawalUsdt ? `上限 ${o.terms.maxWithdrawalUsdt} U` : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <article key={o.id} className="card glass rise" style={{ padding: 'var(--s-7)' }}>
            <a className="bc" href={L(`/brand/${b.slug}`)} style={{ gridTemplateColumns: '44px 1fr auto' }}>
              <Logo b={b} size={44} />
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
                <div className="n">
                  <b style={{ fontSize: 15 }}>{zhName(b)}</b>
                  <StatusBadge b={b} />
                  {o.exclusive ? <span className="badge b-accent">独家</span> : null}
                  {o.sponsored ? <span className="badge b-muted">赞助</span> : null}
                </div>
                <div className="num" style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {terms}
                </div>
              </div>
              <Ring score={b.score?.score} size={40} stroke={3.5} />
            </a>
            <h2 style={{ fontSize: 17, fontWeight: 900, margin: 'var(--s-6) 0 var(--s-5)', letterSpacing: '-.01em' }}>{o.title}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px 1fr', gap: 'var(--s-4)', alignItems: 'center' }} aria-label={`真实价值 ${ev} USDT`}>
              <div className="bar" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <i style={{ width: `${ev < 0 ? Math.min(100, (-ev / 80) * 100) : 0}%`, background: 'var(--red)', transformOrigin: 'right' }} />
              </div>
              <span className={`num ${ev > 0 ? 't-green' : 't-red'}`} style={{ fontSize: 14, fontWeight: 700, textAlign: 'center' }}>
                {ev > 0 ? '+' : ''}
                {ev} U
              </span>
              <div className="bar">
                <i style={{ width: `${ev > 0 ? Math.min(100, (ev / 80) * 100) : 0}%`, background: 'var(--green)' }} />
              </div>
            </div>
            <p className="adv" style={{ marginTop: 'var(--s-4)' }}>
              {o.trueValue?.verdictText}
            </p>
            <div style={{ marginTop: 'var(--s-6)' }}>
              {o.id ? <ClaimBox offerId={o.id} loggedIn={loggedIn} loginHref={loginHref} /> : null}
            </div>
            {cert && o.compensationEligible ? (
              <div className="cta-note">条款适用 · 经此绑定享先行赔付保障</div>
            ) : cert ? (
              <div className="cta-note warn">
                <Icon n="alert" s={12} /> {o.riskLabel ?? '此优惠不在先行赔付保障范围内'}
              </div>
            ) : (
              <div className="cta-note warn">
                <Icon n="alert" s={12} /> {o.riskLabel ?? '非认证商家：不享先行赔付保障'}
              </div>
            )}
          </article>
        );
      })}
      {(p.items ?? []).length === 0 ? <p className="adv" style={{ margin: 'var(--s-7) var(--s-10) 0' }}>当前筛选下暂无优惠。</p> : null}
      <div className="rise" style={{ margin: 'var(--s-7) var(--s-10) 0', display: 'flex', gap: 'var(--s-4)' }}>
        <span style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 'var(--s-1)' }}>
          <Icon n="info" s={14} />
        </span>
        <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
          真实价值 = 奖励金 − 打满流水的期望损耗（按 96% RTP）。负值表示奖励实为流水补贴；黑名单永不接入；独家位可付费但必须标注「赞助」，不影响排序。
        </span>
      </div>
      <Legal
        links={[
          ['联盟关系披露', L('/disclosure')],
          ['服务地区', L('/regions')],
        ]}
      />
    </main>
  );
}
