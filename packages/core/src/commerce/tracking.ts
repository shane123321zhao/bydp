/**
 * 领码 / postback 用例（A-007）。apps 只经本模块调用 @bydp/tracking。
 * 与 `./index`（纯 zod，前端可引）分开：本模块连 DB。ADR-0006：packages/scoring 禁止依赖。
 */
import { bindingHmacKeyFromEnv, hashOperatorAccountId, normalizeOperatorAccountId, type Db } from '@bydp/db';
import {
  claimOffer,
  loadPostbackIntegration,
  PostbackBody,
  recordConversion,
  settleCommission,
  TrackingError,
  verifyPostbackSignature,
  type ClaimInput,
  type RecordResult,
  type SettleResult,
} from '@bydp/tracking';
import { confirmBindingByPostback, findBindingByAccountHash, type PostbackConfirmResult } from '../identity/bindings';
import type { ClaimResponse } from './index';
import { getOfferRiskLabel } from './offers';
import type { ApiError } from '../shared/index';
import { assertNotSelfExcluded } from '../identity/self-exclusion';

export { claimOffer, TrackingError, type ClaimInput };

/**
 * 领码拒绝 → HTTP + 契约 Error 体（W2#066）。已过期按契约 404「优惠不存在或已下线」；409 = 黑名单 / 关联方 / 自我排除期。
 */
export const CLAIM_REJECT: Partial<Record<TrackingError['code'], { status: 400 | 404 | 409; body: ApiError }>> = {
  offer_not_found: { status: 404, body: { code: 'not_found', message: '优惠不存在或已下线' } },
  offer_expired: { status: 404, body: { code: 'not_found', message: '优惠不存在或已下线' } },
  brand_blacklisted: { status: 409, body: { code: 'blacklist', message: '该平台在黑名单中，不可领取' } },
  related_party_exclusive: { status: 409, body: { code: 'related_party', message: '关联方平台不可领取' } },
  partner_invalid: { status: 400, body: { code: 'invalid_argument', message: '合作方无效' } },
};
export const SELF_EXCLUDED_ERROR: ApiError = { code: 'self_excluded', message: '自我排除期内，不可领码或添加绑定' };

/**
 * POST /offers/{id}/claim（契约 v1.6）：userId 只取自会话；region 取 CF-IPCountry。
 * 契约未定义 slot / channel / partner 入参，暂不接收（接入 KOL 链接时先补契约）。
 */
export async function claimOfferForUser(
  db: Pick<Db, 'transaction' | 'execute'>,
  p: { userId: string; offerId: string; region: string | null },
): Promise<ClaimResponse> {
  await assertNotSelfExcluded(db, p.userId); // A-011：自我排除期内不可领码（含前往官网链接）
  const r = await claimOffer(db, { userId: p.userId, offerId: p.offerId, region: p.region });
  return { clickId: r.clickId, code: r.code, trackingUrl: r.trackingUrl, riskLabel: await getOfferRiskLabel(db, p.offerId) };
}

export type PostbackRequest = {
  brandId: string;
  /** X-BYDP-Timestamp（Unix 秒） */
  timestamp: string | null | undefined;
  /** X-BYDP-Signature（hex，可带 sha256= 前缀） */
  signature: string | null | undefined;
  /** 原始请求体（验签覆盖原文，须在解析前取得） */
  rawBody: string;
};

export type PostbackOutcome =
  | { ok: false; httpStatus: 400 | 401 | 404 | 409; reason: string }
  | {
      ok: true;
      httpStatus: 200;
      conversion: RecordResult;
      binding: PostbackConfirmResult | 'skipped';
      commission: SettleResult | null;
    };

const REJECT_STATUS: Record<TrackingError['code'], 400 | 404 | 409> = {
  offer_not_found: 404,
  offer_expired: 409,
  brand_blacklisted: 409,
  related_party_exclusive: 409,
  partner_invalid: 400,
  click_not_found: 400,
  click_brand_mismatch: 400,
  reversal_target_not_found: 409,
  reversal_target_invalid: 400,
};

/**
 * 顺序：对接配置 → 验签 → 解析 → 事务内（哈希 → 绑定匹配 → 写转化 → 绑定升级 → 佣金）。
 * 限流 / 请求体上限 / 验签失败日志（审核 R2）在 api 端点层实现（M2 收尾）。
 */
export async function handlePostback(
  db: Pick<Db, 'transaction' | 'execute'>,
  req: PostbackRequest,
  opts: { env?: Record<string, string | undefined>; bindingHmacKey?: string; nowMs?: number } = {},
): Promise<PostbackOutcome> {
  const integration = await loadPostbackIntegration(db, req.brandId, opts.env);
  // secret_ref_invalid / secret_missing 属我方配置问题 → 503（不向调用方透露密钥引用）
  // D-008 #5：未对接 / 配置缺失 / 验签失败对外一律 401（防探测商业对接，ADR-0006）；reason 保留真实原因供内部日志
  if (!integration.ok) return { ok: false, httpStatus: 401, reason: integration.reason };
  const sig = verifyPostbackSignature({ secret: integration.secret, windowSec: integration.windowSec, timestamp: req.timestamp, signature: req.signature, rawBody: req.rawBody, nowMs: opts.nowMs });
  if (!sig.ok) return { ok: false, httpStatus: 401, reason: sig.reason };

  let raw: unknown;
  try {
    raw = JSON.parse(req.rawBody);
  } catch {
    return { ok: false, httpStatus: 400, reason: 'invalid_json' };
  }
  const parsed = PostbackBody.safeParse(raw);
  if (!parsed.success) return { ok: false, httpStatus: 400, reason: 'invalid_body' };
  const body = parsed.data;
  const hash = hashOperatorAccountId(normalizeOperatorAccountId(body.operatorAccountId), opts.bindingHmacKey ?? bindingHmacKeyFromEnv());

  try {
    return await db.transaction(async (tx) => {
      const binding = await findBindingByAccountHash(tx, req.brandId, hash);
      const conversion = await recordConversion(tx, req.brandId, body, { operatorAccountIdHash: hash, bindingUserId: binding?.userId ?? null, raw });
      if (conversion.status !== 'recorded') return { ok: true as const, httpStatus: 200 as const, conversion, binding: 'skipped' as const, commission: null };
      const cv = conversion.conversion;
      // K1：只有运营商自带、且在窗口内归因成立的 clickId 才能作归属证明（哈希兜底归因不算）
      const operatorClickId = body.clickId && cv.clickId === body.clickId ? cv.clickId : null;
      const bindingResult =
        cv.event === 'reversal'
          ? ('skipped' as const)
          : await confirmBindingByPostback(tx, { signatureVerified: true, brandId: req.brandId, operatorAccountIdHash: hash, postbackAt: cv.receivedAt, operatorClickId });
      const commission = await settleCommission(tx, cv);
      return { ok: true as const, httpStatus: 200 as const, conversion, binding: bindingResult, commission };
    });
  } catch (e) {
    if (e instanceof TrackingError) return { ok: false, httpStatus: REJECT_STATUS[e.code], reason: e.code };
    throw e;
  }
}
