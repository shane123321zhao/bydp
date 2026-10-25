/**
 * 答辩期人工口径（§9.2 v1.7 · D-011 #1）：P1 库中无运营商联系方式，「两次通知运营商」由仲裁员经官方渠道人工发出，
 * 在仲裁台点「已通知」时调用本模块记录；转曝光须仲裁员人工确认。每个人工动作写 audit_log（操作人 + 服务器时间，只追加）。
 * 定时任务只做提醒与标记（replyWindowWatch），不自动曝光。仲裁台 UI 属 M3；测试以脚本代替人工点击。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { ComplaintStatus } from './state';
import { ComplaintInputError, recordSecondNotice, transitionComplaint } from './write';
import { createSecondNoticeNotifications } from '../notify/complaint';

type Tx = Pick<Db, 'execute' | 'transaction'>;
export type Arbiter = { id: string; role?: 'arbitrator' | 'admin'; ip?: string | null };

/** 答辩期剩余不足该时长且未发二次通知 → 提醒（§9.2 v1.7：剩 72h） */
export const SECOND_NOTICE_REMIND_HOURS = 72;

async function audit(tx: Pick<Db, 'execute'>, a: Arbiter, action: string, complaintId: string, before: unknown, after: unknown) {
  await tx.execute(
    sql`insert into ${schema.auditLogs} ("actorId", "actorRole", "action", "targetType", "targetId", "before", "after", "ip")
        values (${a.id}, ${a.role ?? 'arbitrator'}, ${action}, 'complaint', ${complaintId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, ${a.ip ?? null})`,
  );
}

async function snapshot(tx: Pick<Db, 'execute'>, id: string) {
  const [c] = (await tx.execute(
    sql`select "status", "operatorNotifiedAt", "secondNoticeAt", "replyDeadline" from ${schema.complaints} where "id" = ${id} for update`,
  )) as unknown as { status: ComplaintStatus; operatorNotifiedAt: string | null; secondNoticeAt: string | null; replyDeadline: string | null }[];
  if (!c) throw new ComplaintInputError('投诉不存在');
  return c;
}

/**
 * 仲裁员「已通知运营商」：first = 受理后首次通知（accepted → awaiting_reply，答辩期 7 天起算，服务器时间）；
 * second = 答辩期内二次通知。返回新通知 id（投诉人站内通知，供入队推送）。
 * extra.channel：经哪个官方渠道通知（admin 契约 v0.2），记入 audit_log after。
 */
export async function recordOperatorNotice(
  db: Tx,
  complaintId: string,
  which: 'first' | 'second',
  a: Arbiter,
  extra: { channel?: string } = {},
): Promise<{ notificationIds: string[] }> {
  return db.transaction(async (tx) => {
    const before = await snapshot(tx, complaintId);
    let notificationIds: string[] = [];
    if (which === 'first') notificationIds = (await transitionComplaint(tx, complaintId, 'awaiting_reply', { id: a.id, reason: '仲裁员已经官方渠道通知运营商' })).notificationIds;
    else {
      await recordSecondNotice(tx, complaintId);
      notificationIds = await createSecondNoticeNotifications(tx, complaintId); // D-025 #2
    }
    const after = await snapshot(tx, complaintId);
    await audit(tx, a, which === 'first' ? 'operator_notice_first' : 'operator_notice_second', complaintId, before, extra.channel ? { ...after, channel: extra.channel } : after);
    return { notificationIds };
  });
}

/**
 * D-025 #1（F4）：记录运营商答辩 → 进入仲裁。仅「待答辩」且尚无答辩的案件；同事务内：
 * 写 operator_reply（摘要可空，空时记「运营商已答辩（摘要未填写）」）→ 写 operatorRepliedAt → 状态机 awaiting_reply → arbitrating（守卫照常）→ 审计。
 * 进入仲裁后由仲裁员按既有流转裁「已解决 / 未解决 / 驳回」，再走公开前脱敏确认。
 */
export async function recordOperatorReply(db: Tx, complaintId: string, a: Arbiter, summary: string | null): Promise<{ notificationIds: string[] }> {
  const text = summary?.trim().slice(0, 1000) || '运营商已答辩（摘要未填写）';
  return db.transaction(async (tx) => {
    const before = await snapshot(tx, complaintId);
    const rows = (await tx.execute(
      sql`update ${schema.complaints} set "operatorRepliedAt" = now()
          where "id" = ${complaintId} and "status" = 'awaiting_reply' and "operatorRepliedAt" is null
          returning "id"`,
    )) as unknown as { id: string }[];
    if (!rows.length) throw new ComplaintInputError('仅待答辩且尚未记录答辩的案件可记录运营商答辩');
    await tx.execute(sql`insert into ${schema.operatorReplies} ("id", "complaintId", "summary") values (${`or_${crypto.randomUUID().replaceAll('-', '')}`}, ${complaintId}, ${text})`);
    const { notificationIds } = await transitionComplaint(tx, complaintId, 'arbitrating', { id: a.id, reason: '运营商已答辩，进入仲裁' });
    await audit(tx, a, 'operator_reply_recorded', complaintId, before, { ...(await snapshot(tx, complaintId)), summary: text });
    return { notificationIds };
  });
}

/**
 * 仲裁员确认转曝光（人工）：状态机守卫照常生效——失联须两次通知 + 答辩期届满 + 无答辩；受理后直接曝光仅限黑名单品牌。
 */
export async function confirmExposure(db: Tx, complaintId: string, a: Arbiter, reason: string): Promise<{ notificationIds: string[] }> {
  if (!reason.trim()) throw new ComplaintInputError('确认曝光须填写依据');
  return db.transaction(async (tx) => {
    const before = await snapshot(tx, complaintId);
    const { notificationIds } = await transitionComplaint(tx, complaintId, 'exposed', { id: a.id, reason });
    await audit(tx, a, 'exposure_confirmed', complaintId, before, { ...(await snapshot(tx, complaintId)), reason });
    return { notificationIds };
  });
}

export type ReplyWindowItem = { id: string; brandId: string; replyDeadline: string };

/**
 * 定时提醒与标记（worker 每小时）：只读，不改状态、不曝光。
 * - secondNoticeDue：待答辩、未发二次通知、无答辩、答辩期剩余 ≤ 72h（含已过期仍未发二次通知的）；
 * - pendingExposureDecision：待答辩、两次通知已发、无答辩、答辩期已届满 → 「待决定失联曝光」，等仲裁员确认。
 */
export async function replyWindowWatch(db: Pick<Db, 'execute'>): Promise<{ secondNoticeDue: ReplyWindowItem[]; pendingExposureDecision: ReplyWindowItem[] }> {
  const rows = (await db.execute(
    sql`select "id", "brandId", "replyDeadline", "secondNoticeAt" is not null as "second", "replyDeadline" <= now() as "lapsed",
               "replyDeadline" <= now() + make_interval(hours => ${SECOND_NOTICE_REMIND_HOURS}) as "soon"
        from ${schema.complaints}
        where "status" = 'awaiting_reply' and "operatorRepliedAt" is null and "replyDeadline" is not null
        order by "replyDeadline", "id"`,
  )) as unknown as { id: string; brandId: string; replyDeadline: Date | string; second: boolean; lapsed: boolean; soon: boolean }[];
  const item = (r: (typeof rows)[number]) => ({ id: r.id, brandId: r.brandId, replyDeadline: new Date(r.replyDeadline).toISOString() });
  return {
    secondNoticeDue: rows.filter((r) => !r.second && r.soon).map(item),
    pendingExposureDecision: rows.filter((r) => r.second && r.lapsed).map(item),
  };
}
