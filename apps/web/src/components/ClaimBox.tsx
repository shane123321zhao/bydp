'use client';
/**
 * D-023 领码块（07 优惠 Tab · field-mapping「领码 → POST /offers/{id}/claim」）：
 * 未登录 → 「登录领码」链接到登录页并带回跳；已登录 → 「领码」提交服务端动作，成功后显示专属码与「前往官网」（跟踪链接，含 Click 归因）。
 * 自我排除期 / 黑名单 / 下线 / 过期的优惠在列表层已不渲染本组件；服务端仍会兜底拒绝。
 */
import { useActionState } from 'react';
import { claimOfferAction, type ClaimState } from '../app/[locale]/offers/actions';
import { Icon } from './Icon';

export function ClaimBox({ offerId, loggedIn, loginHref }: { offerId: string; loggedIn: boolean; loginHref: string }) {
  const [state, action, pending] = useActionState<ClaimState, FormData>(claimOfferAction, { step: 'idle' });
  if (!loggedIn || state.step === 'login')
    return (
      <div className="code">
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>专属优惠码</div>
          <b className="num">登录后领取</b>
        </div>
        <a className="btn sm" href={loginHref}>
          <Icon n="lock" s={12} w={2.4} /> 登录领码
        </a>
      </div>
    );
  if (state.step === 'done')
    return (
      <div className="code" aria-live="polite">
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>专属优惠码</div>
          <b className="num" data-testid="claimed-code">
            {state.code ?? '已记录领取'}
          </b>
        </div>
        {state.trackingUrl ? (
          <a className="btn sm" href={state.trackingUrl} rel="nofollow noopener noreferrer" target="_blank">
            前往官网 <Icon n="ext" s={12} w={2.6} />
          </a>
        ) : (
          <span className="btn sm muted" aria-disabled="true">
            官网链接待核验
          </span>
        )}
      </div>
    );
  return (
    <form action={action} className="code">
      <input type="hidden" name="offerId" value={offerId} />
      <div>
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>专属优惠码</div>
        <b className="num">{state.error ?? '点击领取'}</b>
      </div>
      <button className="btn sm" type="submit" disabled={pending}>
        {pending ? '领取中…' : '领码'}
      </button>
    </form>
  );
}
