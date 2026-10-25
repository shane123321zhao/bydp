/** 登录用例（A-009）：已迁移 + seed 的库；每例事务内以 bydp_app 执行后回滚 */
import { randomBytes } from 'node:crypto';
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  consumeVerificationToken,
  findUserByEmail,
  IdentityBlockedError,
  probeIdentityBlocked,
  getSessionUser,
  ipBucket,
  magicLinkAllowed,
  magicLinkWouldAllow,
  MemoryRateCounter,
  purgeExpiredVerificationTokens,
  RedisOnceStore,
  RedisRateCounter,
  revokeAllSessions,
  saveVerificationToken,
  signInWithIdentity,
} from '../src/identity/auth';
import { decryptContact, identityBlindIndex } from '../src/identity/pii';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
const keys = { hmacKey: randomBytes(32), piiKey: randomBytes(32) };
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
const q = async <T>(tx: Tx, s: ReturnType<typeof sql>) => (await tx.execute(s)) as unknown as T[];

describe('限流（A-009 签核条件 4）', () => {
  it('同一邮箱 10 分钟 ≤ 3 封（大小写 / 空白不同视为同一邮箱）；窗口过后恢复', async () => {
    let t = 0;
    const c = new MemoryRateCounter(() => t);
    const r = [];
    for (const e of ['a@x.com', ' A@X.com', 'a@x.com', 'a@x.com']) r.push(await magicLinkAllowed(c, { email: e, ip: '1.1.1.1' }, keys));
    expect(r).toEqual([true, true, true, false]);
    t = 600_000;
    expect(await magicLinkAllowed(c, { email: 'a@x.com', ip: '1.1.1.1' }, keys)).toBe(true);
  });
  it('同一 IP 1 小时 ≤ 20 封（换邮箱也算）', async () => {
    const c = new MemoryRateCounter(() => 0);
    const r = [];
    for (let i = 0; i < 21; i++) r.push(await magicLinkAllowed(c, { email: `u${i}@x.com`, ip: '2.2.2.2' }, keys));
    expect(r.filter(Boolean)).toHaveLength(20);
    expect(r[20]).toBe(false);
    expect(await magicLinkAllowed(c, { email: 'z@x.com', ip: '3.3.3.3' }, keys)).toBe(true);
  });
});

describe('限流加固（自检阻塞 2）', () => {
  it('IP 为 unknown 时不计 IP 维度：全站不共用一个桶（21 个不同邮箱都能发）', async () => {
    const c = new MemoryRateCounter(() => 0);
    const r = [];
    for (let i = 0; i < 21; i++) r.push(await magicLinkAllowed(c, { email: `u${i}@x.com`, ip: 'unknown' }, keys));
    expect(r.every(Boolean)).toBe(true);
  });
  it('D-010 只读预判：不计数；第 3 封后预判为超额；窗口过后恢复；unknown IP 只看邮箱维度', async () => {
    let t = 0;
    const c = new MemoryRateCounter(() => t);
    const p = { email: 'a@x.com', ip: '1.1.1.1' };
    expect(await magicLinkWouldAllow(c, p, keys)).toBe(true);
    expect(await magicLinkWouldAllow(c, p, keys)).toBe(true); // 预判本身不计数
    for (let i = 0; i < 3; i++) await magicLinkAllowed(c, p, keys);
    expect(await magicLinkWouldAllow(c, p, keys)).toBe(false);
    expect(await magicLinkWouldAllow(c, { email: 'b@x.com', ip: 'unknown' }, keys)).toBe(true);
    t = 600_000;
    expect(await magicLinkWouldAllow(c, p, keys)).toBe(true);
  });

  it('IPv6 按 /64 聚合（换地址不能绕过）；IPv4 原样', () => {
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:0db8:0001:0002:ffff:1:2:3'));
    expect(ipBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
  });
});

const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl)('Redis 实现（真实 Redis）', () => {
  const prefix = `bydp:test:${process.pid}:${Date.now()}:`;
  const redis = redisUrl ? new Redis(redisUrl) : undefined;
  afterAll(async () => {
    if (!redis) return;
    const ks = await redis.keys(`${prefix}*`);
    if (ks.length) await redis.del(...ks);
    await redis.quit();
  });
  it('RedisRateCounter：INCR 与 EXPIRE NX 同一事务——首次即带 TTL，后续计数不重置 TTL', async () => {
    const c = new RedisRateCounter(redis!, prefix);
    expect(await c.peek('k')).toBe(0);
    expect([await c.hit('k', 600), await c.hit('k', 600), await c.hit('k', 600)]).toEqual([1, 2, 3]);
    expect(await c.peek('k')).toBe(3);
    const ttl = await redis!.ttl(`${prefix}k`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('RedisRateCounter.add（D-015 #2 证据字节）：INCRBY 累加且同事务带 TTL；负数 / 非整数增量拒绝', async () => {
    const c = new RedisRateCounter(redis!, prefix);
    expect([await c.add('b', 1000, 86400), await c.add('b', 2500, 86400)]).toEqual([1000, 3500]);
    expect(await c.peek('b')).toBe(3500);
    expect(await redis!.ttl(`${prefix}b`)).toBeGreaterThan(86000);
    await expect(c.add('b', -1, 60)).rejects.toThrow();
    await expect(c.add('b', 1.5, 60)).rejects.toThrow();
  });
  it('RedisOnceStore：同一 key 首次 true、TTL 内再次 false，且带 TTL', async () => {
    const o = new RedisOnceStore(redis!, prefix);
    expect([await o.claim('tg:h', 660), await o.claim('tg:h', 660)]).toEqual([true, false]);
    expect(await redis!.ttl(`${prefix}tg:h`)).toBeGreaterThan(650);
  });
});

describe.skipIf(!url)('登录用例（bydp_app）', () => {
  it('首登建用户 + 身份（只存盲索引与行绑定密文）；再次登录命中同一用户', async () => {
    const r = await inTx(async (tx) => {
      const a = await signInWithIdentity(tx, { provider: 'email', account: 'Ke.Li@Gmail.com', handle: 'ke***@g***.com' }, keys);
      const b = await signInWithIdentity(tx, { provider: 'email', account: ' ke.li@gmail.com', handle: 'ke***@g***.com' }, keys);
      const [idn] = await q<{ id: string; providerAccountId: string; contactEnc: string; handle: string }>(
        tx,
        sql`select "id","providerAccountId","contactEnc","handle" from "identity" where "userId" = ${a.userId}`,
      );
      return { a, b, idn: idn! };
    });
    expect(r.a).toMatchObject({ created: true, sessionEpoch: 0 });
    expect(r.b).toEqual({ userId: r.a.userId, sessionEpoch: 0, created: false });
    expect(r.idn.providerAccountId).toBe(identityBlindIndex('email', 'ke.li@gmail.com', keys.hmacKey));
    expect(r.idn.contactEnc).not.toContain('gmail');
    expect(decryptContact(r.idn.contactEnc, keys.piiKey, r.idn.id)).toBe('ke.li@gmail.com'); // 自检 9：存规范化值
    expect(r.idn.handle).toBe('ke***@g***.com');
  });

  it('TG 与邮箱是不同身份（P1 不自动合并）；findUserByEmail 只按盲索引命中', async () => {
    const r = await inTx(async (tx) => {
      const tg = await signInWithIdentity(tx, { provider: 'telegram', account: '424242', handle: '@am***' }, keys);
      const em = await signInWithIdentity(tx, { provider: 'email', account: 'x@y.z', handle: 'x***@y***.z' }, keys);
      return { tg, em, found: await findUserByEmail(tx, 'X@Y.z', keys), none: await findUserByEmail(tx, 'nobody@y.z', keys) };
    });
    expect(r.tg.userId).not.toBe(r.em.userId);
    expect(r.found).toBe(r.em.userId);
    expect(r.none).toBeNull();
  });

  it('magic link 令牌：一次性（第二次取不到）、过期返回 null 并删除、库里无邮箱明文', async () => {
    const H = 'c'.repeat(64);
    const r = await inTx(async (tx) => {
      await saveVerificationToken(tx, { email: 'a@b.c', tokenHash: H, expires: new Date(Date.now() + 900_000) }, keys);
      const plain = await q<{ n: number }>(tx, sql`select count(*)::int as n from "verification_token" where "identifierHash" like '%@%'`);
      const first = await consumeVerificationToken(tx, { email: 'A@b.c', tokenHash: H }, keys);
      const second = await consumeVerificationToken(tx, { email: 'a@b.c', tokenHash: H }, keys);
      await saveVerificationToken(tx, { email: 'a@b.c', tokenHash: H, expires: new Date(Date.now() - 1000) }, keys);
      const expired = await consumeVerificationToken(tx, { email: 'a@b.c', tokenHash: H }, keys);
      const [left] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "verification_token"`);
      return { plain: plain[0]!.n, first, second, expired, left: left!.n };
    });
    expect(r.plain).toBe(0);
    expect(r.first).not.toBeNull();
    expect(r.second).toBeNull();
    expect(r.expired).toBeNull();
    expect(r.left).toBe(0);
  });

  it('会话纪元（审核增补）：epoch 一致有效；revokeAllSessions 后旧 epoch 失效', async () => {
    const r = await inTx(async (tx) => {
      const u = await signInWithIdentity(tx, { provider: 'telegram', account: '777', handle: 'TG ***77' }, keys);
      const before = await getSessionUser(tx, { userId: u.userId, epoch: 0 });
      const next = await revokeAllSessions(tx, u.userId);
      return { before, next, old: await getSessionUser(tx, { userId: u.userId, epoch: 0 }), fresh: await getSessionUser(tx, { userId: u.userId, epoch: 1 }) };
    });
    expect(r.before).toMatchObject({ displayName: 'TG ***77' });
    expect(r.next).toBe(1);
    expect(r.old).toBeNull();
    expect(r.fresh).not.toBeNull();
    expect(await inTx((tx) => getSessionUser(tx, { userId: 'u_nope', epoch: 0 }))).toBeNull();
  });
});

describe.skipIf(!url)('过期令牌清理（worker）', () => {
  it('只删过期的，未过期保留；返回删除行数', async () => {
    const r = await inTx(async (tx) => {
      await saveVerificationToken(tx, { email: 'a@b.c', tokenHash: 'e'.repeat(64), expires: new Date(Date.now() - 1000) }, keys);
      await saveVerificationToken(tx, { email: 'a@b.c', tokenHash: 'f'.repeat(64), expires: new Date(Date.now() + 900_000) }, keys);
      const n = await purgeExpiredVerificationTokens(tx);
      const [left] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "verification_token"`);
      return { n, left: left!.n };
    });
    expect(r).toEqual({ n: 1, left: 1 });
  });
});

describe.skipIf(!url)('被自我排除拦截的身份（0013 identity_block / §16 登录页提示）', () => {
  it('首登被拦 → IdentityBlockedError；邮箱首登前探测为 true、未拦截身份为 false、老用户为 false；探测不留任何行', async () => {
    const r = await inTx(async (tx) => {
      const blocked = identityBlindIndex('email', 'blocked@example.com', keys.hmacKey);
      await tx.execute(sql`reset role`);
      await tx.execute(sql`insert into "app_user" ("id","displayName") values ('u_blk','x')`);
      await tx.execute(sql`insert into "data_request" ("id","userId","kind") values ('dr_blk','u_blk','anonymize')`);
      await tx.execute(sql`insert into "identity_block" ("id","identityHash","blockedUntil","requestId") values ('ib_t', ${blocked}, now() + interval '30 days', 'dr_blk')`);
      await tx.execute(sql`set local role bydp_app`);
      const probeBlocked = await probeIdentityBlocked(tx, { provider: 'email', account: 'Blocked@Example.com' }, keys);
      const probeFree = await probeIdentityBlocked(tx, { provider: 'email', account: 'free@example.com' }, keys);
      await signInWithIdentity(tx, { provider: 'email', account: 'old@example.com', handle: 'o***@example.com' }, keys);
      const probeExisting = await probeIdentityBlocked(tx, { provider: 'email', account: 'old@example.com' }, keys);
      const err = await signInWithIdentity(tx, { provider: 'email', account: 'blocked@example.com', handle: 'b***@example.com' }, keys).catch((e) => e);
      const [left] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "app_user" where "id" like 'u_probe_%'`);
      return { probeBlocked, probeFree, probeExisting, err, left: left!.n };
    });
    expect([r.probeBlocked, r.probeFree, r.probeExisting]).toEqual([true, false, false]);
    expect(r.err).toBeInstanceOf(IdentityBlockedError);
    expect(r.left).toBe(0);
  });
});
