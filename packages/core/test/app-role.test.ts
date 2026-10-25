/**
 * D-020 #5（HANDOVER §9 #12 / A-001）：以 **bydp_app 登录身份**（不是 owner + SET ROLE）跑一组主链路，证明线上运行身份的授权足够且边界生效。
 * CI 由 scripts/ci.sh 给临时库的 bydp_app 设测试密码并导出 DATABASE_URL_APP；CI 下缺失即失败。每例事务内执行后回滚。
 */
import { createDb } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { checkIdentifier } from '../src/trust/check';
import { getBrandComplaints, getList } from '../src/trust/brands';
import { submitComplaint } from '../src/complaint/write';
import { getMe, subscribe } from '../src/identity/me';
import { claimOfferForUser } from '../src/commerce/tracking';
import { searchBrandIds } from '../src/search/index';
import { listCandidatesByWeight } from '../src/trust/candidate-queries';
import { assertDbUtc } from '../src/ops/index';

const url = process.env.DATABASE_URL_APP;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL_APP（bydp_app 登录身份）');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());

type Tx = NonNullable<typeof conn>['db'];
async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      out = await fn(tx as unknown as Tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}
const deny = async (tx: Tx, stmt: string) => {
  try {
    await tx.execute(`savepoint s` as never);
    await tx.execute(stmt as never);
    await tx.execute(`release savepoint s` as never);
    return 'allowed';
  } catch (e) {
    await tx.execute(`rollback to savepoint s` as never);
    return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code ?? 'error';
  }
};

describe.skipIf(!url)('bydp_app 登录身份（§9 #12）', () => {
  it('连接身份就是 bydp_app（非超级用户、非 owner），会话时区 UTC', async () => {
    const [r] = (await conn!.db.execute(`select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su` as never)) as unknown as { u: string; su: boolean }[];
    expect(r).toEqual({ u: 'bydp_app', su: false });
    await expect(assertDbUtc(conn!.db)).resolves.toBeUndefined();
  });

  it('公开读链路：查验五态 / 名单 / 搜索降级 / 品牌案件 / Candidate 视图', async () => {
    const db = conn!.db;
    expect((await checkIdentifier(db, 'jinlong88.com')).verdict).toBe('certified');
    expect((await checkIdentifier(db, 'cs-poker.net')).verdict).toBe('blacklist');
    expect((await getList(db, 'certified')).items?.length).toBeGreaterThan(0);
    expect(await searchBrandIds(db, '金龍', { meili: null })).toContain('br_jinlong');
    expect((await getBrandComplaints(db, 'jinlong'))?.items?.length).toBeGreaterThan(0);
    expect(Array.isArray(await listCandidatesByWeight(db))).toBe(true);
  });

  it('登录后写链路：提交投诉 / 订阅 / 我的 / 领码', async () => {
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx as never, 'u_233', { brandId: 'br_winner', category: 'refused', amountUsdt: 300, eventDate: '2026-09-20', description: 'bydp_app 身份测试' });
      await subscribe(tx, 'u_233', { targetType: 'brand', targetId: 'br_royal', channel: 'telegram' });
      const me = await getMe(tx, 'u_233');
      const claim = await claimOfferForUser(tx as never, { userId: 'u_233', offerId: 'of_001', region: null }).then(
        () => 'ok',
        (e: Error) => e.name,
      );
      return { status: c.status, me: !!me, claim };
    });
    expect(r.status).toBe('screening');
    expect(r.me).toBe(true);
    expect(r.claim).toBe('ok'); // 领码全链路（Click / 促销码 / 绑定）以 bydp_app 成功，不只是「没抛权限错」
  });

  it('边界：只追加表（状态日志 / 审计 / 身份封禁）不可改删；证据不可删；绑定身份列不可改；不可 TRUNCATE（评分快照与角色由 core 用例以 bydp_app 写，属设计内）', async () => {
    const r = await inTx(async (tx) => ({
      updHistory: await deny(tx, `update "status_history" set "reason" = 'x'`),
      delAudit: await deny(tx, `delete from "audit_log"`),
      delEvidence: await deny(tx, `delete from "evidence"`),
      delIdentityBlock: await deny(tx, `delete from "identity_block"`),
      // 反例断言：验证 bydp_app 改绑定身份列被数据库拒绝（不是业务写入）
      // eslint-disable-next-line no-restricted-syntax
      bindingUser: await deny(tx, `update "user_brand_binding" set "userId" = 'u_102'`),
      truncate: await deny(tx, `truncate "complaint"`),
    }));
    expect(r.updHistory).toBe('42501');
    expect(r.delAudit).toBe('42501');
    expect(r.delEvidence).toBe('42501');
    expect(r.delIdentityBlock).toBe('42501');
    expect(r.bindingUser).toBe('42501');
    expect(r.truncate).toBe('42501');
  });
});
