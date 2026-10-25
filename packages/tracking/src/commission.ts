/**
 * 佣金（A-007 §2 · G3）。commission 只追加账本，状态在 commission_event（只追加，取最新一条）。
 * - 硬拦截（ADR-0003）：品牌黑名单或主体为关联方 → 不生成佣金（DB 触发器 bydp_commission_eligibility_guard 兜底）。
 * - 条款：按接收日（UTC）取生效条款，同合作方优先，再取「不限合作方」。
 * - 计费（§8 v1.6 / D-006）：**P1 只结 CPA**——只由 first_deposit 触发，同品牌同账号哈希只结一次（被冲正作废的也计入）；
 *   RevShare 按净游戏收入月结，待运营商净收入回传格式确认后单独提审，P1 遇 revshare 条款记跳过原因、不产生佣金；
 *   register 不产生佣金；未归因（无 Click）不产生佣金；合作方已停用 → 其历史点击带来的转化不结佣。
 * - 冲正：给原转化的佣金追加 commission_event(void)，不改原行。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { RecordedConversion } from './conversion';
import { TRACKING_ACTOR } from './params';
import { rows, type Exec } from './rows';

type Tx = Exec & Pick<Db, 'insert'>;

export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'void';

export type SettleResult =
  | { status: 'created'; commissionId: string; termId: string; model: 'cpa'; amountUsdt: number }
  | { status: 'voided'; commissionIds: string[] }
  | {
      status: 'skipped';
      reason:
        | 'ineligible_brand'
        | 'unattributed'
        | 'partner_inactive'
        | 'no_commission_event'
        | 'no_term'
        | 'revshare_disabled'
        | 'cpa_already_paid'
        | 'exists';
    };

/**
 * 当前状态：void 为终态——存在任一 void 事件即为 void（createdAt 取事务开始时间，晚提交的 approve 可能排在 void 之后，不得复活）。
 * 否则取最新一条；同一事务内多条事件时间相同（id 随机不可排序），并列时按推进顺序取后者：paid > approved > pending。
 */
export async function commissionStatus(db: Exec, commissionId: string): Promise<CommissionStatus | null> {
  const [r] = await rows<{ status: CommissionStatus }>(
    db,
    sql`select "status" from "commission_event" where "commissionId" = ${commissionId}
        order by ("status" = 'void') desc, "createdAt" desc,
                 case "status" when 'paid' then 2 when 'approved' then 1 else 0 end desc
        limit 1`,
  );
  return r?.status ?? null;
}

async function appendEvent(db: Tx, commissionId: string, status: CommissionStatus, note: string) {
  await db.insert(schema.commissionEvents).values({ commissionId, status, actor: TRACKING_ACTOR, note });
}

export async function settleCommission(db: Tx, cv: RecordedConversion): Promise<SettleResult> {
  if (cv.event === 'reversal') {
    const list = await rows<{ id: string }>(db, sql`select "id" from "commission" where "conversionId" = ${cv.reversesId}`);
    const voided: string[] = [];
    for (const c of list) {
      if ((await commissionStatus(db, c.id)) === 'void') continue;
      await appendEvent(db, c.id, 'void', `reversal ${cv.id}`);
      voided.push(c.id);
    }
    return { status: 'voided', commissionIds: voided };
  }

  const [brand] = await rows<{ eligible: boolean }>(
    db,
    sql`select (b."status" <> 'blacklist' and not op."relatedParty") as "eligible"
        from "brand" b join "operator" op on op."id" = b."operatorId" where b."id" = ${cv.brandId}`,
  );
  if (!brand?.eligible) return { status: 'skipped', reason: 'ineligible_brand' };
  if (!cv.clickId) return { status: 'skipped', reason: 'unattributed' };
  if (cv.event === 'register') return { status: 'skipped', reason: 'no_commission_event' };

  const [exists] = await rows(db, sql`select 1 from "commission" where "conversionId" = ${cv.id}`);
  if (exists) return { status: 'skipped', reason: 'exists' };

  const [click] = await rows<{ partnerId: string | null; partnerActive: boolean | null }>(
    db,
    sql`select c."partnerId", p."active" as "partnerActive" from "click" c left join "partner" p on p."id" = c."partnerId" where c."id" = ${cv.clickId}`,
  );
  const partnerId = click?.partnerId ?? null;
  if (partnerId && !click?.partnerActive) return { status: 'skipped', reason: 'partner_inactive' };
  const day = cv.receivedAt.toISOString().slice(0, 10);
  const [term] = await rows<{ id: string; mode: 'cpa' | 'revshare'; cpaUsdt: string | null; sharePct: string | null }>(
    db,
    sql`select "id", "mode", "cpaUsdt", "sharePct" from "commission_term"
        where "brandId" = ${cv.brandId} and "validFrom" <= ${day}::date and ("validTo" is null or "validTo" > ${day}::date)
          and ("partnerId" = ${partnerId} or "partnerId" is null)
        order by ("partnerId" is null) asc limit 1`,
  );
  if (!term) return { status: 'skipped', reason: 'no_term' };

  if (term.mode !== 'cpa') return { status: 'skipped', reason: 'revshare_disabled' };
  if (cv.event !== 'first_deposit') return { status: 'skipped', reason: 'no_commission_event' };
  // 同品牌同账号串行化：并发的两条 first_deposit（不同 externalEventId）不得各结一次 CPA
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cpa:${cv.brandId}:${cv.operatorAccountIdHash}`}, 0))`);
  const [paid] = await rows(
    db,
    sql`select 1 from "commission" c join "conversion" v on v."id" = c."conversionId"
        where c."brandId" = ${cv.brandId} and c."model" = 'cpa' and v."operatorAccountIdHash" = ${cv.operatorAccountIdHash}`,
  );
  if (paid) return { status: 'skipped', reason: 'cpa_already_paid' };
  const amountUsdt = Number(term.cpaUsdt);

  const [row] = await db
    .insert(schema.commissions)
    .values({
      conversionId: cv.id,
      brandId: cv.brandId,
      partnerId,
      termId: term.id,
      model: 'cpa',
      amountUsdt,
      period: day.slice(0, 7),
    })
    .returning({ id: schema.commissions.id });
  await appendEvent(db, row!.id, 'pending', `conversion ${cv.id}`);
  return { status: 'created', commissionId: row!.id, termId: term.id, model: 'cpa', amountUsdt };
}
