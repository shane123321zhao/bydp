/**
 * 仲裁台（admin 契约 v0.2 · §9.2）：队列 / 详情 / 流转 / 两次通知 / 确认曝光 / 公开前脱敏确认。
 * 状态机守卫照常生效（state.ts）；所有写操作同事务写 audit_log（rbac.writeAudit 或 arbitration.ts 内置）。
 * 公开：publicDescription 由仲裁员人工脱敏后写入，公开页只读该列（A-014）；修订写 audit_log before / after（审核条件 ②）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { confirmExposure, recordOperatorNotice, recordOperatorReply, SECOND_NOTICE_REMIND_HOURS } from '../complaint/arbitration';
import { TransitionError, type ComplaintStatus } from '../complaint/state';
import { ComplaintInputError, transitionComplaint } from '../complaint/write';
import { bindingLevelsByIds } from '../identity/bindings';
import { writeAudit, type Actor } from './rbac';

/** 回避（审核 admin 第 1 轮）：仲裁员 / admin 不得处理本人提交的案件 */
export class ConflictOfInterestError extends Error {
  constructor(message = '不得处理本人提交的投诉（回避）') {
    super(message);
    this.name = 'ConflictOfInterestError';
  }
}
async function assertNoConflict(db: Exec, actor: Actor, id: string): Promise<void> {
  const [c] = await q<{ userId: string }>(db, sql`select "userId" from ${schema.complaints} where "id" = ${id}`);
  if (c && c.userId === actor.id) throw new ConflictOfInterestError();
}

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

export type ComplaintFlag = 'second_notice_due' | 'pending_exposure_decision' | 'awaiting_publish';
/** 可公开的结案状态（初筛 / 仲裁驳回不公开，§9.2 v1.6） */
const PUBLISHABLE: ComplaintStatus[] = ['resolved', 'unresolved', 'exposed'];
const PAGE = 50;

const FLAG_SQL = sql`array_remove(array[
    case when c."status" = 'awaiting_reply' and c."operatorRepliedAt" is null and c."secondNoticeAt" is null
              and c."replyDeadline" <= now() + make_interval(hours => ${SECOND_NOTICE_REMIND_HOURS}) then 'second_notice_due' end,
    case when c."status" = 'awaiting_reply' and c."operatorRepliedAt" is null and c."secondNoticeAt" is not null
              and c."replyDeadline" <= now() then 'pending_exposure_decision' end,
    case when c."status" in ('resolved', 'unresolved', 'exposed') and not c."publicSummary" then 'awaiting_publish' end
  ], null)`;

export type AdminComplaintRow = {
  id: string;
  brand: { id: string; slug: string; name: string; status: string };
  status: ComplaintStatus;
  category: string;
  amountUsdt: number;
  createdAt: string;
  replyDeadline: string | null;
  notices: number;
  flags: ComplaintFlag[];
  publicSummary: boolean;
  bindingLevel: 'none' | 'self_reported' | 'postback_confirmed' | 'operator_confirmed';
};

type RowRaw = Omit<AdminComplaintRow, 'brand' | 'amountUsdt' | 'createdAt' | 'replyDeadline' | 'bindingLevel'> & {
  bindingId: string | null;
  brandId: string;
  slug: string;
  brandName: string | null;
  brandStatus: string;
  amountUsdt: string;
  createdAt: Date | string;
  replyDeadline: Date | string | null;
};
const toRow = (r: RowRaw, levels: Map<string, string>): AdminComplaintRow => ({
  id: r.id,
  brand: { id: r.brandId, slug: r.slug, name: r.brandName ?? r.slug, status: r.brandStatus },
  status: r.status,
  category: r.category,
  amountUsdt: Number(r.amountUsdt),
  createdAt: iso(r.createdAt)!,
  replyDeadline: iso(r.replyDeadline),
  notices: r.notices,
  flags: r.flags,
  publicSummary: r.publicSummary,
  bindingLevel: ((r.bindingId && levels.get(r.bindingId)) || 'none') as AdminComplaintRow['bindingLevel'],
});
const levelsFor = (db: Exec, rows: RowRaw[]) => bindingLevelsByIds(db, rows.flatMap((r) => (r.bindingId ? [r.bindingId] : [])));

const ROW_SELECT = sql`select c."id", c."brandId", b."slug", b."name"->>'zhHans' as "brandName", b."status" as "brandStatus", c."status", c."category",
         c."amountUsdt", c."createdAt", c."replyDeadline", c."publicSummary",
         (case when c."operatorNotifiedAt" is null then 0 else 1 end + case when c."secondNoticeAt" is null then 0 else 1 end)::int as "notices",
         c."bindingId",
         ${FLAG_SQL} as "flags"
  from ${schema.complaints} c
  join ${schema.brands} b on b."id" = c."brandId"`;

/** 队列：按创建时间倒序；cursor = 上一页最后一行的 `createdAt|id` */
export async function listAdminComplaints(
  db: Exec,
  p: { status?: ComplaintStatus; flag?: ComplaintFlag; cursor?: string | null; limit?: number },
): Promise<{ items: AdminComplaintRow[]; next: string | null }> {
  const limit = Math.min(Math.max(p.limit ?? PAGE, 1), 100);
  const [cAt, cId] = p.cursor ? p.cursor.split('|') : [];
  const rows = await q<RowRaw>(
    db,
    sql`select * from (${ROW_SELECT}) x
        where (${p.status ?? null}::text is null or x."status"::text = ${p.status ?? null})
          and (${p.flag ?? null}::text is null or ${p.flag ?? null} = any(x."flags"))
          and (${cAt ?? null}::timestamptz is null or (x."createdAt", x."id") < (${cAt ?? null}::timestamptz, ${cId ?? ''}))
        order by x."createdAt" desc, x."id" desc limit ${limit + 1}`,
  );
  const page = rows.slice(0, limit);
  const levels = await levelsFor(db, page);
  const items = page.map((r) => toRow(r, levels));
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null };
}

export type AdminComplaintDetail = AdminComplaintRow & {
  title: string;
  description: string;
  publicDescription: string | null;
  eventDate: string;
  evidence: { id: string; type: string; sha256: string; redactedSha256: string | null; redacted: boolean; originalAvailable: boolean; uploadedAt: string }[];
  timeline: { at: string; to: string; actor: string; reason: string | null }[];
  audit: { at: string; actorId: string; actorRole: string | null; action: string }[];
  /** D-016：投诉初筛建议（Agent 规则，最近一条；只是建议，不改案件状态） */
  screening: { reviewItemId: string; status: string; suggest: string; rules: { rule: string; note: string }[]; createdAt: string } | null;
};

export async function getAdminComplaint(db: Exec, id: string): Promise<AdminComplaintDetail | null> {
  const [r] = await q<RowRaw>(db, sql`select * from (${ROW_SELECT}) x where x."id" = ${id}`);
  if (!r) return null;
  const [c] = await q<{ title: string; description: string; publicDescription: string | null; eventDate: string }>(
    db,
    sql`select "title", "description", "publicDescription", "eventDate"::text from ${schema.complaints} where "id" = ${id}`,
  );
  const evidence = await q<{ id: string; type: string; sha256: string; redactedSha256: string | null; redacted: boolean; available: boolean; uploadedAt: Date }>(
    db,
    sql`select "id", "type", "sha256", "redactedSha256", "redacted", "storageKey" is not null and "deletedAt" is null as "available", "uploadedAt"
        from ${schema.evidence} where "complaintId" = ${id} order by "uploadedAt", "id"`,
  );
  const timeline = await q<{ at: Date; to: string; actor: string; reason: string | null }>(
    db,
    sql`select "at", "to", "actor", "reason" from ${schema.statusHistory} where "complaintId" = ${id} order by "at", "id"`,
  );
  const audit = await q<{ at: Date; actorId: string; actorRole: string | null; action: string }>(
    db,
    sql`select "at", "actorId", "actorRole", "action" from ${schema.auditLogs}
        where "targetType" = 'complaint' and "targetId" = ${id} order by "at", "id"`,
  );
  const [sc] = await q<{ id: string; status: string; proposal: { suggest?: string; rules?: { rule: string; note: string }[] }; createdAt: Date }>(
    db,
    sql`select "id", "status", "proposal", "createdAt" from ${schema.reviewItems} where "kind" = 'complaint_screening' and "subject" = ${id} order by "createdAt" desc, "id" desc limit 1`,
  );
  return {
    ...toRow(r, await levelsFor(db, [r])),
    title: c!.title,
    description: c!.description,
    publicDescription: c!.publicDescription,
    eventDate: c!.eventDate,
    evidence: evidence.map((e) => ({
      id: e.id,
      type: e.type,
      sha256: e.sha256,
      redactedSha256: e.redactedSha256,
      redacted: e.redacted,
      originalAvailable: e.available,
      uploadedAt: iso(e.uploadedAt)!,
    })),
    timeline: timeline.map((t) => ({ at: iso(t.at)!, to: t.to, actor: t.actor, reason: t.reason })),
    audit: audit.map((a) => ({ at: iso(a.at)!, actorId: a.actorId, actorRole: a.actorRole, action: a.action })),
    screening: sc
      ? { reviewItemId: sc.id, status: sc.status, suggest: String(sc.proposal?.suggest ?? ''), rules: Array.isArray(sc.proposal?.rules) ? sc.proposal.rules : [], createdAt: iso(sc.createdAt)! }
      : null,
  };
}

const ADMIN_TRANSITIONS = ['accepted', 'rejected', 'resolved', 'unresolved'] as const;
export type AdminTransition = (typeof ADMIN_TRANSITIONS)[number];

/** 状态流转（契约 /transition）：初筛受理 / 驳回（原因必填）；仲裁结案 resolved | rejected | unresolved。返回新通知 id 供入队 */
export async function adminTransition(db: Tx, actor: Actor, id: string, to: AdminTransition, reason: string | null): Promise<{ notificationIds: string[] }> {
  if (!ADMIN_TRANSITIONS.includes(to)) throw new ComplaintInputError('不支持的流转');
  return db.transaction(async (tx) => {
    await assertNoConflict(tx, actor, id);
    const [before] = await q<{ status: ComplaintStatus }>(tx, sql`select "status" from ${schema.complaints} where "id" = ${id} for update`);
    if (!before) throw new ComplaintInputError('投诉不存在');
    const r = await transitionComplaint(tx, id, to, { id: actor.id, reason: reason?.trim() || undefined });
    await writeAudit(tx, actor, 'complaint_transition', { type: 'complaint', id }, { status: before.status }, { status: to, reason: reason?.trim() || null });
    return { notificationIds: r.notificationIds };
  });
}

export async function adminOperatorNotice(db: Tx, actor: Actor, id: string, which: 'first' | 'second', channel: string) {
  if (!channel.trim()) throw new ComplaintInputError('须注明通知渠道');
  await assertNoConflict(db, actor, id);
  return recordOperatorNotice(db, id, which, { id: actor.id, role: actor.role === 'admin' ? 'admin' : 'arbitrator', ip: actor.ip }, { channel: channel.trim().slice(0, 120) });
}

/** D-025（F4）：记录运营商答辩 → 进入仲裁（摘要可空） */
export async function adminOperatorReply(db: Tx, actor: Actor, id: string, summary: string | null) {
  await assertNoConflict(db, actor, id);
  return recordOperatorReply(db, id, { id: actor.id, role: actor.role === 'admin' ? 'admin' : 'arbitrator', ip: actor.ip }, summary);
}

export async function adminExpose(db: Tx, actor: Actor, id: string, reason: string) {
  await assertNoConflict(db, actor, id);
  return confirmExposure(db, id, { id: actor.id, role: actor.role === 'admin' ? 'admin' : 'arbitrator', ip: actor.ip }, reason);
}

export type RedactionChecklist = { noPersonalNames: boolean; noContactInfo: boolean; noAccountIds: boolean; noImagesWithFaces: boolean };
const CHECKLIST_KEYS: (keyof RedactionChecklist)[] = ['noPersonalNames', 'noContactInfo', 'noAccountIds', 'noImagesWithFaces'];

/** 公开前脱敏确认 / 公开后修订（契约 /publish）：未结案 → TransitionError；清单未全 → ComplaintInputError；不能回退 publicSummary */
export async function publishComplaint(
  db: Tx,
  actor: Actor,
  id: string,
  input: { publicDescription: string; checklist: RedactionChecklist; title?: string },
): Promise<void> {
  const text = input.publicDescription.trim();
  if (!text || [...text].length > 500) throw new ComplaintInputError('公开陈述须为 1–500 字');
  // 契约 v0.2.2：标题也显示在公开页，公开确认时可一并修订（清单对标题 + 公开陈述一并核对）
  const title = input.title?.trim();
  if (input.title !== undefined && (!title || [...title].length > 80)) throw new ComplaintInputError('标题须为 1–80 字');
  if (!CHECKLIST_KEYS.every((k) => input.checklist?.[k] === true)) throw new ComplaintInputError('脱敏清单须逐项确认');
  await db.transaction(async (tx) => {
    await assertNoConflict(tx, actor, id);
    const [c] = await q<{ status: ComplaintStatus; publicSummary: boolean; publicDescription: string | null; title: string }>(
      tx,
      sql`select "status", "publicSummary", "publicDescription", "title" from ${schema.complaints} where "id" = ${id} for update`,
    );
    if (!c) throw new ComplaintInputError('投诉不存在');
    if (!PUBLISHABLE.includes(c.status)) throw new TransitionError('案件未结案（或为驳回案件），不能公开');
    const nextTitle = title ?? c.title;
    await tx.execute(sql`update ${schema.complaints} set "publicDescription" = ${text}, "title" = ${nextTitle}, "publicSummary" = true where "id" = ${id}`);
    await writeAudit(
      tx,
      actor,
      c.publicSummary ? 'complaint_public_revise' : 'complaint_publish',
      { type: 'complaint', id },
      { publicSummary: c.publicSummary, publicDescription: c.publicDescription, title: c.title },
      { publicSummary: true, publicDescription: text, title: nextTitle, checklist: input.checklist },
    );
  });
}
