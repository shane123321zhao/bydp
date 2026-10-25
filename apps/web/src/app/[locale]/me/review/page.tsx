/** D-024 写评价（需登录；`?b=<slug>` 预选品牌——品牌页评分因子「玩家评价」行「写评价」）。只列本人已绑定的平台。 */
import { listComplainableBrands } from '@bydp/core/complaint/form';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { Legal } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { db } from '../../../../lib/db';
import { ReviewForm } from './ReviewForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '写评价', robots: { index: false, follow: false } };

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ b?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const b = (await searchParams).b;
  const uid = (await auth())?.user?.id;
  if (!uid) redirect(`/login?callbackUrl=${encodeURIComponent(b ? `/me/review?b=${b}` : '/me/review')}`);
  const bound = (await listComplainableBrands(db(), uid)).filter((x) => x.binding).map((x) => x.brand);
  const initial = bound.find((x) => x.slug === b)?.id ?? null;
  return (
    <>
      <header className="hdr">
        <a className="back" href={b ? `/brand/${b}` : '/me'} aria-label="返回">
          <Icon n="back" />
        </a>
        <div className="hdr-t">
          <b>写评价</b>
          <small className="num">绑定用户评价 · 审核后计分 · 文字不公开</small>
        </div>
      </header>
      {b && !initial ? (
        <section className="card glass first rise">
          <p className="adv">你还没有绑定该平台的账号。评价只接受绑定用户，请先添加绑定。</p>
          <a className="btn" href={`/me/bind?b=${b}`} style={{ marginTop: 'var(--s-6)' }}>
            添加绑定
          </a>
        </section>
      ) : bound.length ? (
        <ReviewForm brands={bound} initial={initial} />
      ) : (
        <section className="card glass first rise">
          <p className="adv">评价只接受绑定了该平台账号的用户，请先添加绑定。</p>
          <a className="btn" href="/me/bind" style={{ marginTop: 'var(--s-6)' }}>
            添加绑定
          </a>
        </section>
      )}
      <Legal links={[]} />
    </>
  );
}
