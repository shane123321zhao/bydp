'use client';
/**
 * D-024 提交出款凭证（field-mapping 03 行动「提交出款凭证」· 原型 Brand.dc.html 行动区）：
 * 选本人已绑定的平台 → 金额 / 方式 / 申请时间 / 结果（已到账带到账时间）→ 截图（1–3 张，必传）→ 提交后待审。
 * 时间输入为本地时间，提交前换算为 ISO（带时区）；不得晚于当前时间（库触发器兜底）。
 */
import type { BrandCard } from '@bydp/core/trust';
import { useActionState, useRef, useState } from 'react';
import { Logo, StatusBadge, zhName } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { submitWithdrawalAction, type WithdrawalState } from './actions';

const METHODS = ['USDT-TRC20', 'USDT-ERC20', '银行转账', '电子钱包'] as const;
const OUTCOMES = [
  ['paid', '已到账'],
  ['refused', '被拒付'],
  ['pending', '还没到账'],
] as const;
const toIso = (v: string) => (v ? new Date(v).toISOString() : '');

export function WithdrawalForm({ brands, initial, nowLocal }: { brands: BrandCard[]; initial: string | null; nowLocal: string }) {
  const [state, action, pending] = useActionState<WithdrawalState, FormData>(submitWithdrawalAction, { step: 'form' });
  const [brandId, setBrandId] = useState(initial ?? brands[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>(METHODS[0]);
  const [requestedAt, setRequestedAt] = useState('');
  const [outcome, setOutcome] = useState<'paid' | 'refused' | 'pending'>('paid');
  const [receivedAt, setReceivedAt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const err = state.step === 'form' ? state.error : undefined;

  if (state.step === 'done')
    return (
      <section className="card glass first rise login-sent">
        <span className="ic">
          <Icon n="shield" s={28} w={1.8} />
        </span>
        <div style={{ fontSize: 20, fontWeight: 900 }}>已提交 · 待审核</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--body)' }}>
          凭证与 {state.files} 张截图已存档（服务端计算哈希）。审核通过后计入该平台出款统计，并发放积分；结果会站内通知你。
        </div>
        <a className="btn" href="/me">
          回到我的
        </a>
      </section>
    );

  return (
    <form action={action}>
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="method" value={method} />
      <input type="hidden" name="outcome" value={outcome} />
      <input type="hidden" name="requestedAt" value={toIso(requestedAt)} />
      <input type="hidden" name="receivedAt" value={outcome === 'paid' ? toIso(receivedAt) : ''} />
      <section className="card glass first rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            选择平台<small>只能为本人已绑定的平台提交</small>
          </h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }} role="radiogroup" aria-label="选择平台">
          {brands.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={b.id === brandId}
              className="ghost pick"
              style={{ height: 56, justifyContent: 'flex-start', gap: 'var(--s-6)', padding: '0 var(--s-6)' }}
              onClick={() => setBrandId(b.id)}
            >
              <Logo b={b} size={36} />
              <span style={{ flexGrow: 1, textAlign: 'left' }}>
                <b style={{ fontSize: 14 }}>{zhName(b)}</b>
                <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                  {b.primaryDomain ?? ''}
                </span>
              </span>
              <StatusBadge b={b} />
            </button>
          ))}
        </div>
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            这次出款<small>金额 · 方式 · 时间 · 结果</small>
          </h2>
        </div>
        <div className={`fld${err ? ' err' : ''}`}>
          <label htmlFor="wr-amount">金额 USDT</label>
          <input id="wr-amount" className="f num" name="amountUsdt" inputMode="decimal" placeholder="例如 500" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }} role="radiogroup" aria-label="出款方式">
          {METHODS.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} className="chip" aria-current={method === m} onClick={() => setMethod(m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="fld">
          <label htmlFor="wr-requested">申请提款时间</label>
          <input id="wr-requested" className="f num" type="datetime-local" max={nowLocal} required value={requestedAt} onChange={(e) => setRequestedAt(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }} role="radiogroup" aria-label="出款结果">
          {OUTCOMES.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={outcome === k} className="chip" aria-current={outcome === k} onClick={() => setOutcome(k)}>
              {l}
            </button>
          ))}
        </div>
        {outcome === 'paid' ? (
          <div className="fld">
            <label htmlFor="wr-received">到账时间</label>
            <input id="wr-received" className="f num" type="datetime-local" min={requestedAt || undefined} max={nowLocal} required value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </div>
        ) : null}
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            出款截图<small>1–3 张 · 必传 · 上传即哈希存档</small>
          </h2>
        </div>
        <input ref={fileRef} type="file" name="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 3))} />
        <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>
          {files.length ? `已选 ${files.length} 张（重新选择）` : '选择截图（≤ 20MB / 张）'}
        </button>
        {err ? (
          <div className="err-line" role="alert">
            <Icon n="alert" s={13} /> {err}
          </div>
        ) : null}
        <div className="note-row" style={{ margin: 0 }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon n="lock" s={13} />
          </span>
          <span>截图只用于审核，不公开；原文可随时申请删除，哈希与审核记录保留。同一绑定账号 30 天内最多 3 份。</span>
        </div>
      </section>

      <section className="rise" style={{ margin: 'var(--s-6) var(--s-10) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <button className="btn" disabled={pending || !brandId || !files.length}>
          {pending ? '提交中…' : '提交出款凭证'} <Icon n="arrow" s={15} w={2.8} />
        </button>
        <span style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5 }}>审核通过后计入出款统计（评分只计「绑定后」的出款），积分 +50。</span>
      </section>
    </form>
  );
}
