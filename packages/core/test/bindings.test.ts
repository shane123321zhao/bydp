/** createBinding 集成测试（需 DATABASE_URL，已迁移 + seed 的库；每例事务内执行后回滚） */
import { createDb, decryptOperatorAccountId, hashOperatorAccountId } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { BindingConflictError, createBinding } from '../src/identity/bindings';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
const KEY = 'test-key-for-core-bindings-0123456789abcdef';
const PII = Buffer.alloc(32, 7); // 仅测试

async function inTx<T>(fn: Parameters<NonNullable<typeof conn>['db']['transaction']>[0] extends (tx: infer X) => unknown ? (tx: X) => Promise<T> : never) {
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

describe.skipIf(!url)('createBinding', () => {
  it('写入 HMAC 盲索引、密文 + 掩码（明文不落库，A-011）、服务端 boundAt、自报级', async () => {
    const r = await inTx(async (tx) => {
      const row = await createBinding(tx, { userId: 'u_509', brandId: 'br_royal', operatorAccountId: '  RA-778 ', source: 'manual' }, KEY, PII);
      return { row, now: row.createdAt }; // createdAt 与 boundAt 同由触发器取事务时间 now()
    });
    // A-011：明文不落库；密文按 binding.id 解回规范化账号，换 id / 换密钥均解不开；掩码写入时计算
    expect(r.row).not.toHaveProperty('operatorAccountId');
    expect(decryptOperatorAccountId(r.row.operatorAccountIdEnc!, PII, r.row.id)).toBe('RA-778');
    expect(() => decryptOperatorAccountId(r.row.operatorAccountIdEnc!, PII, 'ubb_other')).toThrow();
    expect(() => decryptOperatorAccountId(r.row.operatorAccountIdEnc!, Buffer.alloc(32, 8), r.row.id)).toThrow();
    expect(r.row.operatorAccountIdMasked).toBe('R****8'); // #18：6 位露 ⌊6/3⌋ = 2 位（前 1 后 1）
    expect(r.row.operatorAccountIdHash).toBe(hashOperatorAccountId('RA-778', KEY));
    expect(r.row.verificationLevel).toBe('self_reported');
    expect(new Date(r.row.boundAt).getTime()).toBe(new Date(r.now).getTime());
    expect(Date.now() - new Date(r.row.boundAt).getTime()).toBeLessThan(60_000);
  });

  it('同品牌同账号（含首尾空白差异）→ BindingConflictError', async () => {
    const err = await inTx(async (tx) => {
      await createBinding(tx, { userId: 'u_509', brandId: 'br_royal', operatorAccountId: 'RA-1', source: 'manual' }, KEY);
      return createBinding(tx, { userId: 'u_777', brandId: 'br_royal', operatorAccountId: ' RA-1', source: 'manual' }, KEY).catch((e) => e);
    });
    expect(err).toBeInstanceOf(BindingConflictError);
  });

  it('入参校验：缺字段 / 空账号被拒', async () => {
    await expect(createBinding(conn!.db, { userId: 'u_1', brandId: 'br_royal', operatorAccountId: '   ', source: 'manual' }, KEY)).rejects.toThrow();
    // @ts-expect-error 缺 source
    await expect(createBinding(conn!.db, { userId: 'u_1', brandId: 'br_royal', operatorAccountId: 'x' }, KEY)).rejects.toThrow();
  });
});
