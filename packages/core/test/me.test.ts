/** 「我的」用例 + 本人投诉详情（field-mapping 06 / 05）：已迁移 + seed 的库；事务内以 bydp_app 执行后回滚 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { ComplaintMine } from '../src/complaint/index';
import { getMyComplaint } from '../src/complaint/mine';
import { submitComplaint, transitionComplaint } from '../src/complaint/write';
import { BindingConflictError } from '../src/identity/bindings';
import { Binding, MePayload } from '../src/identity/index';
import { BrandNotBindableError, createMyBinding, getMe, listMyBindings, MeInputError, subscribe } from '../src/identity/me';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
process.env.BINDING_HMAC_KEY ??= 'bydp-seed-only-test-key-not-for-production-0001';
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

describe.skipIf(!url)('GET /me（u_102 阿明）', () => {
  it('身份 / 计数 / 绑定 / 动态 / 设置；契约形状；nextLevelAt = 下一级门槛（A-010）；动态不含对象串', async () => {
    const me = await inTx((tx) => getMe(tx, 'u_102'));
    expect(MePayload.parse(me)).toBeTruthy();
    expect(me!.user).toMatchObject({ displayName: '阿明', provider: 'telegram', handleMasked: '@am***', level: 3, points: 2450, joinedAt: '2026-04-11' });
    expect(me!.user?.nextLevelAt).toBe([500, 1500, 3000, 6000].find((t) => (me!.user?.points ?? 0) < t));
    expect(me!.counts!.bindings).toBe(me!.bindings!.length);
    expect(me!.activity!.length).toBeGreaterThan(0);
    expect(JSON.stringify(me!.activity)).not.toContain('[object Object]');
    expect(me!.activity!.map((a) => a.date)).toEqual([...me!.activity!.map((a) => a.date)].sort().reverse());
    expect(await inTx((tx) => getMe(tx, 'u_nope'))).toBeNull();
  });

  it('绑定只返回服务端掩码，不返回账号原文或盲索引', async () => {
    const list = await inTx((tx) => listMyBindings(tx, 'u_102'));
    for (const b of list) expect(Binding.parse(b)).toBeTruthy();
    expect(list[0]!.operatorAccountIdMasked).toBe('JL*******1');
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe.skipIf(!url)('动态「已用」（D-011 #2）', () => {
  it('码的 Click 有 first_deposit 转化 → 标「已用」；仅注册 → 仍为「领码」', async () => {
    const me = await inTx(
      (tx) => getMe(tx, 'u_102'),
      async (tx) => {
        await tx.execute(sql`insert into "click" ("id","brandId","offerId","promoCodeId","userId") values ('clk_used','br_jinlong','of_001','pc_001','u_102'), ('clk_reg','br_jinlong','of_003','pc_003','u_102')`);
        await tx.execute(sql`insert into "conversion" ("id","clickId","brandId","externalEventId","operatorAccountIdHash","event") values
          ('cv_u','clk_used','br_jinlong','e-u',${'a'.repeat(64)},'first_deposit'), ('cv_r','clk_reg','br_jinlong','e-r',${'b'.repeat(64)},'register')`);
      },
    );
    const claims = me!.activity!.filter((a) => a.subject?.startsWith('领码') || a.subject === '领取优惠');
    expect(claims.map((a) => a.tag).sort()).toEqual(['已用', '领码']);
  });
});

describe.skipIf(!url)('POST /me/bindings · /me/subscriptions', () => {
  it('手填 → 自报级 manual；带未领过的码 → 400；领过的码 → promo_link；同品牌同账号 → 冲突；品牌不存在 → 400', async () => {
    const r = await inTx(
      async (tx) => {
        const manual = await createMyBinding(tx, 'u_233', { brandId: 'br_royal', operatorAccountId: 'RA-12345678' });
        const notClaimed = await createMyBinding(tx, 'u_233', { brandId: 'br_jinlong', operatorAccountId: 'JL-1', promoCodeId: 'pc_001' }).catch((e) => e);
        const promo = await createMyBinding(tx, 'u_102', { brandId: 'br_jinlong', operatorAccountId: 'JL-NEW-777', promoCodeId: 'pc_001' });
        const noBrand = await createMyBinding(tx, 'u_233', { brandId: 'br_nope', operatorAccountId: 'X-1' }).catch((e) => e);
        const blacklisted = await createMyBinding(tx, 'u_233', { brandId: 'br_caishen', operatorAccountId: 'CS-1' }).catch((e) => e);
        const watch = await createMyBinding(tx, 'u_233', { brandId: 'br_winner', operatorAccountId: 'WN-1' });
        // 唯一冲突会中止当前事务（真实请求各自一个事务），放最后
        const dup = await createMyBinding(tx, 'u_509', { brandId: 'br_royal', operatorAccountId: 'RA-12345678' }).catch((e) => e);
        return { manual, notClaimed, promo, dup, noBrand, blacklisted, watch };
      },
      (tx) => tx.execute(sql`insert into "click" ("id","brandId","offerId","promoCodeId","userId") values ('clk_me','br_jinlong','of_001','pc_001','u_102')`),
    );
    expect(r.manual).toMatchObject({ source: 'manual', verificationLevel: 'self_reported', operatorAccountIdMasked: 'RA********8', compensationEligible: false });
    expect(r.notClaimed).toBeInstanceOf(MeInputError);
    expect(r.promo).toMatchObject({ source: 'promo_link', promoCode: 'BYDP-JL500' });
    expect(r.dup).toBeInstanceOf(BindingConflictError);
    expect(r.noBrand).toBeInstanceOf(MeInputError);
    expect(r.blacklisted).toBeInstanceOf(BrandNotBindableError);
    expect(r.watch).toMatchObject({ source: 'manual', verificationLevel: 'self_reported' });
  });

  it('订阅：品牌可订；他人未公开投诉不可订；重复订阅只更新渠道', async () => {
    const r = await inTx(async (tx) => {
      const a = await subscribe(tx, 'u_233', { targetType: 'brand', targetId: 'br_royal', channel: 'telegram' });
      const b = await subscribe(tx, 'u_233', { targetType: 'brand', targetId: 'br_royal', channel: 'email' });
      const other = await submitComplaint(tx, 'u_102', { brandId: 'br_winner', category: 'refused', amountUsdt: 100, eventDate: '2026-09-20', description: 'x' });
      const denied = await subscribe(tx, 'u_233', { targetType: 'complaint', targetId: other.id, channel: 'telegram' }).catch((e) => e);
      const own = await subscribe(tx, 'u_102', { targetType: 'complaint', targetId: other.id, channel: 'telegram' });
      const [n] = (await tx.execute(sql`select count(*)::int as n, max("channel"::text) as ch from "subscription" where "userId" = 'u_233' and "targetId" = 'br_royal'`)) as unknown as { n: number; ch: string }[];
      return { a, b, denied, own, n };
    });
    expect(r.a.created).toBe(true);
    expect(r.b).toEqual({ id: r.a.id, created: false });
    expect(r.n).toEqual({ n: 1, ch: 'email' });
    expect(r.denied).toBeInstanceOf(MeInputError);
    expect(r.own.created).toBe(true);
  });
});

describe.skipIf(!url)('GET /me/complaints/{id}', () => {
  it('本人可见（含未公开）、他人 → null；证据只给哈希不给存储键；初筛驳回原因对本人可见', async () => {
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx, 'u_102', { brandId: 'br_winner', category: 'refused', amountUsdt: 1200, eventDate: '2026-09-20', description: 'x' });
      await transitionComplaint(tx, c.id, 'rejected', { id: 'arb_1', reason: '重复提交（同 cp_001）' });
      return { mine: await getMyComplaint(tx, 'u_102', c.id), other: await getMyComplaint(tx, 'u_233', c.id) };
    });
    expect(ComplaintMine.parse(r.mine)).toBeTruthy();
    expect(r.mine).toMatchObject({ status: 'rejected', title: '提款被拒 1,200 USDT', notices: 0, compensationEligible: false, evidence: [] });
    expect(r.mine!.timeline!.find((t) => t.subject === '驳回')!.rest).toBe('重复提交（同 cp_001）');
    expect(r.other).toBeNull();
  });
});
