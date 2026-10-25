/**
 * GET /me/complaints/{id}（field-mapping 05「进度」· 契约 ComplaintMine）：只看本人案件，他人案件视为不存在。
 * 与公开案件页不同：本人可见未公开案件、证据清单（不含原文与存储键）、初筛驳回原因（§9.2 v1.6：驳回须通知投诉人原因）。
 * 其余状态日志的 reason 属内部裁决文本，不展示。
 */
import { schema, sql, type Db } from '@bydp/db';
import { getBindingEligibility } from '../identity/bindings';
import type { TimelineEvent } from '../shared/index';
import { STATUS_TEXT } from './cases';
import type { ComplaintMine } from './index';

type Exec = Pick<Db, 'execute'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
const iso = (d: Date | string) => new Date(d).toISOString();

export async function getMyComplaint(db: Exec, userId: string, id: string): Promise<ComplaintMine | null> {
  const [c] = await q<{
    id: string;
    bindingId: string | null;
    title: string;
    category: ComplaintMine['category'];
    status: NonNullable<ComplaintMine['status']>;
    amountUsdt: string;
    createdAt: Date;
    acceptedAt: Date | null;
    operatorNotifiedAt: Date | null;
    secondNoticeAt: Date | null;
    replyDeadline: Date | null;
    resolvedAt: Date | null;
    exposedAt: Date | null;
  }>(
    db,
    sql`select "id", "bindingId", "title", "category", "status", "amountUsdt", "createdAt", "acceptedAt", "operatorNotifiedAt",
               "secondNoticeAt", "replyDeadline", "resolvedAt", "exposedAt"
        from ${schema.complaints} where "id" = ${id} and "userId" = ${userId}`,
  );
  if (!c) return null;
  const evidence = await q<{ id: string; type: string; label: string | null; sha256: string; uploadedAt: Date; redacted: boolean }>(
    db,
    sql`select "id", "type", "label", "sha256", "uploadedAt", "redacted" from ${schema.evidence} where "complaintId" = ${c.id} order by "uploadedAt", "id"`,
  );
  const history = await q<{ to: string; reason: string | null; at: Date }>(
    db,
    sql`select "to", "reason", "at" from ${schema.statusHistory} where "complaintId" = ${c.id} order by "at", "id"`,
  );
  const timeline: TimelineEvent[] = [
    { date: iso(c.createdAt), subject: '提交', rest: c.title, kind: 'info' as const },
    ...(c.operatorNotifiedAt ? [{ date: iso(c.operatorNotifiedAt), subject: '通知运营商', rest: '答辩期开始', kind: 'info' as const }] : []),
    ...(c.secondNoticeAt ? [{ date: iso(c.secondNoticeAt), subject: '二次通知', rest: '', kind: 'warning' as const }] : []),
    ...history.map((h) => ({
      date: iso(h.at),
      subject: STATUS_TEXT[h.to] ?? h.to,
      rest: h.to === 'rejected' && h.reason ? h.reason : '',
      kind: h.to === 'exposed' || h.to === 'rejected' ? ('warning' as const) : ('decision' as const),
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    id: c.id,
    title: c.title,
    category: c.category,
    status: c.status,
    amountUsdt: Number(c.amountUsdt),
    createdAt: iso(c.createdAt),
    resolvedAt: c.resolvedAt ? iso(c.resolvedAt) : null,
    exposedAt: c.exposedAt ? iso(c.exposedAt) : null,
    replyDeadline: c.replyDeadline ? iso(c.replyDeadline) : null,
    notices: [c.operatorNotifiedAt, c.secondNoticeAt].filter(Boolean).length,
    compensationEligible: c.bindingId ? await getBindingEligibility(db, c.bindingId) : false,
    evidence: evidence.map((e) => ({ id: e.id, type: e.type, ...(e.label ? { label: e.label } : {}), sha256: e.sha256, uploadedAt: iso(e.uploadedAt), redacted: e.redacted })),
    timeline,
  };
}

/** 本人最近的投诉（D-017 TG `/cases`）：只回状态与品牌，不回标题 / 原文（聊天里不复述用户填写的内容） */
export async function listMyComplaints(db: Exec, userId: string, limit = 10): Promise<{ id: string; brandName: string; status: string; statusText: string; amountUsdt: number; createdAt: string }[]> {
  const rows = await q<{ id: string; brandName: string | null; slug: string; status: string; amountUsdt: string; createdAt: Date }>(
    db,
    sql`select c."id", b."name"->>'zhHans' as "brandName", b."slug", c."status", c."amountUsdt", c."createdAt"
        from ${schema.complaints} c join ${schema.brands} b on b."id" = c."brandId"
        where c."userId" = ${userId} order by c."createdAt" desc, c."id" desc limit ${limit}`,
  );
  return rows.map((r) => ({ id: r.id, brandName: r.brandName ?? r.slug, status: r.status, statusText: STATUS_TEXT[r.status] ?? r.status, amountUsdt: Number(r.amountUsdt), createdAt: iso(r.createdAt) }));
}
