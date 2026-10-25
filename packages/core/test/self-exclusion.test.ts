/**
 * 自我排除（A-011 · D-013 #3）：任一未到期即生效、取最晚结束；期内拒绝领码（含前往官网链接）与添加绑定；投诉不受影响。
 * 已迁移 + seed 的库；事务内执行后回滚；业务用例以 bydp_app 执行，owner 回调用于造历史数据。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { claimOfferForUser } from '../src/commerce/tracking';
import { submitComplaint } from '../src/complaint/write';
import { createMyBinding } from '../src/identity/me';
import { getSelfExclusion, SelfExcludedError, startSelfExclusion } from '../src/identity/self-exclusion';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
process.env.BINDING_HMAC_KEY ??= 'bydp-seed-only-test-key-not-for-production-0001';
process.env.AUTH_PII_KEY ??= Buffer.alloc(32, 7).toString('base64');
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

async function inTx<T>(fn: (tx: Tx) => Promise<T>, owner?: (tx: Tx) => Promise<unknown>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local bydp.allow_backfill = 'on'`);
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
const days = (iso: string | null) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000) : null);
const COMPLAINT = { brandId: 'br_winner', category: 'refused' as const, amountUsdt: 300, eventDate: '2026-09-20', description: 'x' };

describe.skipIf(!url)('自我排除（A-011）', () => {
  it('期内：领码（含前往官网链接）→ SelfExcludedError；添加绑定 → SelfExcludedError；投诉照常可提交', async () => {
    const r = await inTx(async (tx) => {
      const before = await claimOfferForUser(tx, { userId: 'u_233', offerId: 'of_001', region: 'MY' });
      const state = await startSelfExclusion(tx, 'u_233', '30');
      const claim = await claimOfferForUser(tx, { userId: 'u_233', offerId: 'of_001', region: 'MY' }).catch((e) => e);
      const bind = await createMyBinding(tx, 'u_233', { brandId: 'br_royal', operatorAccountId: 'RA-SE-0001' }).catch((e) => e);
      const complaint = await submitComplaint(tx, 'u_233', COMPLAINT);
      return { before, state, claim, bind, complaint };
    });
    expect(r.before.clickId).toBeTruthy();
    expect(r.state).toMatchObject({ period: '30' });
    expect(days(r.state.endsAt)).toBe(30);
    expect(r.claim).toBeInstanceOf(SelfExcludedError);
    expect(r.bind).toBeInstanceOf(SelfExcludedError);
    expect(r.complaint.id).toBeTruthy();
  });

  it('期内不可撤销：先 365 天再选 30 天 → 仍按 365 天；永久优先', async () => {
    const r = await inTx(async (tx) => {
      await startSelfExclusion(tx, 'u_233', '365');
      const shorter = await startSelfExclusion(tx, 'u_233', '30');
      await startSelfExclusion(tx, 'u_233', 'permanent');
      const forever = await getSelfExclusion(tx, 'u_233');
      return { shorter, forever };
    });
    expect(r.shorter.period).toBe('365');
    expect(days(r.shorter.endsAt)).toBe(365);
    expect(r.forever).toEqual({ period: 'permanent', endsAt: null });
  });

  it('已到期的排除不生效；无排除 → null', async () => {
    const r = await inTx(
      async (tx) => ({ expired: await getSelfExclusion(tx, 'u_233'), none: await getSelfExclusion(tx, 'u_509') }),
      // owner + allow_backfill：造一条 2020 年开始的 30 天排除（早已到期）
      (tx) => tx.execute(sql`insert into "self_exclusion" ("id", "userId", "period", "startsAt") values ('se_old', 'u_233', '30', '2020-01-01')`),
    );
    expect(r).toEqual({ expired: null, none: null });
  });
});
