/** D-024 提交出款凭证（需登录；`?b=<slug>` 预选品牌——品牌页行动区「提交出款凭证」/ 出款子页「提交凭证」）。只列本人已绑定的平台。 */
import { listComplainableBrands } from '@bydp/core/complaint/form';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { Legal } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { db } from '../../../../lib/db';
import { WithdrawalForm } from './WithdrawalForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '提交出款凭证', robots: { index: false, follow: false } };

export default async function WithdrawalReportPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ b?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const b = (await searchParams).b;
  const uid = (await auth())?.user?.id;
  if (!uid) redirect(`/login?callbackUrl=${encodeURIComponent(b ? `/me/withdrawal-report?b=${b}` : '/me/withdrawal-report')}`);
  const bound = (await listComplainableBrands(db(), uid)).filter((x) => x.binding).map((x) => x.brand);
  const initial = bound.find((x) => x.slug === b)?.id ?? null;
  // 时间输入上限：当前时刻（本地时间串由服务端按 UTC 给出，客户端 max 仅作提示；库触发器以 now() + 10 分钟兜底）
  const nowLocal = new Date(Date.now() + 14 * 3600_000).toISOString().slice(0, 16);
  return (
    <>
      <header className="hdr">
        <a className="back" href={b ? `/brand/${b}/withdrawal` : '/me'} aria-label="返回">
          <Icon n="back" />
        </a>
        <div className="hdr-t">
          <b>提交出款凭证</b>
          <small className="num">绑定用户凭证 · 审核后计入出款统计</small>
        </div>
      </header>
      {b && !initial ? (
        <section className="card glass first rise">
          <p className="adv">你还没有绑定该平台的账号。出款凭证只接受绑定用户（评分只计绑定后的出款），请先添加绑定。</p>
          <a className="btn" href={`/me/bind?b=${b}`} style={{ marginTop: 'var(--s-6)' }}>
            添加绑定
          </a>
        </section>
      ) : bound.length ? (
        <WithdrawalForm brands={bound} initial={initial} nowLocal={nowLocal} />
      ) : (
        <section className="card glass first rise">
          <p className="adv">只有绑定了该平台账号的用户才能提交出款凭证（评分只计绑定用户的凭证）。请先添加绑定。</p>
          <a className="btn" href={b ? `/me/bind?b=${b}` : '/me/bind'} style={{ marginTop: 'var(--s-6)' }}>
            添加绑定
          </a>
        </section>
      )}
      <Legal links={[]} />
    </>
  );
}
