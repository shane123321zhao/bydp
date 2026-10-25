/**
 * 06 我的（field-mapping 06 · 原型 me 页 · design-system §13 / §15）。需登录；数据全部来自 @bydp/core/identity/me。
 * - 等级进度：「距 LvN 还差 X 分」取 user.nextLevelAt（A-010 门槛 0 / 500 / 1500 / 3000 / 6000；满级不显示）；动态流积分事件标签为「+N 分」。
 * - 二级页（§16）：添加绑定 ./bind · 负责任博彩 ./rg · 隐私与数据 ./privacy。
 */
import { getMe } from '@bydp/core/identity/me';
import { getOfficialChannels } from '@bydp/core/usecases';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth';
import { Dense, Head, Legal, Logo, zhName } from '../../../components/atoms';
import { Icon } from '../../../components/Icon';
import { db } from '../../../lib/db';
import { signOutEverywhere, signOutHere } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '我的', robots: { index: false, follow: false } };

const PROVIDER = { telegram: 'Telegram', email: '邮箱' } as Record<string, string>;
const LOCALE = { 'zh-Hans': '简体', 'zh-Hant': '繁體', en: 'EN' } as Record<string, string>;
const LEVEL = { self_reported: '自报级', postback_confirmed: '回传确认级', operator_confirmed: '运营商确认级' } as const;
const TAG_TONE: Record<string, string> = { 已解决: 'green', 绑定: 'green', 已曝光: 'red', 未受理: 'muted', 驳回: 'muted' };
const md = (iso?: string) => (iso ? iso.slice(5, 10) : '');

export default async function MePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const uid = (await auth())?.user?.id;
  if (!uid) redirect('/login?callbackUrl=/me');
  const me = await getMe(db(), uid);
  if (!me) redirect('/login?callbackUrl=/me');
  const channels = await getOfficialChannels(db());
  const host = ((await headers()).get('host') ?? '').replace(/:\d+$/, '').replace(/^www\./, '');
  const official = (channels.domains ?? []).includes(host);
  const u = me.user!;
  const c = me.counts!;
  const eligibleBrands = new Set((me.bindings ?? []).filter((b) => b.compensationEligible).map((b) => b.brand?.id)).size;

  return (
    <>
      <header className="hdr">
        <div className="hdr-t">
          <b>我的</b>
          <small className="num">
            {PROVIDER[u.provider ?? ''] ?? '—'} 登录 · {u.handleMasked ?? '—'} · {u.joinedAt?.slice(0, 7)} 加入
          </small>
        </div>
      </header>

      <section className="card glass first rise" style={{ display: 'grid', gridTemplateColumns: '76px 1fr', gap: 'var(--s-7)', alignItems: 'center' }}>
        <span className="lv-ring num" aria-label={`等级 Lv${u.level}`}>
          Lv{u.level}
        </span>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <span style={{ fontSize: 20, fontWeight: 900 }}>
            {u.displayName}{' '}
            <span className="num" style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
              {[u.region, LOCALE[u.locale ?? ''] ?? u.locale, `${(u.points ?? 0).toLocaleString('en-US')} 分`].filter(Boolean).join(' · ')}
            </span>
          </span>
          <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
            {u.nextLevelAt != null ? (
              <span className="badge b-muted num">
                距 Lv{(u.level ?? 1) + 1} 还差 {(u.nextLevelAt - (u.points ?? 0)).toLocaleString('en-US')} 分
              </span>
            ) : null}
            {eligibleBrands > 0 ? (
              <span className="badge b-green">
                <Icon n="shield" s={10} w={2.6} />
                赔付资格 · {eligibleBrands} 个品牌
              </span>
            ) : (
              <span className="badge b-muted">暂无赔付资格</span>
            )}
          </div>
        </div>
      </section>

      <section className="rise tiles" style={{ margin: 'var(--s-6) var(--s-10) 0', gridTemplateColumns: 'repeat(4,1fr)', gap: 'var(--s-4)' }}>
        {[
          [c.bindings, '绑定'],
          [c.complaintsActive ? `${c.complaintsActive}/${c.complaintsTotal}` : c.complaintsTotal, '投诉'],
          [c.codes, '领过的码'],
          [c.subscriptions, '订阅'],
        ].map(([v, k]) => (
          <div key={String(k)} className="tile glass" style={{ alignItems: 'center', minHeight: 64, justifyContent: 'center', gap: 'var(--s-1)' }}>
            <b className="num">{v ?? 0}</b>
            <span>{k}</span>
          </div>
        ))}
      </section>

      <section className="card glass rise">
        <Head
          title="我的绑定"
          sub="赔付资格依据"
          link={
            <a className="link" href="/me/bind">
              添加绑定 <Icon n="chev" s={12} />
            </a>
          }
        />
        {(me.bindings ?? []).length === 0 ? <div className="row" style={{ color: 'var(--muted)', fontSize: 13 }}>还没有绑定运营商账号</div> : null}
        {(me.bindings ?? []).map((b) => (
          <a key={b.id} className="row" href={b.brand ? `/brand/${b.brand.slug}` : undefined} style={{ gridTemplateColumns: '44px 1fr auto 14px', minHeight: 62 }}>
            {b.brand ? <Logo b={b.brand} size={44} /> : <span />}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <span className="s">
                <b>{b.brand ? zhName(b.brand) : '—'}</b> 账号 <span className="num">{b.operatorAccountIdMasked}</span>
              </span>
              <span className="num d">
                {md(b.boundAt)} {b.promoCode ? `经 ${b.promoCode} 注册` : '手动绑定'} · {b.verificationLevel ? LEVEL[b.verificationLevel] : ''}
              </span>
            </div>
            {b.compensationEligible ? <span className="badge b-green">赔付 ✓</span> : <span className="badge b-muted">{b.verificationLevel === 'self_reported' ? '待确认' : '无赔付'}</span>}
            <span style={{ color: 'var(--muted)' }}>
              <Icon n="chev" s={14} />
            </span>
          </a>
        ))}
        <div className="note-row" style={{ margin: 0, paddingTop: 'var(--s-6)', borderTop: '1px solid var(--gb)' }}>
          <Icon n="info" s={13} />
          <span>赔付资格 = 认证品牌 + 纠纷前已绑定（回传确认级以上）。自报级绑定需等运营商回传确认。</span>
        </div>
      </section>

      <section className="card glass rise">
        <Head title="我的动态" sub="投诉 · 码 · 订阅" />
        {(me.activity ?? []).length === 0 ? <div className="row" style={{ color: 'var(--muted)', fontSize: 13 }}>暂无动态</div> : null}
        <Dense
          items={me.activity ?? []}
          limit={3}
          render={(a, i) => (
            <div key={i} className="row" style={{ gridTemplateColumns: '44px 1fr auto', minHeight: 48 }}>
              <span className="num d">{md(a.date)}</span>
              <span className="s">
                <b>{a.subject}</b> {a.rest}
              </span>
              <span className={`badge b-${a.tag?.startsWith('+') ? 'purple' : (TAG_TONE[a.tag ?? ''] ?? 'muted')}`}>{a.tag}</span>
            </div>
          )}
        />
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="eyebrow">官方渠道验证</span>
          <span className="num" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 'var(--s-2)', color: official ? 'var(--green)' : 'var(--amber)' }}>
            {official ? '当前站点官方' : '当前站点不在官方清单'}
          </span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 900 }}>你看到的 BYDP 是官方吗？</div>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          {[...(channels.domains ?? []), ...(channels.telegram ?? []), ...(channels.bots ?? [])].map((x) => (
            <span key={x} className="badge b-muted num" style={{ fontWeight: 500 }}>
              {x}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>其余一律视为仿冒。我们不会主动私聊你、不会索要充值。</span>
      </section>

      <section className="card glass rise" style={{ padding: 'var(--s-2) var(--s-8)' }}>
        {[
          ['globe', '语言', '简体 · 繁體 · EN', LOCALE[me.settings?.locale ?? ''] ?? '', 'muted'],
          ['send', '通知', 'TG 推送', me.settings?.notifications ? '已开' : '未开', me.settings?.notifications ? 'green' : 'muted'],
          ['shield', '负责任博彩', '自我排除 · 限额提醒', me.settings?.selfExclusion ? (me.settings.selfExclusion.endsAt ? `排除至 ${me.settings.selfExclusion.endsAt.slice(0, 10)}` : '永久排除') : '', me.settings?.selfExclusion ? 'red' : 'muted', '/me/rg'],
          ['lock', '隐私与数据', '证据原文脱敏 / 删除请求', '', 'muted', '/me/privacy'],
        ].map(([ic, t, sub, val, tone, href], i) => (
          <a
            key={t}
            href={href || undefined}
            style={{ display: 'grid', gridTemplateColumns: '22px 1fr auto 14px', gap: 'var(--s-6)', alignItems: 'center', minHeight: 52, color: 'inherit', borderTop: i ? '1px solid var(--gb)' : undefined }}
          >
            <span style={{ color: 'var(--accent)' }}>
              <Icon n={ic as 'globe'} s={17} w={1.8} />
            </span>
            <span style={{ fontSize: 14 }}>
              {t} <span style={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</span>
            </span>
            <span className="num" style={{ fontSize: 12, color: `var(--${tone})` }}>
              {val}
            </span>
            <span style={{ color: 'var(--muted)' }}>{href ? <Icon n="chev" s={14} /> : null}</span>
          </a>
        ))}
      </section>

      <section className="rise" style={{ margin: 'var(--s-6) var(--s-10) 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-4)' }}>
        <form action={signOutHere} style={{ display: 'contents' }}>
          <button className="ghost">退出登录</button>
        </form>
        <form action={signOutEverywhere} style={{ display: 'contents' }}>
          <button className="ghost" style={{ color: 'var(--red)' }}>
            退出所有设备
          </button>
        </form>
      </section>
      <Legal links={[['联盟披露', '/disclosure']]} />
    </>
  );
}
