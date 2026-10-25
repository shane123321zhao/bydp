/** 开发会话自检（M1 reviewer）发现项的回归测试；需 DATABASE_URL（已迁移 + seed），DB 写入均在事务内回滚 */
import { createDb, hashOperatorAccountId } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { redactStatement } from '../src/complaint/cases';
import { createBinding, normalizeOperatorAccountId, BindingConflictError } from '../src/identity/bindings';
import { getBrandScore } from '../src/trust/brands';
import { checkIdentifier } from '../src/trust/check';
import { CheckResult } from '../src/trust/index';

describe('redactStatement（#4）', () => {
  it.each([
    ['客服 @cs_helper_88 说要解冻费', '客服 @*** 说要解冻费'],
    ['我的账号 RA-778 被冻结', '我的账号 R*** 被冻结'],
    ['QQ 12345678 联系', 'QQ 12*** 78 联系'.replace(' 78', '78')],
    ['地址 TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', '地址 TQn…LSE'],
    ['邮箱 a.b@gmail.com', '邮箱 ***@***'],
  ])('%s', (input, want) => expect(redactStatement(input)).toBe(want));
  it('金额与日期不受影响', () => expect(redactStatement('8 月 14 日提款 3,800 USDT')).toBe('8 月 14 日提款 3,800 USDT'));
});

describe('normalizeOperatorAccountId（#11）', () => {
  it('全角与内部空白归一', () => expect(normalizeOperatorAccountId(' ＲＡ-7 78 ')).toBe('RA-778'));
});

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
async function inTx<T>(fn: (tx: Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
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
const KEY = 'test-key-for-core-bindings-0123456789abcdef';

describe.skipIf(!url)('DB 回归', () => {
  it('#1 黑名单品牌即使有快照，因子分数也全部置空', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(
        (await import('@bydp/db')).sql`insert into "score_snapshot" ("id","brandId","algorithmVersion","score","confidence","factorsAvailable","factorsTotal","factors")
          values ('ss_t','br_caishen','v0.3-draft',55,'medium',1,5,'[{"key":"withdrawal","label":"出款表现","weight":30,"score":55,"available":true,"sampleSize":30,"detail":"x"}]'::jsonb)`,
      );
      return getBrandScore(tx, 'caishen-poker');
    });
    expect(r?.score).toBeNull();
    expect(r?.factors?.every((f) => f.score == null)).toBe(true);
  });

  it('#6 未挂品牌的仿冒标识不崩溃，输出仿冒判定', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(
        (await import('@bydp/db')).sql`insert into "identifier" ("id","brandId","type","value","ownership","firstSeen") values ('idf_orphan',null,'domain','orphan-fake.com','fake','2026-09-20')`,
      );
      return checkIdentifier(tx, 'orphan-fake.com', new Date('2026-09-22T00:00:00Z'));
    });
    expect(CheckResult.parse(r).verdict).toBe('fake');
    expect(r.brand).toBeNull();
  });

  it('#11 全角 / 空白变体视为同一账号 → 冲突', async () => {
    const err = await inTx(async (tx) => {
      await createBinding(tx, { userId: 'u_509', brandId: 'br_royal', operatorAccountId: 'RA-778', source: 'manual' }, KEY);
      return createBinding(tx, { userId: 'u_777', brandId: 'br_royal', operatorAccountId: 'ＲＡ-7 78', source: 'manual' }, KEY).catch((e) => e);
    });
    expect(err).toBeInstanceOf(BindingConflictError);
    expect(hashOperatorAccountId('RA-778', KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});
