/** 集成测试夹具：已迁移 + seed 的库；每例在事务内执行后回滚。夹具以表 owner 写（可回填时间），被测代码切到 bydp_app 执行。 */
import { createDb, sql } from '@bydp/db';
import { afterAll } from 'vitest';

export const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());

export type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local bydp.allow_backfill = 'on'`);
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

/** 之后的语句以业务账号执行（不可回填时间、受 0005 权限约束） */
export const asApp = (tx: Tx) => tx.execute(sql`set local role bydp_app`);

export async function q<T = Record<string, unknown>>(tx: Tx, s: ReturnType<typeof sql>) {
  return (await tx.execute(s)) as unknown as T[];
}

/** owner 身份插入历史点击（createdAt = now() - ago） */
export async function oldClick(tx: Tx, id: string, brandId: string, ago: string, extra: { userId?: string; offerId?: string; partnerId?: string } = {}) {
  await tx.execute(sql`insert into "click" ("id","brandId","userId","offerId","partnerId","createdAt")
    values (${id}, ${brandId}, ${extra.userId ?? null}, ${extra.offerId ?? null}, ${extra.partnerId ?? null}, now() - ${ago}::interval)`);
}

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
