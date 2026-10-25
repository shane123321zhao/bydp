/**
 * 后台风控 / 看板 / 审核台骨架（admin 契约 v0.2）。
 * - 风控：同设备多账号标记（audit_log device_multi_account，只标不拦）；账号列表取自 device 表（标记时只记当次新账号）。
 * - 看板：各队列待办计数（全部后台角色只读）。
 * - 审核台：review_item 待确认队列与决定。approve 后按 kind 落地（review-apply.ts，D-016），同事务写 audit（applied / effect）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { SECOND_NOTICE_REMIND_HOURS } from '../complaint/arbitration';
import { ComplaintInputError } from '../complaint/write';
import { applyReviewProposal } from './review-apply';
import { writeAudit, type Actor } from './rbac';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
const PAGE = 50;

export async function listDeviceFlags(db: Exec, cursor: string | null) {
  const [cAt, cDev] = cursor ? cursor.split('|') : [];
  const rows = await q<{ device: string; lastFlaggedAt: Date }>(
    db,
    sql`select "targetId" as "device", max("at") as "lastFlaggedAt" from ${schema.auditLogs}
        where "action" = 'device_multi_account' group by "targetId"
        having (${cAt ?? null}::timestamptz is null or (max("at"), "targetId") < (${cAt ?? null}::timestamptz, ${cDev ?? ''}))
        order by max("at") desc, "targetId" desc limit ${PAGE + 1}`,
  );
  const page = rows.slice(0, PAGE);
  const items = await Promise.all(
    page.map(async (r) => {
      const users = await q<{ userId: string }>(
        db,
        sql`select distinct "userId" from ${schema.devices} where left("fingerprint", 16) = ${r.device} and "userId" is not null order by "userId"`,
      );
      return { device: r.device, accounts: users.length, userIds: users.map((u) => u.userId), lastFlaggedAt: iso(r.lastFlaggedAt)! };
    }),
  );
  const last = items.at(-1);
  return { items, next: rows.length > PAGE && last ? `${last.lastFlaggedAt}|${last.device}` : null };
}

export async function getDashboard(db: Exec): Promise<Record<string, number>> {
  const [r] = await q<Record<string, number>>(
    db,
    sql`select
      (select count(*)::int from ${schema.complaints} where "status" = 'screening') as "complaintsScreening",
      (select count(*)::int from ${schema.complaints} where "status" = 'accepted') as "awaitingFirstNotice",
      (select count(*)::int from ${schema.complaints} where "status" = 'awaiting_reply' and "operatorRepliedAt" is null and "secondNoticeAt" is null
              and "replyDeadline" <= now() + make_interval(hours => ${SECOND_NOTICE_REMIND_HOURS})) as "secondNoticeDue",
      (select count(*)::int from ${schema.complaints} where "status" = 'awaiting_reply' and "operatorRepliedAt" is null and "secondNoticeAt" is not null
              and "replyDeadline" <= now()) as "pendingExposureDecision",
      (select count(*)::int from ${schema.complaints} where "status" in ('resolved', 'unresolved', 'exposed') and not "publicSummary") as "awaitingPublish",
      (select count(*)::int from ${schema.dataRequests} where "status" = 'pending') as "dataRequestsPending",
      (select count(*)::int from ${schema.reviewItems} where "status" = 'pending') as "reviewPending",
      (select count(distinct "targetId")::int from ${schema.auditLogs} where "action" = 'device_multi_account' and "at" > now() - interval '7 days') as "deviceFlags7d"`,
  );
  return r!;
}

export type ReviewKind = 'brand_attribute' | 'site_monitor' | 'complaint_screening' | 'localization';
type ReviewRow = { id: string; kind: ReviewKind; subject: string; proposal: unknown; source: string; status: string; decidedBy: string | null; decidedAt: Date | null; note: string | null; createdAt: Date };
const reviewView = (r: ReviewRow) => ({ ...r, decidedAt: iso(r.decidedAt), createdAt: iso(r.createdAt)! });

export async function listReviewQueue(db: Exec, p: { kind?: ReviewKind; cursor?: string | null }) {
  const [cAt, cId] = p.cursor ? p.cursor.split('|') : [];
  const rows = await q<ReviewRow>(
    db,
    sql`select "id", "kind", "subject", "proposal", "source", "status", "decidedBy", "decidedAt", "note", "createdAt" from ${schema.reviewItems}
        where "status" = 'pending' and (${p.kind ?? null}::text is null or "kind"::text = ${p.kind ?? null})
          and (${cAt ?? null}::timestamptz is null or ("createdAt", "id") > (${cAt ?? null}::timestamptz, ${cId ?? ''}))
        order by "createdAt", "id" limit ${PAGE + 1}`,
  );
  const items = rows.slice(0, PAGE).map(reviewView);
  const last = items.at(-1);
  return { items, next: rows.length > PAGE && last ? `${last.createdAt}|${last.id}` : null };
}

export class ReviewStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewStateError';
  }
}

/** 决定（approve / reject）。decidedBy = 会话用户（外键，审核 A-014 E2）；decidedAt 由 DB 守卫置服务端时间 */
export async function decideReviewItem(db: Tx, actor: Actor, id: string, decision: 'approve' | 'reject', note: string | null) {
  const n = note?.trim() || null;
  if (n && n.length > 500) throw new ComplaintInputError('备注不超过 500 字');
  return db.transaction(async (tx) => {
    const [r] = await q<ReviewRow>(tx, sql`select "id", "kind", "subject", "proposal", "status" from ${schema.reviewItems} where "id" = ${id} for update`);
    if (!r) throw new ComplaintInputError('不存在');
    if (r.status !== 'pending') throw new ReviewStateError('该提议已决定');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await tx.execute(sql`update ${schema.reviewItems} set "status" = ${status}, "decidedBy" = ${actor.id}, "decidedAt" = now(), "note" = ${n} where "id" = ${id}`);
    // D-016：approve 后同事务按 kind 落地（不合法的提议 → 409，决定一并回滚）；reject 只记录
    const res = decision === 'approve' ? await applyReviewProposal(tx, r) : { applied: false, effect: {} };
    await writeAudit(tx, actor, 'review_item_decision', { type: 'review_item', id }, { status: 'pending' }, { status, kind: r.kind, applied: res.applied, effect: res.effect, note: n });
    const [v] = await q<ReviewRow>(tx, sql`select "id", "kind", "subject", "proposal", "source", "status", "decidedBy", "decidedAt", "note", "createdAt" from ${schema.reviewItems} where "id" = ${id}`);
    return reviewView(v!);
  });
}
