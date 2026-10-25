/**
 * 05 本人案件页（原型 complaint progress 态 · field-mapping 05「进度」· D-014）。需登录，只看本人案件（他人 / 不存在 → 404）。
 * 三态：进行中（初筛 / 受理 / 答辩 / 仲裁）· 已结束（已解决 / 驳回 / 未解决）· 已曝光。
 * 字段：Complaint.status · .replyDeadline · .amountUsdt · 通知次数（operatorNotifiedAt / secondNoticeAt 派生）· StatusHistory · Evidence。
 */
import { STATUS_TEXT } from '@bydp/core/complaint/cases';
import { getMyComplaintBrand } from '@bydp/core/complaint/form';
import { getMyComplaint } from '@bydp/core/complaint/mine';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../../../auth';
import { Kpis, Legal, Logo, StatusBadge, Timeline, fmtUsdt, zhName } from '../../../../../components/atoms';
import { Icon } from '../../../../../components/Icon';
import { Steps, stepOf } from '../../../../../components/Steps';
import { db } from '../../../../../lib/db';
import { AddEvidence } from './AddEvidence';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '我的投诉', robots: { index: false, follow: false } };

const ACTIVE = ['screening', 'accepted', 'awaiting_reply', 'arbitrating'];
const STAMP: Record<string, string> = {
  screening: 'b-muted',
  accepted: 'b-accent',
  awaiting_reply: 'b-amber',
  arbitrating: 'b-amber',
  resolved: 'b-green',
  rejected: 'b-muted',
  unresolved: 'b-amber',
  exposed: 'b-red',
};
const EV_TYPE: Record<string, string> = { screenshot: '截图', chat_log: '客服对话', tx_hash: '交易哈希', other: '其他' };
const md = (iso?: string | null) => (iso ? iso.slice(5, 10) : '');
/** 案件号展示：新案件 id 较长（cp_ + 32 位），标题处缩写为 cp_…后 6 位；seed 短号原样 */
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 3)}…${id.slice(-6)}` : id);

function countdown(deadline: string | null | undefined): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return '已届满';
  const h = Math.floor(ms / 3600_000);
  return h >= 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 时` : `${h} 时`;
}

export default async function MyComplaintPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ w?: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const uid = (await auth())?.user?.id;
  if (!uid) redirect(`/login?callbackUrl=${encodeURIComponent(`/me/complaints/${id}`)}`);
  const [c, brand] = await Promise.all([getMyComplaint(db(), uid, id), getMyComplaintBrand(db(), uid, id)]);
  if (!c) notFound();
  const warning = (await searchParams).w;
  const status = c.status ?? 'screening';
  const active = ACTIVE.includes(status);
  const { cur, red } = stepOf(status);
  const rejectReason = status === 'rejected' ? (c.timeline ?? []).filter((t) => t.subject === STATUS_TEXT.rejected && t.rest).at(-1)?.rest : null;

  const note =
    status === 'screening'
      ? '已提交，等待人工初筛。受理后会通知运营商，答辩期 7 天。'
      : status === 'accepted'
        ? '已受理，将经官方渠道通知运营商并开始 7 天答辩期。'
        : status === 'awaiting_reply'
          ? `已于 ${md(c.timeline?.find((t) => t.subject === '通知运营商')?.date)} 通知运营商，答辩期至 ${md(c.replyDeadline)}。期内无响应将二次通知；两次通知无响应，经仲裁员确认后转曝光。`
          : status === 'arbitrating'
            ? '运营商已答辩，仲裁中。'
            : status === 'resolved'
              ? `已解决${c.resolvedAt ? ` · ${md(c.resolvedAt)}` : ''}。`
              : status === 'rejected'
                ? `未予受理${rejectReason ? `：${rejectReason}` : '。'}`
                : status === 'unresolved'
                  ? '仲裁未能解决，将按规则处理后续曝光。'
                  : `运营商未回应，案件已公开曝光${c.exposedAt ? ` · ${md(c.exposedAt)}` : ''}。`;

  return (
    <>
      <header className="hdr">
        <a className="back" href="/me" aria-label="返回我的">
          <Icon n="back" />
        </a>
        <div className="hdr-t" style={{ minWidth: 0 }}>
          <b>我的投诉 · #{shortId(c.id!)}</b>
          <small className="num">{[brand ? zhName(brand) : null, c.title].filter(Boolean).join(' · ')}</small>
        </div>
        <span className="badge b-muted">{active ? '进行中' : status === 'exposed' ? '已曝光' : '已结束'}</span>
      </header>

      {warning ? (
        <div className="err-line" role="alert" style={{ margin: 'var(--s-6) var(--s-10) 0' }}>
          <Icon n="alert" s={13} /> {warning}
        </div>
      ) : null}

      <section className="card glass first rise">
        <Steps cur={cur} red={red} done={status === 'resolved'} />
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="head" style={{ paddingBottom: 0 }}>
          <h2 className="title" style={{ margin: 0 }}>
            {active ? '当前状态' : '处理结果'}
            <small className="num">#{shortId(c.id!)}</small>
          </h2>
          <span className={`badge ${STAMP[status] ?? 'b-muted'} stamp`}>{STATUS_TEXT[status] ?? status}</span>
        </div>
        <Kpis
          items={[
            status === 'awaiting_reply'
              ? { v: countdown(c.replyDeadline) ?? '—', k: `答辩截止 ${md(c.replyDeadline)}`, tone: 'amber' as const }
              : { v: STATUS_TEXT[status] ?? status, k: '当前节点', tone: red ? ('red' as const) : status === 'resolved' ? ('green' as const) : undefined },
            { v: `${fmtUsdt(c.amountUsdt ?? 0)} U`, k: '涉及金额' },
            { v: `${c.notices ?? 0} / 2`, k: '通知次数' },
          ]}
        />
        <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--body)' }}>{note}</span>
        {brand ? (
          <a
            href={status === 'exposed' ? `/brand/${brand.slug}/complaints` : `/brand/${brand.slug}`}
            style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto 14px', gap: 'var(--s-5)', alignItems: 'center', borderTop: '1px solid var(--gb)', paddingTop: 'var(--s-5)', color: 'inherit' }}
          >
            <Logo b={brand} size={36} />
            <span style={{ fontSize: 13 }}>{status === 'exposed' ? `${zhName(brand)} · 查看公开投诉记录` : zhName(brand)}</span>
            <StatusBadge b={brand} />
            <span style={{ color: 'var(--muted)' }}>
              <Icon n="chev" s={14} />
            </span>
          </a>
        ) : null}
      </section>

      <section className="card glass rise">
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            处理记录<small>只追加 · 可审计</small>
          </h2>
        </div>
        <Timeline events={c.timeline ?? []} />
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            证据<small>{(c.evidence ?? []).length} 项 · 哈希已存档</small>
          </h2>
        </div>
        {(c.evidence ?? []).length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', paddingBottom: 'var(--s-3)' }}>暂无证据</div> : null}
        {(c.evidence ?? []).map((e) => (
          <div key={e.id} className="row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span className="s">
              <b>{e.label ?? EV_TYPE[e.type ?? ''] ?? e.type}</b>{' '}
              <span className="num d">
                {md(e.uploadedAt)} · {e.sha256 ? `${e.sha256.slice(0, 4)}…${e.sha256.slice(-4)}` : ''}
              </span>
            </span>
            {e.redacted ? <span className="badge b-muted">已脱敏</span> : null}
          </div>
        ))}
        {active || status === 'unresolved' ? <AddEvidence complaintId={c.id!} /> : null}
        <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--muted)', paddingTop: 'var(--s-4)' }}>
          原文可随时在「隐私与数据」申请脱敏 / 删除；哈希与状态日志永久保留（只追加）。
        </span>
      </section>
      <Legal links={[]} />
    </>
  );
}
