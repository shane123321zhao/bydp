import { getBrandOffers } from '@bydp/core/usecases';
import { db } from '../../../../../lib/db';
import { brandMetadata } from '../../../../../lib/brand-meta';
import { BarRow, Dense, Head, Kpis } from '../../../../../components/atoms';
import { exclusionNotice, viewerSelfExclusion } from '../../../../../lib/viewer';
import { href } from '../../../../../lib/seo';
import { auth } from '../../../../../auth';
import { ClaimBox } from '../../../../../components/ClaimBox';

export const generateMetadata = ({ params }: { params: Promise<{ locale: string; slug: string }> }) => brandMetadata(params, 'bonus');

export default async function Bonus({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const ex = await viewerSelfExclusion();
  if (ex) {
    return (
      <section className="card glass rise" style={{ minHeight: 160 }}>
        <Head title="专属优惠" sub="自我排除期" />
        <p className="adv">{exclusionNotice(ex)}</p>
      </section>
    );
  }
  const offers = (await getBrandOffers(db(), slug)) ?? [];
  const claimed = offers.reduce((s, o) => s + (o.claimedCount ?? 0), 0);
  const first = offers.find((o) => o.exclusive) ?? offers[0];
  // D-023：每条在效优惠一个领码块（黑名单 / 下线 / 过期已在 getBrandOffers 排除）；未登录跳登录页并带回本页
  const loggedIn = !!(await auth())?.user?.id;
  const loginHref = href(locale, `/login?callbackUrl=${encodeURIComponent(href(locale, `/brand/${slug}/bonus`))}`);
  return (
    <section className="card glass rise" style={{ minHeight: 300 }}>
      <Head title="专属优惠" sub="真实价值按 96% RTP 打满流水估算" />
      <Kpis
        items={[
          { v: offers.length, k: '在效优惠' },
          { v: claimed.toLocaleString('en-US'), k: '已领码' },
          ...(first?.trueValue?.netExpectedValueUsdt != null
            ? [{ v: `${first.trueValue.netExpectedValueUsdt > 0 ? '+' : ''}${first.trueValue.netExpectedValueUsdt} U`, k: '首选真实价值', tone: first.trueValue.netExpectedValueUsdt > 0 ? ('green' as const) : ('amber' as const) }]
            : []),
        ]}
      />
      {offers.length ? (
        <Dense
          items={offers}
          render={(o, i) => {
            const ev = o.trueValue?.netExpectedValueUsdt ?? 0;
            return (
              <BarRow
                key={i}
                a={o.title ?? ''}
                b={[o.terms?.rolloverMultiple ? `${o.terms.rolloverMultiple}× 流水` : '无流水', (o.terms?.eligibleGames ?? []).join('/'), o.terms?.validDays ? `${o.terms.validDays} 天` : null].filter(Boolean).join(' · ')}
                pct={Math.min(100, (Math.abs(ev) / 80) * 100)}
                tone={ev > 0 ? 'green' : 'amber'}
                tag={`${ev > 0 ? '+' : ''}${ev} U`}
              />
            );
          }}
        />
      ) : (
        <p className="adv">暂无在效优惠。</p>
      )}
      {/* 领码 = POST /offers/{id}/claim 同一用例（登录 + 记 Click，D-023） */}
      {offers.map((o) => (
        <div key={o.id} style={{ marginTop: 'var(--s-6)' }}>
          <div style={{ fontSize: 12, color: 'var(--body)', marginBottom: 'var(--s-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.title}</div>
          {o.id ? <ClaimBox offerId={o.id} loggedIn={loggedIn} loginHref={loginHref} /> : null}
        </div>
      ))}
      {offers.length ? (
        <p className="adv">
          专属码登录后领取，并经平台跟踪链接注册。
          {offers.some((o) => o.compensationEligible) ? '认证商家：绑定运营商账号后才具备先行赔付保障资格。' : (offers.find((o) => o.riskLabel)?.riskLabel ?? '非认证商家：不享先行赔付保障')}
        </p>
      ) : null}
    </section>
  );
}
