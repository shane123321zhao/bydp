/** 05 提交投诉（原型 complaint · field-mapping 05 · D-014）。需登录；`?b=<slug>` 预选品牌（品牌页 / 案件页「我也遇到了」）。 */
import { listComplainableBrands } from '@bydp/core/complaint/form';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth';
import { Legal } from '../../../components/atoms';
import { Icon } from '../../../components/Icon';
import { db } from '../../../lib/db';
import { ComplaintForm } from './ComplaintForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '提交投诉', robots: { index: false, follow: false } };

export default async function ComplaintPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ b?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const b = (await searchParams).b;
  const uid = (await auth())?.user?.id;
  if (!uid) redirect(`/login?callbackUrl=${encodeURIComponent(b ? `/complaint?b=${b}` : '/complaint')}`);
  const brands = await listComplainableBrands(db(), uid);
  const initial = brands.find((x) => x.brand.slug === b)?.brand.id ?? null;
  // 事件日期上限：与 DB CHECK 同口径（最早时区 UTC+14 的当天），避免西侧时区用户被误拦
  const today = new Date(Date.now() + 14 * 3600_000).toISOString().slice(0, 10);
  return (
    <>
      <header className="hdr">
        <a className="back" href="/" aria-label="返回首页">
          <Icon n="back" />
        </a>
        <div className="hdr-t">
          <b>提交投诉</b>
          <small className="num">受理即通知运营商 · 答辩期 7 天</small>
        </div>
      </header>
      <ComplaintForm brands={brands} initial={initial} today={today} />
      <Legal links={[]} />
    </>
  );
}
