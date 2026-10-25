/**
 * 积分发放（A-010）：投诉解决 +100；同一事由只发一次；规则停用不发也不报错；「我的」返回下一级门槛与「+N 分」动态。
 * 回传确认 +500 见 postback.test。已迁移 + seed 的库；事务内执行后回滚；业务用例以 bydp_app 执行。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { submitComplaint, transitionComplaint } from '../src/complaint/write';
import { getMe } from '../src/identity/me';
import { awardPoints, nextLevel } from '../src/identity/points';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

async function inTx<T>(fn: (tx: Tx) => Promise<T>, owner?: (tx: Tx) => Promise<unknown>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      if (owner) await owner(tx);
      await tx.execute(sql`set local role bydp_app`);
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}
const ARB = { id: 'arb_1' };
const COMPLAINT = { brandId: 'br_winner', category: 'refused' as const, amountUsdt: 800, eventDate: '2026-09-20', description: 'x' };
const points = async (tx: Tx, u: string) =>
  ((await tx.execute(sql`select "points", "level" from "app_user" where "id" = ${u}`)) as unknown as { points: number; level: number }[])[0]!;

describe('nextLevel（门槛 0 / 500 / 1500 / 3000 / 6000）', () => {
  it('差额与满级', () => {
    expect(nextLevel(0)).toEqual({ level: 2, at: 500, gap: 500 });
    expect(nextLevel(499)).toEqual({ level: 2, at: 500, gap: 1 });
    expect(nextLevel(500)).toEqual({ level: 3, at: 1500, gap: 1000 });
    expect(nextLevel(5999)).toEqual({ level: 5, at: 6000, gap: 1 });
    expect(nextLevel(6000)).toBeNull();
  });
});

describe.skipIf(!url)('积分发放（A-010）', () => {
  it('投诉经仲裁转「已解决」→ 投诉人 +100（每案一次）；「我的」动态出现「+100 分」、返回 nextLevelAt', async () => {
    const r = await inTx(async (tx) => {
      const before = await points(tx, 'u_233');
      const c = await submitComplaint(tx, 'u_233', COMPLAINT);
      await transitionComplaint(tx, c.id, 'accepted', ARB);
      await transitionComplaint(tx, c.id, 'awaiting_reply', ARB);
      await tx.execute(sql`reset role`);
      await tx.execute(sql`update "complaint" set "operatorRepliedAt" = now() where "id" = ${c.id}`);
      await tx.execute(sql`set local role bydp_app`);
      await transitionComplaint(tx, c.id, 'arbitrating', ARB);
      await transitionComplaint(tx, c.id, 'resolved', ARB);
      const after = await points(tx, 'u_233');
      const dup = await awardPoints(tx, { userId: 'u_233', event: 'complaint_resolved', refType: 'complaint', refId: c.id, dedupeKey: `complaint_resolved:${c.id}` });
      const me = await getMe(tx, 'u_233');
      return { id: c.id, before, after, dup, me };
    });
    expect(r.after.points - r.before.points).toBe(100);
    expect(r.dup).toBe(0);
    expect(r.me?.activity?.find((a) => a.subject === '积分')).toMatchObject({ rest: '投诉已解决', tag: '+100 分', ref: `/me/complaints/${r.id}` });
    expect(r.me?.user?.nextLevelAt).toBe(nextLevel(r.after.points)?.at);
  });

  it('规则停用 → 不发放、不报错（不拖垮上游事务）', async () => {
    const r = await inTx(
      (tx) => awardPoints(tx, { userId: 'u_233', event: 'review_published', refType: 'review', refId: 'rv_x', dedupeKey: 'review_published:rv_x' }),
      (tx) => tx.execute(sql`update "points_rule" set "active" = false where "event" = 'review_published'`),
    );
    expect(r).toBe(0);
  });
});
