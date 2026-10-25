/** 添加绑定（§16 · 原型 bind）。需登录。 */
import { listBindableBrands } from '@bydp/core/identity/me';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { Legal } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { db } from '../../../../lib/db';
import { BindForm } from './BindForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '添加绑定', robots: { index: false, follow: false } };

export default async function BindPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ b?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const uid = (await auth())?.user?.id;
  if (!uid) redirect('/login?callbackUrl=/me/bind');
  const brands = await listBindableBrands(db(), uid);
  const b = (await searchParams).b;
  const initial = brands.find((x) => x.brand.slug === b)?.brand.id ?? null;
  return (
    <>
      <header className="hdr">
        <a className="back" href="/me" aria-label="返回我的">
          <Icon n="back" />
        </a>
        <div style={{ flexGrow: 1, fontSize: 16, fontWeight: 700 }}>添加绑定</div>
      </header>
      <BindForm brands={brands} initial={initial} />
      <Legal links={[]} />
    </>
  );
}
