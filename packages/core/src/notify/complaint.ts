/**
 * 投诉状态通知（M2 notifications · §9.2）：状态变更时在同一事务内给投诉人（及该案件的订阅者）写站内通知 Notification；
 * 推送（TG / 邮件）由调用方在事务提交后入队（worker 消费，见 ./deliver.ts）。
 * 文案口径：不出现「保险」「留存率」；不承诺时限（除 §5 规定的 7 天答辩期）；驳回须告知原因（§9.2 v1.6）。文案经协调官审定（D-011 #4）。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { ComplaintStatus } from '../complaint/state';

type Exec = Pick<Db, 'execute'>;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export type ComplaintNoticeCtx = { id: string; replyDeadline?: Date | null; reason?: string | null };

/** 纯函数：状态 → 标题 / 正文 */
export function complaintNotice(status: ComplaintStatus, c: ComplaintNoticeCtx): { title: string; body: string } {
  const t = (s: string) => `投诉 #${c.id} ${s}`;
  switch (status) {
    case 'screening':
      return { title: t('已提交'), body: '案件待初筛，结果会再次通知你。' };
    case 'accepted':
      return { title: t('已受理'), body: '已受理。我们会通知运营商，答辩期 7 天；期间有进展会再通知你。' };
    case 'awaiting_reply':
      return { title: t('已通知运营商'), body: c.replyDeadline ? `答辩期至 ${ymd(c.replyDeadline)}。` : '答辩期 7 天。' };
    case 'arbitrating':
      return { title: t('进入仲裁'), body: '运营商已答辩，案件进入仲裁。' };
    case 'resolved':
      return { title: t('已解决'), body: '案件已解决，详情见案件进度页。' };
    case 'rejected':
      return { title: t('未受理'), body: `原因：${c.reason?.trim() || '不在受理范围'}。可补充证据后重新提交。` };
    case 'unresolved':
      return { title: t('未解决'), body: '仲裁未能促成解决，详情见案件进度页。' };
    case 'exposed':
      return { title: t('已转曝光'), body: '运营商答辩期内未回应，案件已公开曝光。' };
  }
}

/**
 * 写站内通知：投诉人一条；订阅了该案件的其他用户各一条（驳回原因只发给投诉人本人）。返回新通知 id（供入队推送）。
 */
export async function createComplaintNotifications(db: Exec, complaintId: string, status: ComplaintStatus, reason?: string | null): Promise<string[]> {
  const [c] = (await db.execute(
    sql`select "userId", "replyDeadline" from ${schema.complaints} where "id" = ${complaintId}`,
  )) as unknown as { userId: string; replyDeadline: Date | string | null }[];
  if (!c) return [];
  const ctx = { id: complaintId, replyDeadline: c.replyDeadline ? new Date(c.replyDeadline) : null };
  const own = complaintNotice(status, { ...ctx, reason });
  const pub = complaintNotice(status, ctx);
  const subs = (await db.execute(
    sql`select distinct "userId" from ${schema.subscriptions}
        where "targetType" = 'complaint' and "targetId" = ${complaintId} and "userId" <> ${c.userId}`,
  )) as unknown as { userId: string }[];
  const rows = [{ userId: c.userId, ...own }, ...(status === 'rejected' ? [] : subs.map((s) => ({ userId: s.userId, ...pub })))];
  const ids: string[] = [];
  for (const r of rows) {
    const id = `nt_${crypto.randomUUID().replaceAll('-', '')}`;
    await db.execute(
      sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body") values (${id}, ${r.userId}, 'complaint_status', ${r.title}, ${r.body})`,
    );
    ids.push(id);
  }
  return ids;
}

/**
 * D-025 #2：二次通知也告知投诉人（及订阅者）——「已再次通知运营商，答辩期剩 X 天」。不改状态，type 仍为 complaint_status。
 * 剩余天数向上取整；已届满时写「答辩期已届满」。返回新通知 id（供入队推送）。
 */
export function secondNoticeText(complaintId: string, replyDeadline: Date | null, now = new Date()): { title: string; body: string } {
  const left = replyDeadline ? Math.ceil((replyDeadline.getTime() - now.getTime()) / 86_400_000) : null;
  return {
    title: `投诉 #${complaintId} 已再次通知运营商`,
    body: left == null ? '已再次通知运营商。' : left > 0 ? `已再次通知运营商，答辩期剩 ${left} 天（至 ${ymd(replyDeadline!)}）。` : '已再次通知运营商，答辩期已届满。',
  };
}

export async function createSecondNoticeNotifications(db: Exec, complaintId: string): Promise<string[]> {
  const [c] = (await db.execute(
    sql`select "userId", "replyDeadline", now() as "now" from ${schema.complaints} where "id" = ${complaintId}`,
  )) as unknown as { userId: string; replyDeadline: Date | string | null; now: Date | string }[];
  if (!c) return [];
  const n = secondNoticeText(complaintId, c.replyDeadline ? new Date(c.replyDeadline) : null, new Date(c.now));
  const subs = (await db.execute(
    sql`select distinct "userId" from ${schema.subscriptions}
        where "targetType" = 'complaint' and "targetId" = ${complaintId} and "userId" <> ${c.userId}`,
  )) as unknown as { userId: string }[];
  const ids: string[] = [];
  for (const userId of [c.userId, ...subs.map((s) => s.userId)]) {
    const id = `nt_${crypto.randomUUID().replaceAll('-', '')}`;
    await db.execute(sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body") values (${id}, ${userId}, 'complaint_status', ${n.title}, ${n.body})`);
    ids.push(id);
  }
  return ids;
}
