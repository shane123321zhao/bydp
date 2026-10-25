import type { Metadata } from 'next';
import { cache } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { permanentRedirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { after } from 'next/server';
import { recordCandidateQuery } from '@bydp/core/trust/candidate-queries';
import { DEVICE_COOKIE, DEVICE_ID } from '@bydp/core/identity/device';
import { identityHmacKeyFromEnv } from '@bydp/core/identity/pii';
import { checkIdentifier } from '@bydp/core/usecases';
import { VERDICT_TEXT } from '@bydp/core/trust';
import { db } from '../../../../lib/db';
import { alternates, href } from '../../../../lib/seo';
import type { Locale } from '../../../../i18n/routing';
import { Icon } from '../../../../components/Icon';
import { Dense, Facts, Head, Legal, Logo, Ring, StatusBadge, Timeline, zhName } from '../../../../components/atoms';

export const dynamic = 'force-dynamic';
const run = cache((q: string) => checkIdentifier(db(), q));
const decode = (s: string) => {
  try {
    return decodeURIComponent(s).slice(0, 256);
  } catch {
    return s.slice(0, 256);
  }
};

const TAG = {
  blacklist: ['BLACKLIST · 黑名单', 'red'],
  certified: ['CERTIFIED · 平台认证', 'green'],
  fake: ['IMPERSONATION · 仿冒', 'purple'],
  watch: ['WATCHLIST · 观察', 'amber'],
  unknown: ['UNLISTED · 未收录', 'muted'],
} as const;

/** 行动区建议（固定文案，来自原型；Content(type=advice) 入库后改为读库） */
const ADVICE: Record<keyof typeof TAG, string> = {
  blacklist: '保留入金链上交易哈希、客服聊天记录与账号截图；切勿向「客服」再充值解冻。本品牌非认证商家，不适用先行赔付保障。',
  certified: '经 BYDP 领码并绑定账号后，才具备先行赔付保障资格。',
  fake: '已在此站注册或充值？立即停止操作并保留截图与交易哈希；仿冒站不适用任何赔付保障。',
  watch: '观察库品牌可发优惠码但强制风险标签、不享赔付。存入前建议小额试提。',
  unknown: '未收录不等于安全。建议等待核验结果再决定，勿先充值。',
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string; identifier: string }> }): Promise<Metadata> {
  const { locale, identifier } = await params;
  const r = await run(decode(identifier));
  // 审查 #3：标题 / canonical 只用规范化后的标识，杜绝把任意文本反射进可索引页面
  const v = r.normalized?.value ?? '';
  return {
    title: `${v} 是黑网吗？${VERDICT_TEXT[r.verdict]}`,
    description: `${v} 查验结果：${TAG[r.verdict][0]}。${r.matchNote ?? ''}`,
    alternates: alternates(locale as Locale, `/check/${encodeURIComponent(v)}`),
    // 查询结果页仅已收录实体可索引，未收录 noindex（§10 SEO 纪律）
    robots: r.verdict === 'unknown' ? { index: false, follow: true } : undefined,
  };
}

export default async function CheckPage({ params }: { params: Promise<{ locale: string; identifier: string }> }) {
  const { locale, identifier } = await params;
  setRequestLocale(locale);
  const raw = decode(identifier);
  const r = await run(raw);
  const L = (p: string) => href(locale, p);
  const q = r.normalized?.value ?? raw;
  // 非规范形（大小写、协议、路径、www、全角等）→ 308 到规范 URL，避免重复 / 垃圾 URL 被收录
  if (q !== raw) permanentRedirect(L(`/check/${encodeURIComponent(q)}`));
  // D-016 第 6 项：未收录查询计入 Candidate（同 IP 网段一天只计 1 次；响应发出后执行，不拖慢页面）
  const h = await headers();
  // Next 预取（首页「近期被查询较多」链接会触发）不计数，防止自我放大
  const prefetch = h.get('next-router-prefetch') === '1' || /prefetch/i.test(h.get('purpose') ?? h.get('sec-purpose') ?? '');
  if (r.verdict === 'unknown' && r.normalized?.type && r.normalized.value && !prefetch) {
    const did = (await cookies()).get(DEVICE_COOKIE)?.value;
    const ipRaw = process.env.BYDP_TRUST_PROXY === '1' ? (h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null) : null;
    const viewer = { ip: ipRaw, deviceId: did && DEVICE_ID.test(did) ? did : null, userAgent: h.get('user-agent') };
    const nq = { type: r.normalized.type, value: r.normalized.value };
    after(async () => {
      try {
        await recordCandidateQuery(db(), nq, viewer, identityHmacKeyFromEnv());
      } catch (e) {
        console.error(JSON.stringify({ evt: 'candidate_query_record_failed', error: (e as Error).message.slice(0, 120) }));
      }
    });
  }
  const [tag, tone] = TAG[r.verdict];
  const b = r.brand;
  const score = r.verdict === 'certified' || r.verdict === 'watch' ? b?.score?.score : null;
  const sub =
    r.verdict === 'blacklist'
      ? '黑名单不计分'
      : r.verdict === 'fake'
        ? '非官方标识不计分'
        : r.verdict === 'unknown'
          ? '暂无评分 · 已加入待查'
          : `/100 · ${({ high: '高', medium: '中', low: '低', none: '无' } as const)[b?.score?.confidence ?? 'none']}置信 · ${b?.score?.factorsAvailable ?? 0}/${b?.score?.factorsTotal ?? 5} 因子`;

  const visual =
    r.verdict === 'blacklist' ? (
      <span aria-hidden style={{ width: 92, height: 92, borderRadius: '50%', border: '2px solid var(--red)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--red)', boxShadow: '0 0 var(--glow-md) var(--red)' }} />
      </span>
    ) : r.verdict === 'fake' ? (
      <span aria-hidden style={{ width: 92, height: 92, borderRadius: '50%', border: '2px dashed var(--purple)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--purple)', flexShrink: 0 }}>
        <Icon n="alert" s={40} w={1.6} />
      </span>
    ) : r.verdict === 'unknown' ? (
      <span aria-hidden className="num" style={{ width: 92, height: 92, borderRadius: '50%', border: '2px dashed var(--track2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0, fontSize: 34 }}>
        ?
      </span>
    ) : (
      <Ring score={score} size={92} stroke={7} />
    );

  // 第二模块：黑名单 / 观察 = 关联；认证 = 因子；仿冒 = 官方标识；未收录 = 风险信号（field-mapping 02）
  const s2 =
    r.verdict === 'certified'
      ? { t: '评分因子', sub: `${b?.score?.algorithmVersion ?? ''} · 每日 02:00 重算`, rows: (r.factors ?? []).map((f) => ({ a: String(f.label ?? ''), b: String(f.detail ?? ''), pct: Number(f.score ?? 0), c: f.available ? 'green' : 'muted', tag: f.available ? `${f.score} · ${f.weight}%` : '样本不足' })) }
      : r.verdict === 'fake'
        ? { t: `${b ? zhName(b) : ''} 官方标识`, sub: '经运营商认领核验', rows: (r.officialIdentifiers ?? []).map((i) => ({ a: i.value ?? '', b: `${i.type} · ${i.firstSeen?.slice(0, 7) ?? ''} 起${i.online ? ' · 在线' : ''}`, pct: 100, c: 'green', tag: '官方' })) }
        : r.verdict === 'unknown'
          ? { t: '自动风险信号', sub: 'Agent 采集 · 待人工确认', rows: (r.riskSignals ?? []).map((s) => ({ a: s.signal ?? '', b: s.detail ?? '', pct: s.severity === 'high' ? 85 : s.severity === 'medium' ? 60 : 40, c: s.severity === 'high' ? 'red' : 'amber', tag: s.severity === 'high' ? '高危' : '待核' })) }
          : { t: r.verdict === 'blacklist' ? '关联同伙' : '风险关联', sub: '关联图谱', rows: (r.related ?? []).map((x) => ({ a: x.subject ?? '', b: x.evidence ?? '', pct: Math.round((x.confidence ?? 0) * 100), c: 'red', tag: x.confirmedBy === 'human' ? '人工确认' : '待确认' })) };

  const primary =
    r.verdict === 'certified' || r.verdict === 'watch' ? null : r.verdict === 'fake' ? { t: '去官方站', to: L(`/brand/${b?.slug}`) } : r.verdict === 'blacklist' ? { t: '查看品牌与曝光记录', to: L(`/brand/${b?.slug}`) } : null;

  return (
    <main>
      <header className="hdr">
        <a className="back" href={L('/')} aria-label="返回首页">
          <Icon n="back" />
        </a>
        <form action={L('/check')} method="get" role="search" className="glass" style={{ flexGrow: 1, minWidth: 0, minHeight: 38, borderRadius: 'var(--r-pill)', display: 'flex', alignItems: 'center', gap: 'var(--s-4)', padding: '0 var(--s-7)' }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon n="search" s={14} w={2.4} />
          </span>
          <label htmlFor="q2" className="sr">查验</label>
          <input id="q2" name="q" defaultValue={q} maxLength={256} className="num" style={{ fontSize: 13, background: 'none', border: 'none', color: 'var(--ink)', outline: 'none', minWidth: 0, flexGrow: 1 }} />
        </form>
      </header>

      <section className="card glass first rise" aria-labelledby="verdict">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          {visual}
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <span className={`badge b-${tone} stamp`} style={{ alignSelf: 'flex-start', fontSize: 11 }}>
              {tag}
            </span>
            <h1 id="verdict" style={{ margin: 0, fontSize: 34, fontWeight: 900, lineHeight: 1, color: tone === 'muted' ? 'var(--muted)' : `var(--${tone})`, letterSpacing: '-.02em' }}>
              {VERDICT_TEXT[r.verdict]}
            </h1>
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {score != null ? `${score} ` : ''}
              {sub}
            </span>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--gb)', paddingTop: 'var(--s-7)', marginTop: 'var(--s-7)' }}>
          {b ? (
            <div className="bc" style={{ gridTemplateColumns: '48px 1fr' }}>
              <Logo b={b} size={48} />
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                <div className="n">
                  <a href={L(`/brand/${b.slug}`)}>{r.verdict === 'fake' ? `冒充 ${zhName(b)}` : zhName(b)}</a>
                  {r.verdict === 'fake' ? <span className="badge b-purple">仿冒</span> : <StatusBadge b={b} />}
                </div>
                <span className="dm num">
                  {b.primaryDomain && r.verdict !== 'fake' ? <Icon n="globe" s={12} w={1.8} /> : null}
                  {[r.verdict !== 'fake' ? b.primaryDomain : null, b.name.en, r.operatorName ?? '主体不明', b.license?.licenseNo, (b.markets ?? []).join(' ')].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              未知平台 <span className="num" style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>{r.matchNote}</span>
            </div>
          )}
        </div>
        <Facts facts={r.facts ?? []} />
        <p className="adv" style={{ marginTop: 'var(--s-6)' }}>
          {r.matchNote} · 核验于 {r.checkedAt?.slice(0, 10)}
        </p>
      </section>

      {s2.rows.length ? (
        <section className="card glass rise">
          <Head title={s2.t} sub={s2.sub} />
          <Dense
            items={s2.rows}
            render={(x, i) => (
              <div key={i} className="row" style={{ gridTemplateColumns: '1fr auto', minHeight: 52 }}>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
                  <span className="s">
                    <b>{x.a}</b> {x.b}
                  </span>
                  <div className="bar">
                    <i style={{ width: `${x.pct}%`, background: `var(--${x.c})` }} />
                  </div>
                </div>
                <span className={`badge b-${x.c}`}>{x.tag}</span>
              </div>
            )}
          />
        </section>
      ) : null}

      {(r.timeline ?? []).length ? (
        <section className="card glass rise">
          <Head title="判定过程" sub="只追加 · 可审计" />
          <Timeline events={r.timeline ?? []} />
        </section>
      ) : null}

      <section className="rise" style={{ margin: 'var(--s-7) var(--s-10) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        {primary ? (
          <a className="btn" href={primary.to}>
            {primary.t} <Icon n="arrow" s={15} w={2.8} />
          </a>
        ) : null}
        {b && (r.verdict === 'certified' || r.verdict === 'watch') ? (
          <a className={r.verdict === 'certified' ? 'btn' : 'btn muted'} href={L(`/brand/${b.slug}`)}>
            看完整评测 <Icon n="chev" s={15} w={2.8} />
          </a>
        ) : null}
        <div style={{ display: 'flex', gap: 'var(--s-4)', padding: 'var(--s-4) var(--s-1) 0' }}>
          <span style={{ color: tone === 'muted' ? 'var(--muted)' : `var(--${tone})`, flexShrink: 0, marginTop: 'var(--s-1)' }}>
            <Icon n="info" s={14} />
          </span>
          <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>{ADVICE[r.verdict]}</span>
        </div>
      </section>

      {r.verdict === 'unknown' && r.suggestions?.length ? (
        <section className="card glass rise">
          <Head title="你是不是要找" sub="以下为名称相近的已收录品牌，不代表推荐；若你查的域名与其官网不一致，可能是仿冒站" />
          {r.suggestions.map((s) => (
            <a key={s.id} className="bc" href={L(`/brand/${s.slug}`)}>
              <Logo b={s} size={40} />
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                <div className="n">
                  <span className="nm">{zhName(s)}</span>
                  <StatusBadge b={s} />
                </div>
                {s.primaryDomain ? (
                  <span className="dm num">
                    <Icon n="globe" s={12} w={1.8} />
                    {s.primaryDomain}
                  </span>
                ) : null}
              </div>
            </a>
          ))}
        </section>
      ) : null}

      {r.alternative ? (
        <section className="card glass rise">
          <Head title="同类可信平台" sub="仅按公开评分排序 · 不收费" />
          <a className="bc" href={L(`/brand/${r.alternative.slug}`)}>
            <Logo b={r.alternative} size={48} />
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <div className="n">
                <span className="nm">{zhName(r.alternative)}</span>
                <StatusBadge b={r.alternative} />
              </div>
              <span className="dm num">
                {r.alternative.primaryDomain ? <Icon n="globe" s={12} w={1.8} /> : null}
                {[r.alternative.primaryDomain, r.alternative.license?.regulator].filter(Boolean).join(' · ')}
              </span>
            </div>
            <Ring score={r.alternative.score?.score} size={52} stroke={4} />
          </a>
        </section>
      ) : null}

      <Legal
        links={[
          ['评分方法', L('/methodology')],
          ['服务地区', L('/regions')],
          ['联盟披露', L('/disclosure')],
        ]}
      />
    </main>
  );
}
