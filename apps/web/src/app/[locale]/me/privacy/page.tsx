/** 隐私与数据（§16 · 原型 privacy）。需登录。「我们保存了什么」按 A-009 / A-011 实际存储口径。 */
import { listMyDataRequests } from '@bydp/core/identity/privacy';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { Legal } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { db } from '../../../../lib/db';
import { href } from '../../../../lib/seo';
import { PrivacyClient } from './PrivacyClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '隐私与数据', robots: { index: false, follow: false } };

const STORED: [string, string, string][] = [
  ['登录身份', 'TG id / 邮箱：只存哈希与加密文', 'lock'],
  ['绑定账号', '运营商账号：只存哈希与加密文，不存明文', 'shield'],
  ['证据原文', '对象存储，仅仲裁员可见；哈希永久保留', 'complaint'],
  ['状态日志 · 审计', '只追加，不可删除（仲裁可信度依据）', 'list'],
  [
    '设备标识',
    '登录时在你的浏览器放一个随机设备编号（Cookie bydp_did，400 天），我们只保存它的哈希，用来发现同一设备上的多个账号；不采集浏览器特征，不用于广告。清除 Cookie 即重置；注销后 180 天内删除。',
    'me',
  ],
];

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const uid = (await auth())?.user?.id;
  if (!uid) redirect('/login?callbackUrl=/me/privacy');
  const requests = await listMyDataRequests(db(), uid);
  return (
    <>
      <header className="hdr">
        <a className="back" href="/me" aria-label="返回我的">
          <Icon n="back" />
        </a>
        <div style={{ flexGrow: 1, fontSize: 16, fontWeight: 700 }}>隐私与数据</div>
      </header>
      <section className="card glass first rise" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            我们保存了什么<small>按用途最小化</small>
          </h2>
        </div>
        {STORED.map(([t, d, ic], i) => (
          <div key={t} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 'var(--s-6)', alignItems: 'center', minHeight: 52, borderTop: i ? '1px solid var(--gb)' : undefined }}>
            <span style={{ color: 'var(--accent)' }}>
              <Icon n={ic as 'lock'} s={16} w={1.8} />
            </span>
            <span style={{ fontSize: 14, display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
              {t}
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{d}</span>
            </span>
          </div>
        ))}
      </section>
      <PrivacyClient requests={requests} />
      <Legal
        links={[
          ['隐私政策', href(locale, '/privacy-policy')],
          ['Cookie 说明', href(locale, '/privacy-policy') + '#cookies'],
          ['服务条款', href(locale, '/terms')],
        ]}
      />
    </>
  );
}
