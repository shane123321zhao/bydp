/**
 * D-034：后台账号密码登录（测试站开关，缺省关闭；PO 10-25 · 审核 W2#042）。
 * - 只开给一个账号：允许的邮箱与密码哈希都在服务器 .env.prod（ADMIN_PASSWORD_LOGIN=on · ADMIN_PASSWORD_EMAIL · ADMIN_PASSWORD_HASH），不新增表、不改迁移；
 *   其他任何邮箱一律拒绝。BYDP_ENV=production 时即使设为 on 也不启用（go-live-check 另查）。
 * - 哈希：scrypt（N = 2^15、r = 8、p = 1、64 字节、16 字节随机盐），格式 `scrypt:32768:8:1:<盐 base64>:<哈希 base64>`；比较用 timingSafeEqual。
 *   分隔符用「:」而不用「$」：.env.prod 会被 bash source 与 compose 插值，「$」会被展开。
 * - 防暴力：每 IP 每分钟 ≤ 5 次；该账号 1 小时内失败 ≥ 20 次即锁 15 分钟；计数器故障即拒绝（失败即关）。
 * - 成功与失败都写 audit_log（不记录密码）；成功后由 Auth.js jwt 回调签发与其他登录方式相同的会话（uid / epoch / authTime）。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';
import type { RateCounter } from './auth';
import { normalizeEmail } from './pii';

const N = 32768, R = 8, P = 1, KEYLEN = 64;
const SCRYPT = { N, r: R, p: P, maxmem: 128 * N * R * 2 };
const IP_PER_MINUTE = 5;
const FAILS_PER_HOUR = 20;
const LOCK_SEC = 15 * 60;

export type PasswordLoginConfig = { email: string; hash: string };

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const h = scryptSync(password, salt, KEYLEN, SCRYPT);
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${h.toString('base64')}`;
}

const HASH_FORMAT = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9+/=]{16,}):([A-Za-z0-9+/=]{80,})$/;

export function verifyPassword(password: string, stored: string): boolean {
  const m = HASH_FORMAT.exec(stored);
  if (!m) return false;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const expected = Buffer.from(m[5]!, 'base64');
  const got = scryptSync(password, Buffer.from(m[4]!, 'base64'), expected.length, { N: n, r, p, maxmem: 128 * n * r * 2 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** 只有 ADMIN_PASSWORD_LOGIN=on、非正式环境、邮箱与哈希都合规时才返回配置；否则 null（入口与 Credentials 均不可用） */
export function passwordLoginConfigFromEnv(env: Record<string, string | undefined> = process.env): PasswordLoginConfig | null {
  if (env.BYDP_ENV === 'production') return null;
  if (env.ADMIN_PASSWORD_LOGIN !== 'on') return null;
  const email = env.ADMIN_PASSWORD_EMAIL?.trim() ? normalizeEmail(env.ADMIN_PASSWORD_EMAIL.trim()) : '';
  const hash = env.ADMIN_PASSWORD_HASH?.trim() ?? '';
  if (!email || !HASH_FORMAT.test(hash)) return null;
  return { email, hash };
}

export type PasswordLoginEvent = { ok: boolean; reason: 'success' | 'disabled' | 'rate_limited' | 'locked' | 'not_allowed' | 'bad_password' | 'no_account' | 'counter_unavailable'; userId?: string; ip: string };

export type PasswordLoginDeps = {
  config: PasswordLoginConfig | null;
  counter: RateCounter;
  findUserId: (email: string) => Promise<string | null>;
  epochOf: (userId: string) => Promise<number | null>;
  audit: (e: PasswordLoginEvent) => Promise<void>;
};

/** 用于假比较的固定哈希：非白名单邮箱也做一次同等耗时的校验，避免以响应时间区分「邮箱不在白名单」 */
const DUMMY = hashPassword('bydp-dummy-password', Buffer.alloc(16, 7));
const lockKey = (email: string) => `pwlogin:lock:${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
const failKey = (email: string) => `pwlogin:fail:${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;

export async function authorizePasswordLogin(d: PasswordLoginDeps, input: { email: unknown; password: unknown; ip: string }): Promise<{ id: string; epoch: number } | null> {
  const ip = input.ip;
  const fail = async (reason: PasswordLoginEvent['reason'], userId?: string) => {
    await d.audit({ ok: false, reason, userId, ip }).catch(() => {});
    return null;
  };
  if (!d.config) return fail('disabled');
  const email = typeof input.email === 'string' && input.email.trim() ? normalizeEmail(input.email.trim()) : '';
  const password = typeof input.password === 'string' ? input.password : '';
  try {
    if ((await d.counter.hit(`pwlogin:ip:${ip}`, 60)) > IP_PER_MINUTE) return fail('rate_limited');
    if ((await d.counter.peek(lockKey(d.config.email))) > 0) return fail('locked');
  } catch {
    return fail('counter_unavailable');
  }
  if (email !== d.config.email || !password || password.length > 256) {
    verifyPassword(password.slice(0, 256), DUMMY);
    return fail('not_allowed');
  }
  if (!verifyPassword(password, d.config.hash)) {
    try {
      if ((await d.counter.hit(failKey(email), 3600)) >= FAILS_PER_HOUR) await d.counter.hit(lockKey(email), LOCK_SEC);
    } catch {
      /* 计数失败不影响本次拒绝 */
    }
    return fail('bad_password');
  }
  const userId = await d.findUserId(email);
  if (!userId) return fail('no_account');
  const epoch = await d.epochOf(userId);
  if (epoch == null) return fail('no_account', userId);
  await d.audit({ ok: true, reason: 'success', userId, ip });
  return { id: userId, epoch };
}

/** audit_log 写入（只追加）：不记录密码与邮箱；actorId 成功为本人，失败为 anonymous */
export async function auditPasswordLogin(db: Pick<Db, 'execute'>, e: PasswordLoginEvent) {
  await db.execute(
    sql`insert into ${schema.auditLogs} ("actorId", "actorRole", "action", "targetType", "targetId", "before", "after", "ip")
        values (${e.ok && e.userId ? e.userId : 'anonymous'}, null, ${e.ok ? 'admin_password_login_success' : 'admin_password_login_failed'}, 'auth', ${e.userId ?? null}, null,
                ${JSON.stringify({ reason: e.reason })}::jsonb, ${e.ip === 'unknown' ? null : e.ip})`,
  );
}
