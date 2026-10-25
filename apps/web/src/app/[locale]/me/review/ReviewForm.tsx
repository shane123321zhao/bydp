'use client';
/**
 * D-024 写评价（裁定 ③：入口在品牌页评分因子「玩家评价」行右侧「写评价」）：选本人已绑定的平台 → 1–5 星 → 文字（选填 ≤ 500 字）。
 * 待审；可信权重按绑定等级由服务端写入；文字不公开（裁定 ④），只用于计分与计数。
 */
import type { BrandCard } from '@bydp/core/trust';
import { useActionState, useState } from 'react';
import { Logo, StatusBadge, zhName } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { submitReviewAction, type ReviewState } from './actions';

export function ReviewForm({ brands, initial }: { brands: BrandCard[]; initial: string | null }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(submitReviewAction, { step: 'form' });
  const [brandId, setBrandId] = useState(initial ?? brands[0]?.id ?? '');
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const err = state.step === 'form' ? state.error : undefined;

  if (state.step === 'done')
    return (
      <section className="card glass first rise login-sent">
        <span className="ic">
          <Icon n="shield" s={28} w={1.8} />
        </span>
        <div style={{ fontSize: 20, fontWeight: 900 }}>已提交 · 待审核</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--body)' }}>审核通过后计入该平台「玩家评价」因子，积分 +20；结果会站内通知你。评价文字不对外展示。</div>
        <a className="btn" href="/me">
          回到我的
        </a>
      </section>
    );

  return (
    <form action={action}>
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="rating" value={rating || ''} />
      <section className="card glass first rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            选择平台<small>只能评价本人已绑定的平台 · 每个平台一条</small>
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
              </span>
              <StatusBadge b={b} />
            </button>
          ))}
        </div>
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            你的评价<small>1–5 星 · 文字选填</small>
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }} role="radiogroup" aria-label="评分">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} className="chip" aria-current={rating === n} onClick={() => setRating(n)}>
              {n} 星
            </button>
          ))}
        </div>
        <div className={`fld${err ? ' err' : ''}`}>
          <label htmlFor="rv-text">经历（选填，不含个人信息）</label>
          <textarea id="rv-text" className="f" name="text" maxLength={500} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          <span className="num" style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'flex-end' }}>
            {text.length} / 500
          </span>
        </div>
        {err ? (
          <div className="err-line" role="alert">
            <Icon n="alert" s={13} /> {err}
          </div>
        ) : null}
        <div className="note-row" style={{ margin: 0 }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon n="lock" s={13} />
          </span>
          <span>评价文字不公开，只用于计分；可信权重按你的绑定等级计算（回传确认最高）。</span>
        </div>
      </section>

      <section className="rise" style={{ margin: 'var(--s-6) var(--s-10) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <button className="btn" disabled={pending || !brandId || !rating}>
          {pending ? '提交中…' : '提交评价'} <Icon n="arrow" s={15} w={2.8} />
        </button>
      </section>
    </form>
  );
}
