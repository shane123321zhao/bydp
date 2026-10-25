/** 负责任博彩（§16 · 原型 rg）。需登录。 */
import { getPreferences } from '@bydp/core/identity/privacy';
import { getSelfExclusion } from '@bydp/core/identity/self-exclusion';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { Legal } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { db } from '../../../../lib/db';
import { RgClient } from './RgClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '负责任博彩', robots: { index: false, follow: false } };

export default async function RgPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const uid = (await auth())?.user?.id;
  if (!uid) redirect('/login?callbackUrl=/me/rg');
  const [exclusion, prefs] = await Promise.all([getSelfExclusion(db(), uid), getPreferences(db(), uid)]);
  return (
    <>
      <header className="hdr">
        <a className="back" href="/me" aria-label="返回我的">
          <Icon n="back" />
        </a>
        <div style={{ flexGrow: 1, fontSize: 16, fontWeight: 700 }}>负责任博彩</div>
      </header>
      <RgClient exclusion={exclusion} prefs={prefs} />
      <Legal links={[]} />
    </>
  );
}
