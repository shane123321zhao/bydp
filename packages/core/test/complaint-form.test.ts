/**
 * 05 投诉页读取（web）+ 首页登录态条：投诉对象候选（全部品牌，认证 → 观察 → 黑名单，附本人绑定）、本人案件所属品牌（他人 null）、MeBrief。
 * 已迁移 + seed 的库；事务内执行后回滚；以 bydp_app 执行。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { getMyComplaintBrand, listComplainableBrands } from '../src/complaint/form';
import { submitComplaint } from '../src/complaint/write';
import { MeBrief } from '../src/identity/index';
import { getMeBrief } from '../src/identity/me';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local role bydp_app`);
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

describe.skipIf(!url)('05 投诉页读取 · 首页登录态条', () => {
  it('投诉对象：全部品牌按认证 → 观察 → 黑名单排列；附本人在该品牌的绑定（无则 null）', async () => {
    const r = await inTx((tx) => listComplainableBrands(tx, 'u_233'));
    const order = { certified: 0, watch: 1, blacklist: 2 } as Record<string, number>;
    const ranks = r.map((x) => order[x.brand.status ?? '']!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(r.map((x) => x.brand.status))).toEqual(new Set(['certified', 'watch', 'blacklist']));
    expect(r.find((x) => x.brand.id === 'br_winner')?.binding).toMatchObject({ id: 'ubb_002', verificationLevel: 'self_reported' });
    expect(r.find((x) => x.brand.id === 'br_caishen')?.binding).toBeNull();
  });

  it('本人案件所属品牌；他人案件 → null', async () => {
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx, 'u_233', { brandId: 'br_winner', category: 'delay', amountUsdt: 300, eventDate: '2026-09-20', description: 'x' });
      return { mine: await getMyComplaintBrand(tx, 'u_233', c.id), other: await getMyComplaintBrand(tx, 'u_102', c.id) };
    });
    expect(r.mine?.slug).toBe('winner-sports');
    expect(r.other).toBeNull();
  });

  it('MeBrief：契约形状；进行中投诉随提交 +1；不存在的用户 → null', async () => {
    const r = await inTx(async (tx) => {
      const before = await getMeBrief(tx, 'u_233');
      await submitComplaint(tx, 'u_233', { brandId: 'br_winner', category: 'delay', amountUsdt: 300, eventDate: '2026-09-20', description: 'x' });
      return { before, after: await getMeBrief(tx, 'u_233'), none: await getMeBrief(tx, 'u_nope') };
    });
    expect(MeBrief.parse(r.before)).toBeTruthy();
    expect(r.after!.activeComplaints).toBe(r.before!.activeComplaints + 1);
    expect(r.none).toBeNull();
  });
});
