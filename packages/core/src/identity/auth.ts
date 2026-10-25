/**
 * 登录用例（A-009）：Auth.js 的 adapter / Credentials / 会话校验都只调用本模块。identity 与 verification_token 的写入唯一入口
 * （eslint 拦截其他位置直接写）；identity.userId 只允许经后续的账号合并用例改（写 AuditLog），本模块不改。
 * - 身份查找只用盲索引；联系方式密文 AAD 绑定 identity.id（签核条件 2）。
 * - 会话纪元：JWT 带 epoch，每次请求比对 app_user.sessionEpoch；revokeAllSessions = epoch + 1（审核增补）。
 * - magic link 限流（签核条件 4）：同一邮箱盲索引 10 分钟 ≤ 3 封、同一 IP 1 小时 ≤ 20 封；不论邮箱是否已注册，调用方都返回同样的响应。
 */
import { randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';
import { decryptContact, encryptContact, identityBlindIndex, normalizeEmail, type IdentityProvider } from './pii';

type Exec = Pick<Db, 'execute'>;
export type AuthKeys = { hmacKey: Buffer; piiKey: Buffer };

async function rows<T>(db: Exec, q: ReturnType<typeof sql>) {
  return (await db.execute(q)) as unknown as T[];
}

export type SignedInUser = { userId: string; sessionEpoch: number; created: boolean };

/** 该登录身份被自我排除拦截（permanent 快照 / 0013 identity_block），不能注册新用户（§16「该登录身份处于自我排除期内」） */
export class IdentityBlockedError extends Error {
  constructor() {
    super('该登录身份处于自我排除期内，暂不能注册或登录');
    this.name = 'IdentityBlockedError';
  }
}
const IDENTITY_BLOCK_MSG = /identity: (permanently self-excluded|blocked until self-exclusion ends)/;
const isIdentityBlockDbError = (e: unknown) => {
  for (let x: unknown = e, i = 0; x && i < 3; x = (x as { cause?: unknown }).cause, i++) if (IDENTITY_BLOCK_MSG.test(String((x as Error).message))) return true;
  return false;
};

/**
 * 首登前探测（邮箱登录用，Auth.js 在 createUser 之前调 signIn 回调）：身份是否会被注册拦截。
 * bydp_app 读不到 identity_block，故在事务内试插 app_user + identity 后一律回滚，以触发器结果为准。已有该身份的老用户返回 false。
 */
export async function probeIdentityBlocked(db: Pick<Db, 'transaction'>, p: { provider: IdentityProvider; account: string }, keys: AuthKeys): Promise<boolean> {
  const accountHash = identityBlindIndex(p.provider, p.account, keys.hmacKey);
  const ROLLBACK = new Error('probe-rollback');
  let blocked = false;
  await db
    .transaction(async (tx) => {
      const [hit] = await rows<{ userId: string }>(tx, sql`select "userId" from ${schema.identities} where "provider" = ${p.provider} and "providerAccountId" = ${accountHash}`);
      if (hit) throw ROLLBACK;
      const userId = `u_probe_${randomUUID().replaceAll('-', '')}`;
      await tx.execute(sql`insert into ${schema.users} ("id", "displayName") values (${userId}, 'probe')`);
      try {
        await tx.execute(
          sql`insert into ${schema.identities} ("id", "userId", "provider", "providerAccountId") values (${`idn_probe_${randomUUID().replaceAll('-', '')}`}, ${userId}, ${p.provider}, ${accountHash})`,
        );
      } catch (e) {
        blocked = isIdentityBlockDbError(e);
      }
      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
  return blocked;
}

/**
 * 按身份登录：盲索引命中 → 返回该用户；否则新建 app_user + identity（首登）。
 * account = TG 数字 id / 邮箱原文（只用于算盲索引与加密，不落明文）；contact = 通知用联系方式原文（TG 为 id，邮箱为邮箱）。
 */
export async function signInWithIdentity(
  db: Pick<Db, 'transaction'>,
  p: { provider: IdentityProvider; account: string; handle: string; locale?: string },
  keys: AuthKeys,
): Promise<SignedInUser> {
  const accountHash = identityBlindIndex(p.provider, p.account, keys.hmacKey);
  return db.transaction(async (tx) => {
    // 同一身份并发首登串行化，防止建出两个用户
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`identity:${accountHash}`}, 0))`);
    const [hit] = await rows<{ userId: string; sessionEpoch: number }>(
      tx,
      sql`select i."userId", u."sessionEpoch" from ${schema.identities} i join ${schema.users} u on u."id" = i."userId"
          where i."provider" = ${p.provider} and i."providerAccountId" = ${accountHash}`,
    );
    if (hit) return { userId: hit.userId, sessionEpoch: hit.sessionEpoch, created: false };

    // 自检 9：密文存规范化后的联系方式（与盲索引同一口径），不存回调 URL 里的原样参数
    const contact = p.provider === 'email' ? normalizeEmail(p.account) : p.account.trim();
    const userId = `u_${randomUUID().replaceAll('-', '')}`;
    const identityId = `idn_${randomUUID().replaceAll('-', '')}`;
    await tx.execute(
      sql`insert into ${schema.users} ("id", "displayName", "locale") values (${userId}, ${p.handle}, ${p.locale ?? 'zh-Hans'})`,
    );
    try {
      await tx.execute(
        sql`insert into ${schema.identities} ("id", "userId", "provider", "providerAccountId", "handle", "contactEnc")
            values (${identityId}, ${userId}, ${p.provider}, ${accountHash}, ${p.handle}, ${encryptContact(contact, keys.piiKey, identityId)})`,
      );
    } catch (e) {
      if (isIdentityBlockDbError(e)) throw new IdentityBlockedError();
      throw e;
    }
    return { userId, sessionEpoch: 0, created: true };
  });
}

/** TG 数字 id 对应的站内用户（D-017 Bot：只读，**不建用户**——未登录过站内的 TG 用户须先经 Login Widget 登录） */
export async function findUserByTelegramId(db: Exec, telegramId: string, keys: Pick<AuthKeys, 'hmacKey'>): Promise<{ userId: string } | null> {
  const hash = identityBlindIndex('telegram', telegramId, keys.hmacKey);
  const [r] = await rows<{ userId: string }>(
    db,
    sql`select i."userId" from ${schema.identities} i join ${schema.users} u on u."id" = i."userId"
        where i."provider" = 'telegram' and i."providerAccountId" = ${hash} and u."anonymizedAt" is null`,
  );
  return r ?? null;
}

/** 邮箱是否已有身份（Auth.js getUserByEmail）；只返回 userId，不回显邮箱 */
export async function findUserByEmail(db: Exec, email: string, keys: AuthKeys): Promise<string | null> {
  const [r] = await rows<{ userId: string }>(
    db,
    sql`select "userId" from ${schema.identities} where "provider" = 'email' and "providerAccountId" = ${identityBlindIndex('email', email, keys.hmacKey)}`,
  );
  return r?.userId ?? null;
}

/** magic link 令牌：identifier 存邮箱盲索引；tokenHash 为 Auth.js 已做的 sha256(token + secret) */
export async function saveVerificationToken(db: Exec, p: { email: string; tokenHash: string; expires: Date }, keys: AuthKeys) {
  await db.execute(
    sql`insert into ${schema.verificationTokens} ("identifierHash", "tokenHash", "expires")
        values (${identityBlindIndex('email', p.email, keys.hmacKey)}, ${p.tokenHash}, ${p.expires.toISOString()}::timestamptz)`,
  );
}

/** 取出即删（一次性）；过期令牌同样删除但返回 null */
export async function consumeVerificationToken(db: Exec, p: { email: string; tokenHash: string }, keys: AuthKeys): Promise<{ expires: Date } | null> {
  const [r] = await rows<{ expires: Date | string; valid: boolean }>(
    db,
    sql`delete from ${schema.verificationTokens}
        where "identifierHash" = ${identityBlindIndex('email', p.email, keys.hmacKey)} and "tokenHash" = ${p.tokenHash}
        returning "expires", "expires" > now() as "valid"`,
  );
  return r?.valid ? { expires: new Date(r.expires) } : null;
}

/** 会话校验：用户存在且 epoch 一致才有效（每次请求调用） */
export async function getSessionUser(db: Exec, p: { userId: string; epoch: number }): Promise<{ userId: string; displayName: string } | null> {
  const [r] = await rows<{ displayName: string; sessionEpoch: number }>(
    db,
    sql`select "displayName", "sessionEpoch" from ${schema.users} where "id" = ${p.userId}`,
  );
  return r && r.sessionEpoch === p.epoch ? { userId: p.userId, displayName: r.displayName } : null;
}

/** 只读：用户最早的登录身份（「我的」页展示登录方式与掩码句柄；不返回盲索引与密文） */
/** 本人全部身份（导出包用）：只给登录方式与掩码句柄，不含盲索引与联系方式密文 */
export async function listIdentitiesForExport(db: Exec, userId: string) {
  return rows<{ provider: string; handle: string | null; createdAt: Date }>(
    db,
    sql`select "provider", "handle", "createdAt" from ${schema.identities} where "userId" = ${userId} order by "createdAt", "id"`,
  );
}

export async function getPrimaryIdentity(db: Exec, userId: string): Promise<{ provider: IdentityProvider; handle: string | null } | null> {
  const [r] = await rows<{ provider: IdentityProvider; handle: string | null }>(
    db,
    sql`select "provider", "handle" from ${schema.identities} where "userId" = ${userId} order by "createdAt", "id" limit 1`,
  );
  return r ?? null;
}

/**
 * 通知推送目标：用户最早的、有联系方式的身份，解密联系方式（只在推送时调用；返回值不得落日志）。
 * 密文 AAD 绑定 identity.id，被挪行的密文解密失败 → 视为无联系方式。
 */
export async function getNotifyTarget(db: Exec, userId: string, keys: AuthKeys): Promise<{ provider: IdentityProvider; contact: string } | null> {
  const list = await rows<{ id: string; provider: IdentityProvider; contactEnc: string | null }>(
    db,
    sql`select "id", "provider", "contactEnc" from ${schema.identities} where "userId" = ${userId} and "contactEnc" is not null order by "createdAt", "id"`,
  );
  for (const r of list) {
    try {
      return { provider: r.provider, contact: decryptContact(r.contactEnc!, keys.piiKey, r.id) };
    } catch {
      /* 解密失败（密文被挪行或密钥轮换）：跳过该身份 */
    }
  }
  return null;
}

/** 签发会话时取当前纪元（邮箱登录经 adapter 返回的用户不带 epoch） */
export async function userSessionEpoch(db: Exec, userId: string): Promise<number | null> {
  const [r] = await rows<{ sessionEpoch: number }>(db, sql`select "sessionEpoch" from ${schema.users} where "id" = ${userId}`);
  return r?.sessionEpoch ?? null;
}

/** 作废该用户全部会话（退出所有设备 / 盗号 / 封禁） */
export async function revokeAllSessions(db: Exec, userId: string): Promise<number | null> {
  const [r] = await rows<{ sessionEpoch: number }>(
    db,
    sql`update ${schema.users} set "sessionEpoch" = "sessionEpoch" + 1 where "id" = ${userId} returning "sessionEpoch"`,
  );
  return r?.sessionEpoch ?? null;
}

// ---- magic link 限流（签核条件 4）----
export interface RateCounter {
  /** 计数 +1 并返回窗口内当前计数（窗口从首次计数起算） */
  hit(key: string, windowSec: number): Promise<number>;
  /** 计数 +amount（如证据字节数）并返回窗口内累计值；窗口语义同 hit */
  add(key: string, amount: number, windowSec: number): Promise<number>;
  /** 只读：窗口内当前计数（不计数；窗口外为 0） */
  peek(key: string): Promise<number>;
}

export const MAGIC_LINK_LIMITS = { perEmail: { max: 3, windowSec: 600 }, perIp: { max: 20, windowSec: 3600 } } as const;

/**
 * 两个维度都计数（即使其中一个已超额，也照样计数，防止探测）；任一超额即不发信。
 * IP 为 'unknown'（未在可信反代后）时不计 IP 维度——否则全站共用一个桶，任何人发 21 封即可让所有人收不到登录信（自检阻塞 2）；
 * 部署环境由 web 强制可信反代（BYDP_TRUST_PROXY=1），不会落到 unknown。IPv6 按 /64 聚合。
 */
export async function magicLinkAllowed(counter: RateCounter, p: { email: string; ip: string }, keys: AuthKeys): Promise<boolean> {
  const e = await counter.hit(`ml:e:${identityBlindIndex('email', p.email, keys.hmacKey)}`, MAGIC_LINK_LIMITS.perEmail.windowSec);
  if (p.ip === 'unknown') return e <= MAGIC_LINK_LIMITS.perEmail.max;
  const i = await counter.hit(`ml:ip:${ipBucket(p.ip)}`, MAGIC_LINK_LIMITS.perIp.windowSec);
  return e <= MAGIC_LINK_LIMITS.perEmail.max && i <= MAGIC_LINK_LIMITS.perIp.max;
}

/**
 * 只读预判（D-010 登录页「发送太频繁」提示）：不计数，任一维度已达上限即 false。
 * 真正的计数与拦截仍在 magicLinkAllowed（发信时），直接 POST Auth.js 路由也绕不过。与邮箱是否已注册无关，不泄露账号存在性。
 */
export async function magicLinkWouldAllow(counter: RateCounter, p: { email: string; ip: string }, keys: AuthKeys): Promise<boolean> {
  const e = await counter.peek(`ml:e:${identityBlindIndex('email', p.email, keys.hmacKey)}`);
  if (e >= MAGIC_LINK_LIMITS.perEmail.max) return false;
  if (p.ip === 'unknown') return true;
  return (await counter.peek(`ml:ip:${ipBucket(p.ip)}`)) < MAGIC_LINK_LIMITS.perIp.max;
}

/** IPv4 原样；IPv6 取前 4 组（/64），换地址不能绕过 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const full = ip.includes('::') ? expandV6(ip) : ip.split(':');
  return `${full.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
function expandV6(ip: string) {
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

/** Redis 结构化接口（ioredis 兼容；core 不依赖 ioredis） */
type RedisPipeline = { incr(k: string): RedisPipeline; incrby(k: string, n: number): RedisPipeline; expire(k: string, s: number, mode: 'NX'): RedisPipeline; exec(): Promise<[Error | null, unknown][] | null> };
export type RedisLike = {
  multi(): RedisPipeline;
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ex: 'EX', s: number, nx: 'NX'): Promise<'OK' | null>;
};

/** 固定窗口：同一事务里 INCR + EXPIRE NX（自检阻塞 2：分两步时 EXPIRE 失败会留下永久键）；任一步出错即抛错 */
export class RedisRateCounter implements RateCounter {
  constructor(private redis: RedisLike, private prefix = 'bydp:rl:') {}
  async hit(key: string, windowSec: number) {
    return this.add(key, 1, windowSec);
  }
  async add(key: string, amount: number, windowSec: number) {
    if (!Number.isInteger(amount) || amount < 0) throw new Error('限流计数增量须为非负整数');
    const k = this.prefix + key;
    const res = await this.redis.multi().incrby(k, amount).expire(k, windowSec, 'NX').exec();
    const [incr, exp] = res ?? [];
    if (!incr || incr[0] || !exp || exp[0] || typeof incr[1] !== 'number') throw new Error('限流计数失败');
    return incr[1];
  }
  async peek(key: string) {
    return Number((await this.redis.get(this.prefix + key)) ?? 0);
  }
}

/** 一次性消费（TG 登录数据防重放）：首次 claim 返回 true，TTL 内再次 claim 返回 false */
export interface OnceStore {
  claim(key: string, ttlSec: number): Promise<boolean>;
}
export class RedisOnceStore implements OnceStore {
  constructor(private redis: RedisLike, private prefix = 'bydp:once:') {}
  async claim(key: string, ttlSec: number) {
    return (await this.redis.set(this.prefix + key, '1', 'EX', ttlSec, 'NX')) === 'OK';
  }
}
export class MemoryOnceStore implements OnceStore {
  private m = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  async claim(key: string, ttlSec: number) {
    const t = this.now();
    const until = this.m.get(key);
    if (until && until > t) return false;
    this.m.set(key, t + ttlSec * 1000);
    return true;
  }
}

/** 清理过期的 magic link 令牌（worker 每小时跑） */
export async function purgeExpiredVerificationTokens(db: Exec): Promise<number> {
  const r = await rows<{ n: number }>(db, sql`with d as (delete from ${schema.verificationTokens} where "expires" < now() returning 1) select count(*)::int as n from d`);
  return r[0]?.n ?? 0;
}

/** 进程内计数（测试 / 本地）。部署环境用 RedisRateCounter */
export class MemoryRateCounter implements RateCounter {
  private m = new Map<string, { start: number; n: number }>();
  constructor(private now: () => number = Date.now) {}
  async hit(key: string, windowSec: number) {
    return this.add(key, 1, windowSec);
  }
  async add(key: string, amount: number, windowSec: number) {
    const t = this.now();
    this.windows.set(key, windowSec);
    const e = this.m.get(key);
    if (!e || t - e.start >= windowSec * 1000) {
      this.m.set(key, { start: t, n: amount });
      return amount;
    }
    return (e.n += amount);
  }
  async peek(key: string) {
    const e = this.m.get(key);
    return e && this.now() - e.start < (this.windows.get(key) ?? 0) * 1000 ? e.n : 0;
  }
  private windows = new Map<string, number>();
}

/** 告警通道自检：持 admin 角色且绑定了 TG（有联系方式密文）的账号数；只计数，不解密、不发送 */
export async function countAdminTelegramTargets(db: Exec): Promise<number> {
  const [r] = (await db.execute(
    sql`select count(distinct ur."userId")::int as "n" from ${schema.userRoles} ur join ${schema.identities} i on i."userId" = ur."userId"
        where ur."roleKey" = 'admin' and i."provider" = 'telegram' and i."contactEnc" is not null`,
  )) as unknown as { n: number }[];
  return r?.n ?? 0;
}

/** 邮箱身份解密后按规则筛出 userId（运维用，如 UAT 清理识别 +uat 测试账号；不返回邮箱本身）。解不开的身份跳过 */
export async function findEmailUsers(db: Exec, keys: AuthKeys, match: (email: string) => boolean): Promise<string[]> {
  const list = await rows<{ id: string; userId: string; contactEnc: string }>(
    db,
    sql`select "id", "userId", "contactEnc" from ${schema.identities} where "provider" = 'email' and "contactEnc" is not null`,
  );
  const out = new Set<string>();
  for (const r of list) {
    try {
      if (match(decryptContact(r.contactEnc, keys.piiKey, r.id))) out.add(r.userId);
    } catch {
      /* 已注销清空 / 密钥轮换前的身份：跳过 */
    }
  }
  return [...out];
}
