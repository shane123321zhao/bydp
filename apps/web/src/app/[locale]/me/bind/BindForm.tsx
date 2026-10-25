'use client';
/** 添加绑定表单（原型 bind 页 · §16）：平台卡片单选 → 账号 + 来源 → 提交 → done（自报级） */
import type { BrandCard } from '@bydp/core/trust';
import { useActionState, useState } from 'react';
import { Logo, StatusBadge, zhName } from '../../../../components/atoms';
import { Icon } from '../../../../components/Icon';
import { createBindingAction, type BindState } from './actions';

export type Bindable = { brand: BrandCard; claimed: { promoCodeId: string; code: string | null } | null };

export function BindForm({ brands, initial }: { brands: Bindable[]; initial: string | null }) {
  const [state, action, pending] = useActionState<BindState, FormData>(createBindingAction, { step: 'form' });
  const [brandId, setBrandId] = useState(initial ?? brands[0]?.brand.id ?? '');
  const selected = brands.find((b) => b.brand.id === brandId);
  const [source, setSource] = useState<'promo' | 'manual'>(selected?.claimed ? 'promo' : 'manual');
  // D-025 #3（F5）：受控输入——提交失败（如账号已被绑定）后保留已填账号，不随表单动作重置清空
  const [account, setAccount] = useState('');
  const pick = (id: string) => {
    setBrandId(id);
    if (!brands.find((b) => b.brand.id === id)?.claimed) setSource('manual');
  };

  if (state.step === 'done')
    return (
      <section className="card glass first rise login-sent">
        <span className="ic" style={{ background: 'color-mix(in srgb,var(--amber) 16%,transparent)', color: 'var(--amber)' }}>
          <Icon n="lock" s={28} w={1.8} />
        </span>
        <div style={{ fontSize: 20, fontWeight: 900 }}>已提交 · 自报级</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--body)' }}>
          {state.brandName} · 账号 <b className="num">{state.masked}</b>
          <br />
          绑定时间已由服务器记录，不可更改
        </div>
        <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-6)', textAlign: 'left', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)', width: '100%' }}>
          升级为「回传确认」需要：你经 BYDP 领码链接在该平台注册或首充，且运营商回传成功。
          <br />
          赔付资格只认「回传确认」及以上等级，且须在纠纷发生前绑定。
        </div>
        <a className="btn" href="/me">
          回到我的
        </a>
      </section>
    );

  return (
    <form action={action}>
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="source" value={source} />
      <section className="card glass first rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            选择平台<small>只能绑定认证 / 观察库品牌</small>
          </h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }} role="radiogroup" aria-label="选择平台">
          {brands.map(({ brand }) => (
            <button
              key={brand.id}
              type="button"
              role="radio"
              aria-checked={brand.id === brandId}
              className="ghost pick"
              style={{ height: 56, justifyContent: 'flex-start', gap: 'var(--s-6)', padding: '0 var(--s-6)' }}
              onClick={() => pick(brand.id)}
            >
              <Logo b={brand} size={36} />
              <span style={{ flexGrow: 1, textAlign: 'left' }}>
                <b style={{ fontSize: 14 }}>{zhName(brand)}</b>
                <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                  {brand.primaryDomain ?? ''}
                </span>
              </span>
              <StatusBadge b={brand} />
            </button>
          ))}
        </div>
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            你的账号<small>在该平台的登录账号或会员 ID</small>
          </h2>
        </div>
        <div className={`fld${state.step === 'form' && state.error ? ' err' : ''}`}>
          <label htmlFor="bind-account">运营商账号 ID</label>
          <input id="bind-account" className="f num" name="account" placeholder="例如 JL88xxxx271" maxLength={128} autoComplete="off" required value={account} onChange={(e) => setAccount(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <button type="button" className="chip" aria-current={source === 'promo'} disabled={!selected?.claimed} onClick={() => setSource('promo')} title={selected?.claimed ? undefined : '你还没有在该平台领过码'}>
            经 BYDP 领码注册{selected?.claimed?.code ? ` · ${selected.claimed.code}` : ''}
          </button>
          <button type="button" className="chip" aria-current={source === 'manual'} onClick={() => setSource('manual')}>
            已有账号手动绑定
          </button>
        </div>
        {state.step === 'form' && state.error ? (
          <div className="err-line" role="alert">
            <Icon n="alert" s={13} /> {state.error}
          </div>
        ) : null}
        <div className="note-row" style={{ margin: 0 }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon n="lock" s={13} />
          </span>
          <span>账号只以加密与哈希形式保存，不存明文；同一账号只能被一个 BYDP 用户绑定。</span>
        </div>
      </section>

      <section className="rise" style={{ margin: 'var(--s-6) var(--s-10) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <button className="btn" disabled={pending || !brandId}>
          {pending ? '提交中…' : '提交绑定'} <Icon n="arrow" s={15} w={2.8} />
        </button>
        <span style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5 }}>提交后为「自报级」；经跟踪链接首充并回传成功后自动升级为「回传确认」。</span>
      </section>
    </form>
  );
}
