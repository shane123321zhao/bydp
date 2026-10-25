/** D-020 #4：运维守卫——DB 时区断言、告警推送（只推 admin 的 TG、同事件 10 分钟一次、推送失败不抛）、磁盘读数。需 DATABASE_URL。 */
import { createDb } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { signInWithIdentity } from '../src/identity/auth';
import { assertDbUtc, createAlerter, DbTimezoneError, diskAvailableGb, errorSummary } from '../src/ops/index';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
const keys = { hmacKey: Buffer.alloc(32, 7), piiKey: Buffer.alloc(32, 9) };

describe.skipIf(!url)('运维守卫', () => {
  it('DB 时区：UTC 通过；会话改为 Asia/Shanghai → DbTimezoneError', async () => {
    await expect(assertDbUtc(conn!.db)).resolves.toBeUndefined();
    let err: unknown = null;
    await conn!.db
      .transaction(async (tx) => {
        await tx.execute(`set local timezone = 'Asia/Shanghai'` as never);
        err = await assertDbUtc(tx as never).catch((e) => e);
        tx.rollback();
      })
      .catch(() => {});
    expect(err).toBeInstanceOf(DbTimezoneError);
  });

  it('告警：只推给 admin 角色的 TG 账号；同事件 10 分钟内只推一次；推送失败不抛', async () => {
    const sent: [string, string][] = [];
    let t = 1_000_000;
    await conn!.db
      .transaction(async (tx) => {
        const adm = await signInWithIdentity(tx as never, { provider: 'telegram', account: '7001', handle: '@adm' }, keys);
        await signInWithIdentity(tx as never, { provider: 'telegram', account: '7002', handle: '@usr' }, keys);
        await tx.execute(`insert into "role" ("key","name") values ('admin','管理员') on conflict do nothing` as never);
        await tx.execute(`insert into "user_role" ("userId","roleKey") values ('${adm.userId}','admin')` as never);
        const alert = createAlerter({ db: tx as never, keys: () => keys, send: () => async (chat, text) => (sent.push([chat, text]), 'ok'), env: 'test', now: () => t });
        await alert('disk_low', '磁盘可用 17GB');
        await alert('disk_low', '磁盘可用 16GB');
        t += 11 * 60_000;
        await alert('disk_low', '磁盘可用 15GB');
        const failing = createAlerter({ db: tx as never, keys: () => keys, send: () => async () => { throw new Error('tg down'); } });
        await expect(failing('x', 'y')).resolves.toBeUndefined();
        tx.rollback();
      })
      .catch((e: Error) => {
        if (!/rollback/i.test(e.message)) throw e;
      });
    expect(sent.map(([c]) => c)).toEqual(['7001', '7001']);
    expect(sent[0]![1]).toContain('disk_low');
  });

  it('errorSummary 只取类名与数据库错误码，不含 message（drizzle 的 message 带 SQL 参数）', () => {
    const e = Object.assign(new Error('Failed query: select ... params: u_secret_user,2026-10-01'), { name: 'DrizzleQueryError', cause: Object.assign(new Error('x'), { code: '23505' }) });
    expect(errorSummary(e)).toBe('DrizzleQueryError（数据库错误码 23505）');
    expect(errorSummary(new TypeError('boom u_x'))).toBe('TypeError');
  });

  it('磁盘读数为正整数 GB', async () => {
    expect(await diskAvailableGb('/')).toBeGreaterThan(0);
  });
});
