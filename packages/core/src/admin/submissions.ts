/**
 * D-024 后台「提交审核」：出款凭证（arbitrator / admin，与证据预览同组）与评价（editor / admin，与 review.* 同组）。
 * - 判定单向（库触发器兜底）；凭证无未删除截图不能采纳（裁定 ②）；驳回须原因。
 * - 采纳 / 发布：同事务 awardPoints（withdrawal_report_accepted / review_published，dedupeKey 按记录）、写 audit_log、给本人发站内通知；驳回同样通知并附原因。
 * - 判定后补录（W2#002 小改 3）：outcomeAmendedAt ≥ decidedAt 的凭证带 amendedAfterDecision 标记（同一时刻也算，保守），可单独筛选。
 * - 评价文字不公开（裁定 ④）：只在后台审核时可见。
 */
import { randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';
import { awardPoints } from '../identity/points';
import { bindingLevelsByIds } from '../identity/bindings';
import type { EvidenceStore } from '../complaint/write';
import { EvidenceNotFoundError, GoneError } from './evidence';
import { writeAudit, type Actor } from './rbac';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = async <T>(db: Exec, s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());

export type SubmissionType = 'withdrawal' | 'review';
export type SubmissionStatus = 'pending' | 'accepted' | 'rejected';

export class SubmissionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionStateError';
  }
}

export type AdminWithdrawalItem = {
  type: 'withdrawal';
  id: string;
  brandId: string;
  brandName: string;
  userId: string | null;
  amountUsdt: number;
  method: string;
  requestedAt: string;
  receivedAt: string | null;
  outcome: 'paid' | 'refused' | 'pending';
  status: SubmissionStatus;
  bindingLevel: string | null;
  evidence: { id: string; mime: string; bytes: number; sha256: string; available: boolean }[];
  decidedAt: string | null;
  decidedBy: string | null;
  rejectReason: string | null;
  outcomeAmendedAt: string | null;
  amendedAfterDecision: boolean;
  createdAt: string;
};
export type AdminReviewItem = {
  type: 'review';
  id: string;
  brandId: string;
  brandName: string;
  userId: string;
  rating: number;
  text: string | null;
  trustWeight: number;
  verifiedBinding: boolean;
  status: 'pending' | 'published' | 'rejected';
  decidedAt: string | null;
  decidedBy: string | null;
  rejectReason: string | null;
  createdAt: string;
};

/** status：pending / accepted（评价即 published）/ rejected；amended = 只看判定后补录的凭证 */
export async function listAdminWithdrawals(db: Exec, p: { status: SubmissionStatus; amended?: boolean; limit?: number }): Promise<AdminWithdrawalItem[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    sql`select w."id", w."brandId", coalesce(b."name"->>'zhHans', b."slug") as "brandName", w."userId", w."amountUsdt"::float as "amountUsdt", w."method",
               w."requestedAt", w."receivedAt", w."outcome", w."status", w."decidedAt", w."decidedBy", w."rejectReason", w."outcomeAmendedAt", w."createdAt",
               w."bindingId",
               (w."decidedAt" is not null and w."outcomeAmendedAt" >= w."decidedAt") as "amendedAfterDecision"
        from ${schema.withdrawalReports} w
        join ${schema.brands} b on b."id" = w."brandId"
        where w."kind" = 'user' and w."status" = ${p.status}
          ${p.amended ? sql`and w."decidedAt" is not null and w."outcomeAmendedAt" >= w."decidedAt"` : sql``}
        order by w."createdAt" ${p.status === 'pending' ? sql`asc` : sql`desc`}
        limit ${Math.min(p.limit ?? 50, 200)}`,
  );
  const ids = rows.map((r) => r.id as string);
  const levels = await bindingLevelsByIds(db, rows.map((r) => r.bindingId as string | null).filter((x): x is string => !!x));
  const ev = ids.length
    ? await q<{ withdrawalReportId: string; id: string; mime: string; bytes: number; sha256: string; available: boolean }>(
        db,
        sql`select "withdrawalReportId", "id", "mime", "bytes", "sha256", ("storageKey" is not null and "deletedAt" is null) as "available"
            from ${schema.submissionEvidence} where "withdrawalReportId" in ${sql.raw(`(${ids.map((i) => `'${i.replace(/[^A-Za-z0-9_]/g, '')}'`).join(',')})`)} order by "uploadedAt"`,
      )
    : [];
  return rows.map((r) => ({
    type: 'withdrawal' as const,
    id: r.id as string,
    brandId: r.brandId as string,
    brandName: r.brandName as string,
    userId: (r.userId as string | null) ?? null,
    amountUsdt: r.amountUsdt as number,
    method: r.method as string,
    requestedAt: iso(r.requestedAt as Date)!,
    receivedAt: iso(r.receivedAt as Date | null),
    outcome: r.outcome as AdminWithdrawalItem['outcome'],
    status: r.status as SubmissionStatus,
    bindingLevel: r.bindingId ? (levels.get(r.bindingId as string) ?? null) : null,
    evidence: ev.filter((e) => e.withdrawalReportId === r.id).map(({ id, mime, bytes, sha256, available }) => ({ id, mime, bytes, sha256, available })),
    decidedAt: iso(r.decidedAt as Date | null),
    decidedBy: (r.decidedBy as string | null) ?? null,
    rejectReason: (r.rejectReason as string | null) ?? null,
    outcomeAmendedAt: iso(r.outcomeAmendedAt as Date | null),
    amendedAfterDecision: !!r.amendedAfterDecision,
    createdAt: iso(r.createdAt as Date)!,
  }));
}

export async function listAdminReviews(db: Exec, p: { status: SubmissionStatus; limit?: number }): Promise<AdminReviewItem[]> {
  const st = p.status === 'accepted' ? 'published' : p.status;
  const rows = await q<Record<string, unknown>>(
    db,
    sql`select r."id", r."brandId", coalesce(b."name"->>'zhHans', b."slug") as "brandName", r."userId", r."rating", r."text", r."trustWeight"::float as "trustWeight",
               r."verifiedBinding", r."status", r."decidedAt", r."decidedBy", r."rejectReason", r."createdAt"
        from ${schema.reviews} r join ${schema.brands} b on b."id" = r."brandId"
        where r."status" = ${st} and r."bindingId" is not null
        order by r."createdAt" ${p.status === 'pending' ? sql`asc` : sql`desc`}
        limit ${Math.min(p.limit ?? 50, 200)}`,
  );
  return rows.map((r) => ({
    type: 'review' as const,
    id: r.id as string,
    brandId: r.brandId as string,
    brandName: r.brandName as string,
    userId: r.userId as string,
    rating: Number(r.rating),
    text: (r.text as string | null) ?? null,
    trustWeight: r.trustWeight as number,
    verifiedBinding: !!r.verifiedBinding,
    status: r.status as AdminReviewItem['status'],
    decidedAt: iso(r.decidedAt as Date | null),
    decidedBy: (r.decidedBy as string | null) ?? null,
    rejectReason: (r.rejectReason as string | null) ?? null,
    createdAt: iso(r.createdAt as Date)!,
  }));
}

async function notifyOwner(tx: Exec, userId: string, title: string, body: string): Promise<string> {
  const id = `nt_${randomUUID().replaceAll('-', '')}`;
  await tx.execute(sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body") values (${id}, ${userId}, 'submission_decision', ${title}, ${body})`);
  return id;
}

/** 判定。返回新通知 id 供入队推送 */
export async function decideSubmission(
  db: Tx,
  actor: Actor,
  type: SubmissionType,
  id: string,
  decision: 'accept' | 'reject',
  reason: string | null,
): Promise<{ notificationIds: string[] }> {
  const why = reason?.trim() || null;
  if (decision === 'reject' && !why) throw new SubmissionStateError('驳回须填写原因（会通知提交人）');
  return db.transaction(async (tx) => {
    if (type === 'withdrawal') {
      const [w] = await q<{ userId: string | null; status: string; brandName: string; kind: string }>(
        tx,
        sql`select w."userId", w."status", w."kind", coalesce(b."name"->>'zhHans', b."slug") as "brandName"
            from ${schema.withdrawalReports} w join ${schema.brands} b on b."id" = w."brandId" where w."id" = ${id} for update of w`,
      );
      if (!w || w.kind !== 'user' || !w.userId) throw new SubmissionStateError('凭证不存在');
      if (w.userId === actor.id) throw new SubmissionStateError('不能审核本人的提交'); // W2#005 收尾 3：回避，防自审发积分 / 影响评分
      if (w.status !== 'pending') throw new SubmissionStateError('凭证已判定');
      if (decision === 'accept') {
        const [n] = await q<{ n: number }>(
          tx,
          sql`select count(*)::int as "n" from ${schema.submissionEvidence} where "withdrawalReportId" = ${id} and "deletedAt" is null and "storageKey" is not null`,
        );
        if (!n || n.n === 0) throw new SubmissionStateError('没有截图的凭证不能采纳');
      }
      const to = decision === 'accept' ? 'accepted' : 'rejected';
      await tx.execute(sql`update ${schema.withdrawalReports} set "status" = ${to}, "decidedBy" = ${actor.id}, "rejectReason" = ${why} where "id" = ${id}`);
      if (decision === 'accept')
        await awardPoints(tx, { userId: w.userId, event: 'withdrawal_report_accepted', refType: 'withdrawal_report', refId: id, dedupeKey: `withdrawal_report_accepted:${id}` });
      await writeAudit(tx, actor, `withdrawal_report_${to}`, { type: 'withdrawal_report', id }, { status: 'pending' }, { status: to, reason: why });
      const nid = await notifyOwner(
        tx,
        w.userId,
        decision === 'accept' ? `出款凭证已采纳：${w.brandName}` : `出款凭证未通过：${w.brandName}`,
        decision === 'accept' ? '你提交的出款凭证已采纳，计入该平台出款统计，积分已发放。' : `原因：${why}。可补充截图后重新提交。`,
      );
      return { notificationIds: [nid] };
    }
    const [r] = await q<{ userId: string; status: string; brandName: string }>(
      tx,
      sql`select r."userId", r."status", coalesce(b."name"->>'zhHans', b."slug") as "brandName"
          from ${schema.reviews} r join ${schema.brands} b on b."id" = r."brandId" where r."id" = ${id} for update of r`,
    );
    if (!r) throw new SubmissionStateError('评价不存在');
    if (r.userId === actor.id) throw new SubmissionStateError('不能审核本人的提交');
    if (r.status !== 'pending') throw new SubmissionStateError('评价已判定');
    const to = decision === 'accept' ? 'published' : 'rejected';
    await tx.execute(sql`update ${schema.reviews} set "status" = ${to}, "decidedBy" = ${actor.id}, "rejectReason" = ${why} where "id" = ${id}`);
    if (decision === 'accept') await awardPoints(tx, { userId: r.userId, event: 'review_published', refType: 'review', refId: id, dedupeKey: `review_published:${id}` });
    await writeAudit(tx, actor, `review_${to}`, { type: 'review', id }, { status: 'pending' }, { status: to, reason: why });
    const nid = await notifyOwner(
      tx,
      r.userId,
      decision === 'accept' ? `评价已通过：${r.brandName}` : `评价未通过：${r.brandName}`,
      decision === 'accept' ? '你的评价已通过审核，计入该平台评分，积分已发放。评价文字不对外展示。' : `原因：${why}。`,
    );
    return { notificationIds: [nid] };
  });
}

/** 截图预览：读取原文（不写 audit，同投诉证据预览口径）。原文已删 → GoneError */
export async function readSubmissionEvidence(db: Exec, store: EvidenceStore, evidenceId: string): Promise<{ id: string; content: Uint8Array }> {
  const [e] = await q<{ id: string; storageKey: string | null; deleted: boolean }>(
    db,
    sql`select "id", "storageKey", "deletedAt" is not null as "deleted" from ${schema.submissionEvidence} where "id" = ${evidenceId}`,
  );
  if (!e) throw new EvidenceNotFoundError();
  if (!e.storageKey || e.deleted) throw new GoneError();
  if (!store.get) throw new Error('证据存储未配置读取');
  const content = await store.get(e.storageKey);
  if (!content) throw new GoneError('原文对象不存在');
  return { id: e.id, content };
}

/**
 * W2#011 裁定 1：把指定用户仍待审的出款凭证 / 评价逐条驳回（走 decideSubmission 正常判定路径：audit_log + 通知提交人）。
 * 用于测试站 UAT 收尾清理；actor 须是系统 / 管理身份，不能是被清理用户本人（自审禁令由 decideSubmission 兜底）。
 */
export async function rejectPendingSubmissionsOf(db: Tx, userIds: string[], actor: Actor, reason: string) {
  const done = { withdrawal: 0, review: 0, failed: 0 };
  if (!userIds.length) return done;
  const inList = sql`(${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`;
  const w = await q<{ id: string }>(db, sql`select "id" from ${schema.withdrawalReports} where "kind" = 'user' and "status" = 'pending' and "userId" in ${inList} order by "createdAt"`);
  const r = await q<{ id: string }>(db, sql`select "id" from ${schema.reviews} where "status" = 'pending' and "userId" in ${inList} order by "createdAt"`);
  for (const [type, ids] of [['withdrawal', w], ['review', r]] as const)
    for (const x of ids)
      try {
        await decideSubmission(db, actor, type, x.id, 'reject', reason);
        done[type]++;
      } catch {
        done.failed++;
      }
  return done;
}
