'use server';
/**
 * D-023 网页领码：与 POST /offers/{id}/claim、TG Bot 同一用例 claimOfferForUser（记 Click、自我排除期拒绝）。
 * userId 只取自会话；region 取 CF-IPCountry（经 Caddy 只在 Cloudflare 回源时保留）。拒绝原因沿用 tracking CLAIM_REJECT 文案。
 */
import { headers } from 'next/headers';
import { CLAIM_REJECT, claimOfferForUser, TrackingError } from '@bydp/core/commerce/tracking';
import { SelfExcludedError } from '@bydp/core/identity/self-exclusion';
import { auth } from '../../../auth';
import { db } from '../../../lib/db';

export type ClaimState =
  | { step: 'idle'; error?: string }
  | { step: 'done'; code: string | null; trackingUrl: string | null; riskLabel: string | null }
  | { step: 'login' };

export async function claimOfferAction(_prev: ClaimState, form: FormData): Promise<ClaimState> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { step: 'login' };
  const offerId = String(form.get('offerId') ?? '');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(offerId)) return { step: 'idle', error: '优惠不存在或已下线' };
  const cc = (await headers()).get('cf-ipcountry')?.toUpperCase();
  try {
    const r = await claimOfferForUser(db(), { userId: uid, offerId, region: cc && /^[A-Z]{2}$/.test(cc) ? cc : null });
    return { step: 'done', code: r.code, trackingUrl: r.trackingUrl, riskLabel: r.riskLabel };
  } catch (e) {
    if (e instanceof SelfExcludedError) return { step: 'idle', error: '自我排除期内，不可领码' };
    if (e instanceof TrackingError) return { step: 'idle', error: CLAIM_REJECT[e.code]?.body.message ?? '暂时无法领取，请稍后再试' };
    throw e;
  }
}
