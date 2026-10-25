import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates } from '../../../lib/seo';
import { TrustPage } from '../../../components/TrustPage';
import { getOfficialChannels } from '@bydp/core/usecases';
import { db } from '../../../lib/db';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '官方渠道验证 · 防仿冒', alternates: alternates(locale as Locale, '/official') };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ch = await getOfficialChannels(db());
  return (
    <TrustPage locale={locale} title="官方渠道验证" sub="只认本页 · 其余均为仿冒">
      <p>黑盘常冒充 BYDP 的域名、Telegram 与客服。只认本页列出的渠道，其余一律视为仿冒。</p>
      {ch.domains.length + ch.telegram.length + ch.bots.length ? (
        <table>
          <tbody>
            {ch.domains.map((d) => (<tr key={d}><th>域名</th><td className="num">{d}</td></tr>))}
            {ch.telegram.map((d) => (<tr key={d}><th>Telegram</th><td className="num">{d}</td></tr>))}
            {ch.bots.map((d) => (<tr key={d}><th>Bot</th><td className="num">{d}</td></tr>))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: "var(--amber)" }}>官方渠道尚未公示（正式名称与主域名待定）。在公示前，请勿相信任何自称 BYDP 客服的联系方式。</p>
      )}
    </TrustPage>
  );
}
