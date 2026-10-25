'use client';
/**
 * 隐私与数据（原型 privacy 页 · design-system §16）：数据请求三项（脱敏 / 删除原文 / 导出，处理期 7 天）+ 注销 = 匿名化（二次验证）。
 * 每项先展开确认（可填备注 ≤ 200 字）再提交；同类请求处理中时返回原请求，不重复创建。
 */
import { useState, useTransition } from 'react';
import { Icon } from '../../../../components/Icon';
import { submitDataRequestAction } from './actions';

export type MyRequest = { id: string; kind: string; status: 'pending' | 'done' | 'rejected'; createdAt: string; targets: number };

const ITEMS: [string, string, string][] = [
  ['redact_evidence', '申请证据原文脱敏', '对已提交案件的截图 / 对话做脱敏处理，哈希不变'],
  ['delete_evidence', '申请删除证据原文', '删除原文文件；哈希与状态日志保留'],
  ['export', '导出我的数据', '绑定、投诉、动态、通知（JSON）'],
];
const KIND_TEXT: Record<string, string> = { redact_evidence: '证据原文脱敏', delete_evidence: '删除证据原文', export: '导出我的数据', anonymize: '注销账号（匿名化）' };
const STATUS: Record<MyRequest['status'], [string, string]> = { pending: ['处理中', 'amber'], done: ['已完成', 'green'], rejected: ['未通过', 'muted'] };

export function PrivacyClient({ requests: initial }: { requests: MyRequest[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [requests, setRequests] = useState(initial);
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string; reauth?: boolean } | null>(null);
  const [pending, start] = useTransition();

  const toggle = (k: string) => {
    setOpen(open === k ? null : k);
    setNote('');
    setMsg(null);
  };
  const submit = (kind: string) =>
    start(async () => {
      const r = await submitDataRequestAction(kind, note);
      if (!r.ok) return setMsg({ tone: 'red', text: r.error, reauth: r.reauth });
      setOpen(null);
      setMsg(
        r.created
          ? { tone: 'green', text: `已提交「${KIND_TEXT[kind]}」· 7 天内处理，结果站内通知` }
          : { tone: 'amber', text: `已有处理中的「${KIND_TEXT[kind]}」请求，无需重复提交` },
      );
      if (r.created) setRequests([{ id: r.id, kind, status: 'pending', createdAt: new Date().toISOString(), targets: 0 }, ...requests]);
    });

  const confirmBox = (kind: string, cta: string, danger = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', padding: 'var(--s-3) 0 var(--s-5)' }}>
      <div className="fld">
        <label htmlFor={`note-${kind}`}>备注（选填，≤ 200 字）</label>
        <input id={`note-${kind}`} className="f" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} style={{ fontSize: 14, fontWeight: 400 }} />
      </div>
      <button type="button" className={danger ? 'btn btn-danger' : 'btn'} disabled={pending} onClick={() => submit(kind)}>
        {cta}
      </button>
    </div>
  );

  return (
    <>
      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            数据请求<small>处理期 7 天 · 结果站内通知</small>
          </h2>
        </div>
        {ITEMS.map(([kind, title, sub]) => (
          <div key={kind}>
            <button type="button" className="row" style={{ gridTemplateColumns: '1fr 14px' }} aria-expanded={open === kind} onClick={() => toggle(kind)}>
              <span className="s" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)', whiteSpace: 'normal' }}>
                <b>{title}</b>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
              </span>
              <span style={{ color: 'var(--muted)' }}>
                <Icon n="chev" s={14} />
              </span>
            </button>
            {open === kind ? confirmBox(kind, '确认提交') : null}
          </div>
        ))}
        {requests.length ? (
          <div style={{ borderTop: '1px solid var(--gb)', paddingTop: 'var(--s-5)', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>我的请求</span>
            {requests.map((r) => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 'var(--s-4)', alignItems: 'center', fontSize: 12 }}>
                <span className="num" style={{ color: 'var(--muted)' }}>
                  {r.createdAt.slice(5, 10)}
                </span>
                <span>
                  {KIND_TEXT[r.kind] ?? r.kind}
                  {r.targets ? <span className="num" style={{ color: 'var(--muted)' }}> · {r.targets} 份证据</span> : null}
                </span>
                {r.kind === 'export' && r.status === 'done' ? (
                  <a className="link" href={`/api/me/export/${r.id}`} rel="noreferrer">
                    下载
                  </a>
                ) : (
                  <span className={`badge b-${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {msg ? (
        <div className="err-line" role="status" style={{ margin: 'var(--s-6) var(--s-10) 0', color: `var(--${msg.tone})` }}>
          <Icon n={msg.tone === 'red' ? 'alert' : 'shield'} s={13} /> {msg.text}
          {msg.reauth ? (
            <>
              {' '}
              <a className="link" href="/login?reauth=1&callbackUrl=/me/privacy">
                重新验证身份
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="title" style={{ color: 'var(--red)' }}>
          注销账号
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--body)' }}>
          注销 = <b>匿名化</b>，不是物理删除：登录身份与联系方式立即清除、绑定账号哈希与积分归零、动态断开归属；已公开案件的摘要、状态日志、证据哈希与佣金账本按法规与仲裁可信度要求保留，但不再与你关联。注销后同一 TG / 邮箱可重新注册为新用户，历史积分不恢复（永久自我排除的身份除外）。
          <br />
          注销前请先结束进行中的投诉。自我排除期内也可注销，但同一 TG / 邮箱在排除期满前（永久排除则永不）不能重新注册。已结案投诉的证据原文会在注销时删除，只保留哈希。
        </div>
        {open === 'anonymize' ? (
          <>
            <div className="se-warn">
              <span style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }}>
                <Icon n="alert" s={13} />
              </span>
              <span>需二次验证：10 分钟内登录过才能提交。提交后 7 天内处理，结果站内通知。</span>
            </div>
            {confirmBox('anonymize', '确认申请注销', true)}
          </>
        ) : (
          <button type="button" className="ghost" style={{ color: 'var(--red)' }} onClick={() => toggle('anonymize')}>
            申请注销
          </button>
        )}
      </section>
    </>
  );
}
