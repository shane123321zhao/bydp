import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { getHome } from '@bydp/core/usecases';
import { getMeBrief } from '@bydp/core/identity/me';
import { auth } from '../../auth';
import { db } from '../../lib/db';
import { alternates, href } from '../../lib/seo';
import type { Locale } from '../../i18n/routing';
import { Icon, type IconName } from '../../components/Icon';
import { Dense, Head, Legal, Logo, Ring, Stat, StatusBadge, fmtUsdt, zhName } from '../../components/atoms';
import { SearchForm } from '../../components/Search';
import { viewerSelfExclusion } from '../../lib/viewer';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternates(locale as Locale, '/') };
}

const FEED: Record<string, [string, string]> = {
  fake: ['仿冒', 'purple'],
  exposed: ['曝光', 'red'],
  blacklist: ['黑名单', 'red'],
  resolved: ['结案', 'green'],
  watch: ['收录', 'amber'],
};

/** sparkline：只画 series 里真实存在的点；数据点 < 2 不画 */
function Spark({ pts, color }: { pts: number[]; color: string }) {
  if (pts.length < 2) return null;
  const max = Math.max(...pts, 1);
  const min = Math.min(...pts);
  const span = Math.max(max - min, 1);
  const d = pts.map((v, i) => `${((i / (pts.length - 1)) * 140).toFixed(1)},${(30 - ((v - min) / span) * 26).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" height="34" viewBox="0 0 140 34" preserveAspectRatio="none" aria-hidden>
      <polyline points={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const h = await getHome(db());
  // field-mapping 01「我的（登录）」：昵称 · 绑定数 · 赔付资格 · 进行中投诉数；未登录显示登录入口
  const uid = (await auth())?.user?.id;
  const me = uid ? await getMeBrief(db(), uid) : null;
  const excluded = !!(await viewerSelfExclusion());
  const L = (p: string) => href(locale, p);
  const s = h.stats ?? {};
  const ENT: [string, string, string, IconName][] = [
    ['查验', '域名 · TG · 钱包', '#q', 'search'],
    ['认证名单', `${h.libs?.certified ?? 0} 家 · 先行赔付`, L('/certified'), 'shield'],
    // 排除期：优惠入口换成自律设置（D-019）
    excluded ? ['自律设置', '排除期中 · 不展示优惠', L('/me/rg'), 'lock'] : ['优惠', '真实价值换算', L('/offers'), 'offers'],
    ['黑名单', `${h.libs?.blacklist ?? 0} · 今日 +${s.blacklistedToday ?? 0}`, L('/blacklist'), 'ban'],
    ['持牌名单', `${h.libs?.licensed ?? 0} 家 · 名录核验`, L('/licensed'), 'globe'],
    ['官方验证', '防仿冒', L('/official'), 'lock'],
  ];
  const carousel = [h.featured, ...(h.gauges ?? [])].filter((b): b is NonNullable<typeof b> => !!b && b.status !== 'blacklist');
  const ticker = (h.feed ?? []).slice(0, 4);
  return (
    <main>
      <header className="hdr">
        <div className="brandmark">
          <i />
          <b className="num">BYDP</b>
          <span>博弈点评</span>
        </div>
        <span className="pillb">
          <span className="pulse" style={{ width: 6, height: 6, borderRadius: 'var(--r-xs)', background: 'var(--accent)', display: 'block' }} />
          收录 <b className="num" style={{ color: 'var(--ink)' }}>{fmtUsdt(s.brandsIndexed ?? 0)}</b>
        </span>
      </header>
      <a
        className="card glass rise"
        href={me ? '/me' : '/login'}
        style={{ margin: 'var(--s-4) var(--s-10) 0', padding: 'var(--s-4) var(--s-7)', display: 'grid', gridTemplateColumns: '18px 1fr 14px', gap: 'var(--s-5)', alignItems: 'center', color: 'inherit' }}
      >
        <span style={{ color: 'var(--accent)' }}>
          <Icon n="me" s={16} w={1.9} />
        </span>
        {me ? (
          <span className="num" style={{ fontSize: 12, color: 'var(--body)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <b style={{ color: 'var(--ink)' }}>{me.displayName}</b> · 绑定 {me.bindings} · {me.compensationEligible ? '有赔付资格' : '暂无赔付资格'} · 进行中投诉 {me.activeComplaints}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--body)' }}>
            <b style={{ color: 'var(--ink)' }}>登录</b> · 查投诉进度、领码、绑定账号
          </span>
        )}
        <span style={{ color: 'var(--muted)' }}>
          <Icon n="chev" s={14} />
        </span>
      </a>
      <div className="glow" aria-hidden />
      <section className="rise" style={{ position: 'relative', padding: 'var(--s-6) var(--s-10) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 900, lineHeight: 1.05, letterSpacing: '-.03em' }}>
            存前<span style={{ color: 'var(--accent)' }}>一查</span>。
          </h1>
          <p style={{ margin: 'var(--s-3) 0 0', fontSize: 13, color: 'var(--muted)' }}>黑盘 · 仿冒 · 出款 · 关联同伙，一次看清</p>
        </div>
        <div className="search glass">
          <div className="radar" aria-hidden>
            <div className="sweep" />
          </div>
          <SearchForm action={L('/check')} />
          {(h.hotCandidates ?? []).length ? (
            <div style={{ position: 'relative', display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="eyebrow">近期被查询较多</span>
              {(h.hotCandidates ?? []).slice(0, 3).map((c) => (
                <a key={c.value} className="chip xs num" href={L(`/check/${encodeURIComponent(c.value ?? '')}`)}>
                  {c.value} · {c.queryCount7d} 次
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {ticker.length ? (
        <div className="rise" style={{ marginTop: 'var(--s-7)', overflow: 'hidden', display: 'flex', alignItems: 'center', borderTop: '1px solid var(--gb)', borderBottom: '1px solid var(--gb)', minHeight: 34 }} aria-label="今日预警滚动">
          <div className="ticker" style={{ display: 'flex', gap: 'var(--s-12)', padding: '0 var(--s-10)', width: 'max-content', fontSize: 11, color: 'var(--body)' }}>
            {[0, 1].map((k) =>
              ticker.map((t, i) => (
                <span key={`${k}-${i}`} aria-hidden={k === 1} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 'var(--r-xs)', background: `var(--${FEED[t.kind ?? 'watch']![1]})`, display: 'block' }} />
                  {FEED[t.kind ?? 'watch']![0]} · {t.subject} {t.rest}
                </span>
              )),
            )}
          </div>
        </div>
      ) : null}

      <nav className="ents rise" aria-label="入口">
        {ENT.map(([l, sub, to, ic]) => (
          <a key={l} className="ent" href={to}>
            <span className="ic">
              <Icon n={ic} s={20} w={1.9} />
            </span>
            <span className="l">
              {l}
              <small>{sub}</small>
            </span>
          </a>
        ))}
      </nav>

      {carousel.length ? (
        <section className="rise" style={{ marginTop: 'var(--s-10)' }}>
          <div style={{ padding: '0 var(--s-10)' }}>
            <Head
              title="认证推荐"
              sub="按公开评分排序 · 不收费"
              link={
                <a className="link" href={L('/certified')}>
                  全部 {h.libs?.certified ?? 0} 家 <Icon n="chev" s={12} w={2.4} />
                </a>
              }
            />
          </div>
          <div className="carousel">
            {carousel.map((b) => (
              <article key={b.id} className="tall glass">
                <div className="hero">
                  <Logo b={b} size={52} />
                  {b.primaryDomain ? (
                    <span className="num" style={{ position: 'absolute', right: 'var(--s-5)', bottom: 'var(--s-4)', fontSize: 10, color: 'var(--muted)' }}>
                      {b.primaryDomain}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-4)', padding: '0 var(--s-1)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{zhName(b)}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', marginTop: 'var(--s-1)' }}>
                      <StatusBadge b={b} />
                      <span className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {[b.license?.regulator ?? '未持牌', b.reviewCount ? `${b.reviewCount.toLocaleString('en-US')} 评价` : null].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  </div>
                  <Ring score={b.score?.score} size={44} stroke={4} />
                </div>
                {!excluded && h.featuredOffer && h.featured?.id === b.id ? (
                  <div className="code" style={{ justifyContent: 'center', borderStyle: 'solid', fontSize: 13, fontWeight: 600 }}>
                    {h.featuredOffer.title}
                  </div>
                ) : null}
                <a className={b.status === 'certified' ? 'btn' : 'btn muted'} href={L(`/brand/${b.slug}`)} style={{ minHeight: 40 }}>
                  看评测 <Icon n="chev" s={13} w={2.6} />
                </a>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rise tiles" style={{ margin: 'var(--s-9) var(--s-10) 0', gridTemplateColumns: '1fr 1fr' }}>
        <a className="tile glass" href={L('/blacklist')}>
          <span>黑名单</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)' }}>
            <b className="num" style={{ color: 'var(--red)', fontSize: 26 }}>
              {s.blacklisted ?? 0}
            </b>
            <span className="num" style={{ color: 'var(--red)' }}>
              +{s.blacklistedToday ?? 0} 今日
            </span>
          </div>
          <Spark pts={s.series?.blacklisted ?? []} color="var(--red)" />
          <span>近 30 天累计</span>
        </a>
        <div className="tile glass">
          <span>投诉受理</span>
          <b className="num" style={{ fontSize: 26 }}>
            {s.complaintsHandled ?? 0}
          </b>
          {s.resolveRate != null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)', marginTop: 'var(--s-3)' }}>
              <div className="bar">
                <i style={{ width: `${Math.round(s.resolveRate * 100)}%`, background: 'var(--green)' }} />
              </div>
              <span className="num" style={{ fontSize: 11, color: 'var(--green)' }}>
                {Math.round(s.resolveRate * 1000) / 10}%
              </span>
            </div>
          ) : null}
          <span>解决率{s.medianResolveDays != null ? ` · 中位 ${s.medianResolveDays} 天` : ''}</span>
        </div>
      </section>

      {(h.feed ?? []).length ? (
        <section className="card glass rise">
          <Head title="今日预警" sub="仿冒 · 曝光 · 结案" />
          <div className="scan" aria-hidden />
          <Dense
            items={h.feed ?? []}
            render={(r, i) => {
              const [label, tone] = FEED[r.kind ?? 'watch']!;
              // 案件页属 M2（05）；结案条目先落到品牌投诉 Tab
              const to = r.kind === 'fake' ? L(`/check/${encodeURIComponent(r.subject ?? '')}`) : r.kind === 'resolved' ? L(`/brand/${r.ref}/complaints`) : L(`/brand/${r.ref}`);
              return (
                <a key={i} className="row" style={{ gridTemplateColumns: 'auto 1fr auto 14px', minHeight: 48 }} href={to}>
                  <span className={`badge b-${tone}`}>{label}</span>
                  <span className="s">
                    <b>{r.subject}</b> {r.rest}
                  </span>
                  <span className="num d">{r.date?.slice(5)}</span>
                  <span style={{ color: 'var(--muted)' }}>
                    <Icon n="chev" s={14} />
                  </span>
                </a>
              );
            }}
          />
        </section>
      ) : null}

      <section className="card glass rise">
        <Head title="为什么信 BYDP" sub="评分公开 · 与商业隔离" link={<a className="link" href={L('/methodology')}>评分方法 <Icon n="chev" s={12} w={2.4} /></a>} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-6) var(--s-4)' }}>
          <Stat v={fmtUsdt(s.brandsIndexed ?? 0)} k="收录平台" />
          <Stat v={`${fmtUsdt(s.certifiedDepositsUsdt ?? 0)} U`} k="认证保证金" tone="accent" />
        </div>
        <p className="adv" style={{ borderTop: '1px solid var(--gb)', paddingTop: 'var(--s-6)' }}>
          认证不收费、不可购买。评分只看出款、仲裁、硬指标、评价与稳定性五因子，每日 02:00 重算；黑名单永不接入商业合作。
        </p>
      </section>

      <Legal
        links={[
          ['评分方法', L('/methodology')],
          ['联盟披露', L('/disclosure')],
          ['服务地区', L('/regions')],
          ['官方渠道验证', L('/official')],
          ['认证标准', L('/certification')],
        ]}
      />
    </main>
  );
}
