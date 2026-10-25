/**
 * 转化回传写入（A-007 §2 · G2 / G4）。调用前提：已验签（signature.ts），且 core 已用同一规范化 + HMAC 算出账号哈希、
 * 查出 (brandId, hash) 对应绑定的 userId（本包不读 user_brand_binding）。
 * - 只追加：(brandId, externalEventId) 重复 → duplicate，不重复处理；更正 = event reversal + reversesId，同一行至多冲正一次。
 * - 归因：末次点击、30 天窗口。带 clickId → 须存在且同品牌，否则拒绝；超窗不归因（clickId 记空，原文留 raw）。
 *   不带 clickId → 取绑定用户在同品牌窗口内最后一次 Click；不用明文账号匹配。
 * - 窗口以服务端接收时间为基准（occurredAt 由运营商提供，不作归因依据）。
 * - A-013：不存账号明文（只存盲索引）；raw 只存白名单字段（sanitizePostbackRaw）。
 */
import { normalizeOperatorAccountId, schema, sql, type Db } from '@bydp/db';
import { z } from 'zod';
import { TrackingError } from './errors';
import { ATTRIBUTION_WINDOW_DAYS } from './params';
import { rows, toDate, type Exec } from './rows';

export const PostbackBody = z
  .object({
    externalEventId: z.string().min(1).max(128),
    event: z.enum(['register', 'first_deposit', 'deposit', 'reversal']),
    operatorAccountId: z.string().max(128),
    clickId: z.string().min(1).max(64).nullish(),
    amountUsdt: z.number().nonnegative().max(1e12).nullish(),
    occurredAt: z.iso.datetime({ offset: true }).nullish(),
    /** 冲正时指向运营商侧原事件 id */
    reversesExternalEventId: z.string().min(1).max(128).nullish(),
  })
  .refine((b) => (b.event === 'reversal') === Boolean(b.reversesExternalEventId), {
    message: 'reversal 必须且只能带 reversesExternalEventId',
    path: ['reversesExternalEventId'],
  })
  .refine((b) => normalizeOperatorAccountId(b.operatorAccountId) !== '', { message: '不能为空', path: ['operatorAccountId'] });
export type PostbackBody = z.infer<typeof PostbackBody>;

/**
 * A-013：回传原文 raw 白名单——只保留 PostbackBody 规范字段，且不含账号（operatorAccountId 只以盲索引存）。
 * 运营商多传的字段（如 username / email）一律不入库；DB 另有 CHECK conversion_raw_no_account 兜底。
 */
export const RAW_FIELDS = ['externalEventId', 'event', 'clickId', 'amountUsdt', 'occurredAt', 'reversesExternalEventId'] as const;

export function sanitizePostbackRaw(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  return Object.fromEntries(RAW_FIELDS.filter((k) => k in src).map((k) => [k, src[k]]));
}

export type RecordedConversion = {
  id: string;
  brandId: string;
  event: PostbackBody['event'];
  clickId: string | null;
  reversesId: string | null;
  operatorAccountIdHash: string;
  amountUsdt: number | null;
  receivedAt: Date;
};

export type RecordResult =
  | { status: 'recorded'; conversion: RecordedConversion }
  | { status: 'duplicate'; conversionId: string }
  | { status: 'already_reversed'; conversionId: string };

type Tx = Exec & Pick<Db, 'insert'>;

async function findByExternalId(db: Exec, brandId: string, externalEventId: string) {
  const [r] = await rows<{ id: string; event: string; clickId: string | null }>(
    db,
    sql`select "id", "event", "clickId" from "conversion" where "brandId" = ${brandId} and "externalEventId" = ${externalEventId}`,
  );
  return r;
}

/** 带 clickId：校验存在且同品牌；返回窗口内的 clickId 或 null */
async function attributeByClickId(db: Exec, brandId: string, clickId: string) {
  const [c] = await rows<{ brandId: string; inWindow: boolean }>(
    db,
    sql`select "brandId", "createdAt" >= now() - make_interval(days => ${ATTRIBUTION_WINDOW_DAYS}) as "inWindow"
        from "click" where "id" = ${clickId}`,
  );
  if (!c) throw new TrackingError('click_not_found');
  if (c.brandId !== brandId) throw new TrackingError('click_brand_mismatch');
  return c.inWindow ? clickId : null;
}

/** 不带 clickId：绑定用户在同品牌 30 天内的末次点击 */
async function attributeByUser(db: Exec, brandId: string, userId: string) {
  const [c] = await rows<{ id: string }>(
    db,
    sql`select "id" from "click"
        where "brandId" = ${brandId} and "userId" = ${userId}
          and "createdAt" >= now() - make_interval(days => ${ATTRIBUTION_WINDOW_DAYS})
        order by "createdAt" desc, "id" desc limit 1`,
  );
  return c?.id ?? null;
}

export async function recordConversion(
  db: Tx,
  brandId: string,
  body: PostbackBody,
  ctx: { operatorAccountIdHash: string; bindingUserId: string | null; raw: unknown },
): Promise<RecordResult> {
  const dup = await findByExternalId(db, brandId, body.externalEventId);
  if (dup) return { status: 'duplicate', conversionId: dup.id };

  let clickId: string | null = null;
  let reversesId: string | null = null;
  if (body.event === 'reversal') {
    const orig = await findByExternalId(db, brandId, body.reversesExternalEventId!);
    if (!orig) throw new TrackingError('reversal_target_not_found');
    if (orig.event === 'reversal') throw new TrackingError('reversal_target_invalid');
    reversesId = orig.id;
    clickId = orig.clickId;
  } else if (body.clickId) {
    clickId = await attributeByClickId(db, brandId, body.clickId);
  } else if (ctx.bindingUserId) {
    clickId = await attributeByUser(db, brandId, ctx.bindingUserId);
  }

  const amountUsdt = body.amountUsdt == null ? null : Math.round(body.amountUsdt * 100) / 100;
  const [row] = await db
    .insert(schema.conversions)
    .values({
      brandId,
      clickId,
      externalEventId: body.externalEventId,
      operatorAccountIdHash: ctx.operatorAccountIdHash,
      event: body.event,
      reversesId,
      amountUsdt,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
      raw: sanitizePostbackRaw(ctx.raw),
    })
    .onConflictDoNothing()
    .returning({ id: schema.conversions.id, receivedAt: schema.conversions.receivedAt });

  if (!row) {
    // 并发竞争：同 externalEventId 已写入 → duplicate；否则只可能是 conversion_reverses_once_uq
    const again = await findByExternalId(db, brandId, body.externalEventId);
    if (again) return { status: 'duplicate', conversionId: again.id };
    return { status: 'already_reversed', conversionId: reversesId! };
  }
  return {
    status: 'recorded',
    conversion: {
      id: row.id,
      brandId,
      event: body.event,
      clickId,
      reversesId,
      operatorAccountIdHash: ctx.operatorAccountIdHash,
      amountUsdt,
      receivedAt: toDate(row.receivedAt),
    },
  };
}
