import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { brandDetail, primaryDomain } from '../../../../lib/brand';
import { href } from '../../../../lib/seo';
import { Icon } from '../../../../components/Icon';
import { BrandTabs } from '../../../../components/BrandTabs';
import { Facts, Legal, Logo, Ring, StatusBadge, zhName } from '../../../../components/atoms';
import { exclusionNotice, viewerSelfExclusion } from '../../../../lib/viewer';

export const dynamic = 'force-dynamic';

export default async function BrandLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const b = await brandDetail(slug);
  if (!b) notFound();
  const domain = await primaryDomain(slug);
  const L = (p: string) => href(locale, p);
  const years = b.operator?.foundedYear ? new Date().getFullYear() - b.operator.foundedYear : null;
  const cert = b.status === 'certified';
  const excluded = await viewerSelfExclusion();
  const meta = [domain, b.license ? `${b.license.regulator} ${b.license.licenseNo}` : '未持牌', years != null ? `运营 ${years} 年` : null].filter(Boolean).join(' · ');
  return (
    <main>
      <header className="hdr">
        <a className="back" href={L('/')} aria-label="返回首页">
          <Icon n="back" />
        </a>
        <div style={{ flexGrow: 1, display: 'flex', alignItems: 'center', gap: 'var(--s-4)', minWidth: 0 }}>
          <Logo b={b} size={26} />
          <span style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{zhName(b)}</span>
          <StatusBadge b={b} />
        </div>
      </header>

      <section className="card glass first rise" style={{ padding: 'var(--s-5) var(--s-5) var(--s-8)' }}>
        <div className="hero" style={{ height: 120 }}>
          <Logo b={b} size={60} />
          {domain ? (
            <span className="num" style={{ position: 'absolute', right: 'var(--s-5)', bottom: 'var(--s-4)', fontSize: 10, color: 'var(--muted)' }}>
              {domain}
            </span>
          ) : null}
        </div>
        <div style={{ padding: 'var(--s-6) var(--s-3) 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-5)' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 900, letterSpacing: '-.01em' }}>{zhName(b)}</h1>
            <div className="num" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 'var(--s-2)', display: 'flex', gap: 'var(--s-3)', alignItems: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <span style={{ color: 'var(--accent)' }}>
                <Icon n="globe" s={12} w={1.8} />
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta}</span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--s-3)', marginTop: 'var(--s-4)', flexWrap: 'wrap' }}>
              <StatusBadge b={b} />
              {(b.markets ?? []).length ? <span className="badge b-muted num">{(b.markets ?? []).join(' ')}</span> : null}
              {b.operator?.relatedParty ? <span className="badge b-amber">关联方 · 已披露</span> : null}
            </div>
          </div>
          <Ring score={b.score?.score} black={b.status === 'blacklist'} size={64} stroke={5} />
        </div>

        {excluded && b.status !== 'blacklist' ? (
          <div style={{ padding: '0 var(--s-3)' }}>
            <div className="cta-note warn">
              <Icon n="info" s={12} /> {exclusionNotice(excluded)}
            </div>
          </div>
        ) : b.status !== 'blacklist' && domain ? (
          <div style={{ padding: '0 var(--s-3)' }}>
            <div className={cert ? 'cta' : 'cta even'}>
              {/* 跟踪链接属 packages/tracking（M2 · 双签）；M1 直链官方主域，不带归因参数 */}
              <a className={cert ? 'btn' : 'btn muted'} href={`https://${domain}`} rel="nofollow noopener noreferrer" target="_blank">
                前往官网 <Icon n="ext" s={13} w={2.6} />
              </a>
              {cert && b.featuredOffer ? (
                <a className="ghost" href={L(`/brand/${slug}/bonus`)}>
                  <Icon n="offers" s={13} /> 专属优惠
                </a>
              ) : (
                <a className="ghost" href={L(`/brand/${slug}/complaints`)}>
                  看投诉记录
                </a>
              )}
            </div>
            {cert ? (
              <div className="cta-note">条款适用 · 经 BYDP 领码绑定后享先行赔付保障</div>
            ) : (
              <div className="cta-note warn">
                <Icon n="alert" s={12} /> 非认证商家 · 不享先行赔付 · 建议小额试提
              </div>
            )}
          </div>
        ) : null}
        <div style={{ padding: '0 var(--s-3)' }}>
          <Facts facts={b.facts ?? []} />
        </div>
      </section>

      <BrandTabs base={L(`/brand/${slug}`)} counts={b.counts ?? {}} hideOffers={!!excluded} />
      {children}
      {/* 行动（原型 Brand.dc.html 行动区）：对此品牌投诉 · 提交出款凭证 · 写评价（D-024）——查验与投诉类动作不受自我排除影响 */}
      <section className="rise" style={{ margin: 'var(--s-4) var(--s-10) 0' }}>
        <div className="cta even">
          <a className="ghost" href={L(`/complaint?b=${slug}`)}>
            <Icon n="complaint" s={13} /> 对此品牌投诉
          </a>
          <a className="ghost" href={L(`/me/withdrawal-report?b=${slug}`)}>
            <Icon n="wallet" s={13} /> 提交出款凭证
          </a>
        </div>
        {/* W2#005 收尾 4：「写评价」追加在行动区（评分因子行内入口保留；dense 折叠规则不变） */}
        <div className="cta-note" style={{ justifyContent: 'center' }}>
          <a className="link" href={L(`/me/review?b=${slug}`)}>
            写评价 <Icon n="chev" s={12} />
          </a>
        </div>
      </section>
      <Legal
        links={[
          ['联盟关系披露', L('/disclosure')],
          ['认证标准', L('/certification')],
          ['评分方法', L('/methodology')],
        ]}
      />
    </main>
  );
}
