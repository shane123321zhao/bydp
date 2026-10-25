/**
 * 答辩期人工口径（§9.2 v1.7）：脚本代替仲裁员点击；计时器以 owner 改 replyDeadline 缩短（D-001 验收口径）。
 * 已迁移 + seed 的库；事务内执行后回滚；业务用例以 bydp_app 执行。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { confirmExposure, recordOperatorNotice, recordOperatorReply, replyWindowWatch } from '../src/complaint/arbitration';
import { secondNoticeText } from '../src/notify/complaint';
import { TransitionError } from '../src/complaint/state';
import { submitComplaint, transitionComplaint } from '../src/complaint/write';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];
const ARB = { id: 'arb_1', role: 'arbitrator' as const, ip: '203.0.113.5' };
const COMPLAINT = { brandId: 'br_winner', category: 'refused' as const, amountUsdt: 800, eventDate: '2026-09-20', description: 'x' };

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}
const asApp = (tx: Tx) => tx.execute(sql`set local role bydp_app`);
const asOwner = (tx: Tx) => tx.execute(sql`reset role`);
const shorten = async (tx: Tx, id: string, interval: string) => {
  await asOwner(tx);
  await tx.execute(sql`update "complaint" set "replyDeadline" = now() + ${interval}::interval where "id" = ${id}`);
  await asApp(tx);
};

describe.skipIf(!url)('答辩期人工口径（§9.2 v1.7）', () => {
  it('受理 → 首次通知（答辩期 7 天起算、写 audit_log、投诉人收到通知）→ 二次通知（写 audit_log）', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const c = await submitComplaint(tx, 'u_102', COMPLAINT);
      await transitionComplaint(tx, c.id, 'accepted', { id: 'arb_1' });
      const first = await recordOperatorNotice(tx, c.id, 'first', ARB);
      await recordOperatorNotice(tx, c.id, 'second', ARB);
      const [row] = (await tx.execute(
        sql`select "status", ("replyDeadline" - "operatorNotifiedAt") = interval '7 days' as "seven", "secondNoticeAt" is not null as "second" from "complaint" where "id" = ${c.id}`,
      )) as unknown as { status: string; seven: boolean; second: boolean }[];
      const audits = (await tx.execute(
        sql`select "actorId", "actorRole", "action", "ip", "before"->>'status' as "from", "after"->>'status' as "to" from "audit_log" where "targetId" = ${c.id} order by "id"`,
      )) as unknown as Record<string, string>[];
      return { first, row, audits };
    });
    expect(r.row).toEqual({ status: 'awaiting_reply', seven: true, second: true });
    expect(r.first.notificationIds).toHaveLength(1);
    expect(r.audits).toEqual([
      { actorId: 'arb_1', actorRole: 'arbitrator', action: 'operator_notice_first', ip: '203.0.113.5', from: 'accepted', to: 'awaiting_reply' },
      { actorId: 'arb_1', actorRole: 'arbitrator', action: 'operator_notice_second', ip: '203.0.113.5', from: 'awaiting_reply', to: 'awaiting_reply' },
    ]);
  });

  it('定时只提醒不曝光：剩 ≤72h 未发二次通知 → 提醒；两次通知 + 期满 → 待决定失联曝光；状态不变', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const c = await submitComplaint(tx, 'u_102', COMPLAINT);
      await transitionComplaint(tx, c.id, 'accepted', { id: 'arb_1' });
      await recordOperatorNotice(tx, c.id, 'first', ARB);
      const far = await replyWindowWatch(tx);
      await shorten(tx, c.id, '48 hours');
      const soon = await replyWindowWatch(tx);
      await recordOperatorNotice(tx, c.id, 'second', ARB);
      await shorten(tx, c.id, '-1 hour');
      const lapsed = await replyWindowWatch(tx);
      const [st] = (await tx.execute(sql`select "status" from "complaint" where "id" = ${c.id}`)) as unknown as { status: string }[];
      const ids = (x: { id: string }[]) => x.map((i) => i.id).includes(c.id);
      return { far: ids(far.secondNoticeDue), soon: ids(soon.secondNoticeDue), lapsedDue: ids(lapsed.secondNoticeDue), pending: ids(lapsed.pendingExposureDecision), status: st!.status };
    });
    expect(r).toEqual({ far: false, soon: true, lapsedDue: false, pending: true, status: 'awaiting_reply' });
  });

  it('人工确认曝光：期满前 → 状态机拒绝；须填依据；期满后确认 → 已曝光 + audit_log + 通知', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const c = await submitComplaint(tx, 'u_102', COMPLAINT);
      await transitionComplaint(tx, c.id, 'accepted', { id: 'arb_1' });
      await recordOperatorNotice(tx, c.id, 'first', ARB);
      await recordOperatorNotice(tx, c.id, 'second', ARB);
      const early = await confirmExposure(tx, c.id, ARB, '两次通知无响应').catch((e) => e);
      const noReason = await confirmExposure(tx, c.id, ARB, '  ').catch((e: Error) => e.message);
      await shorten(tx, c.id, '-1 hour');
      const done = await confirmExposure(tx, c.id, ARB, '两次通知无响应，答辩期届满');
      const [st] = (await tx.execute(sql`select "status", "exposedAt" is not null as "at" from "complaint" where "id" = ${c.id}`)) as unknown as { status: string; at: boolean }[];
      const [a] = (await tx.execute(
        sql`select "action", "after"->>'reason' as "reason" from "audit_log" where "targetId" = ${c.id} and "action" = 'exposure_confirmed'`,
      )) as unknown as { action: string; reason: string }[];
      return { early, noReason, done, st, a };
    });
    expect(r.early).toBeInstanceOf(TransitionError);
    expect(r.noReason).toMatch(/依据/);
    expect(r.done.notificationIds.length).toBeGreaterThan(0);
    expect(r.st).toEqual({ status: 'exposed', at: true });
    expect(r.a).toEqual({ action: 'exposure_confirmed', reason: '两次通知无响应，答辩期届满' });
  });

  it('D-025：二次通知给投诉人写站内通知「已再次通知运营商，答辩期剩 X 天」', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const c = await submitComplaint(tx, 'u_102', COMPLAINT);
      await transitionComplaint(tx, c.id, 'accepted', { id: 'arb_1' });
      await recordOperatorNotice(tx, c.id, 'first', ARB);
      const second = await recordOperatorNotice(tx, c.id, 'second', ARB);
      const rows = (await tx.execute(
        sql`select "userId", "title", "body" from "notification" where "id" in ${sql.raw(`('${second.notificationIds.join("','")}')`)}`,
      )) as unknown as { userId: string; title: string; body: string }[];
      return { c, second, rows };
    });
    expect(r.second.notificationIds.length).toBeGreaterThanOrEqual(1);
    const own = r.rows.find((x) => x.userId === 'u_102')!;
    expect(own.title).toBe(`投诉 #${r.c.id} 已再次通知运营商`);
    expect(own.body).toMatch(/^已再次通知运营商，答辩期剩 7 天（至 \d{4}-\d{2}-\d{2}）。$/);
  });

  it('D-025：二次通知文案——剩余天数向上取整；届满后写「已届满」', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    expect(secondNoticeText('cp_1', new Date('2026-10-22T01:00:00Z'), now).body).toBe('已再次通知运营商，答辩期剩 3 天（至 2026-10-22）。');
    expect(secondNoticeText('cp_1', new Date('2026-10-19T00:00:00Z'), now).body).toBe('已再次通知运营商，答辩期已届满。');
  });

  it('D-025（F4）：记录运营商答辩 → 进入仲裁 → 可裁已解决（+100 积分）；重复记录 / 非待答辩被拒；答辩后不可失联曝光', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const c = await submitComplaint(tx, 'u_102', COMPLAINT);
      await transitionComplaint(tx, c.id, 'accepted', { id: 'arb_1' });
      const notAwaiting = await recordOperatorReply(tx, c.id, ARB, '太早').catch((e: Error) => e.message);
      await recordOperatorNotice(tx, c.id, 'first', ARB);
      const reply = await recordOperatorReply(tx, c.id, ARB, '  ');
      const again = await recordOperatorReply(tx, c.id, ARB, '再次').catch((e: Error) => e.message);
      const [row] = (await tx.execute(
        sql`select "status", "operatorRepliedAt" is not null as "replied" from "complaint" where "id" = ${c.id}`,
      )) as unknown as { status: string; replied: boolean }[];
      const replies = (await tx.execute(sql`select "summary" from "operator_reply" where "complaintId" = ${c.id}`)) as unknown as { summary: string }[];
      const [a] = (await tx.execute(
        sql`select "before"->>'status' as "from", "after"->>'status' as "to" from "audit_log" where "targetId" = ${c.id} and "action" = 'operator_reply_recorded'`,
      )) as unknown as { from: string; to: string }[];
      await shorten(tx, c.id, '-1 hour');
      const expose = await confirmExposure(tx, c.id, ARB, '期满').catch((e) => e);
      await transitionComplaint(tx, c.id, 'resolved', { id: 'arb_1', reason: '运营商已出款' });
      const [pts] = (await tx.execute(
        sql`select count(*)::int as "n" from "points_event" where "dedupeKey" = ${`complaint_resolved:${c.id}`}`,
      )) as unknown as { n: number }[];
      const [end] = (await tx.execute(sql`select "status" from "complaint" where "id" = ${c.id}`)) as unknown as { status: string }[];
      return { notAwaiting, reply, again, row, replies, a, expose, pts, end };
    });
    expect(r.notAwaiting).toMatch(/仅待答辩/);
    expect(r.reply.notificationIds.length).toBeGreaterThanOrEqual(1);
    expect(r.again).toMatch(/仅待答辩/);
    expect(r.row).toEqual({ status: 'arbitrating', replied: true });
    expect(r.replies).toEqual([{ summary: '运营商已答辩（摘要未填写）' }]);
    expect(r.a).toEqual({ from: 'awaiting_reply', to: 'arbitrating' });
    expect(r.expose).toBeInstanceOf(TransitionError);
    expect(r.pts?.n).toBe(1);
    expect(r.end?.status).toBe('resolved');
  });
});

