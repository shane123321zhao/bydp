/** Auth.js 胶水（A-009）：依赖注入，事务内以 bydp_app 执行后回滚；发信用假发送函数，不发真实邮件 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryOnceStore, MemoryRateCounter, revokeAllSessions } from '../src/identity/auth';
import { createAuthHandlers } from '../src/identity/authjs';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());

const BOT = '123456:TEST-bot-token';
const NOW = 1_790_000_000;
const keys = { hmacKey: randomBytes(32), piiKey: randomBytes(32) };
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

function tgSigned(fields: Record<string, string | number>) {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  return { ...fields, hash: createHmac('sha256', createHash('sha256').update(BOT).digest()).update(dcs).digest('hex') };
}

async function withHandlers<T>(fn: (h: ReturnType<typeof createAuthHandlers>, tx: Tx, sent: { to: string; subject: string; text: string }[], logs: Record<string, unknown>[]) => Promise<T>) {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local role bydp_app`);
      const sent: { to: string; subject: string; text: string }[] = [];
      const logs: Record<string, unknown>[] = [];
      const counter = new MemoryRateCounter(() => 0);
      const once = new MemoryOnceStore(() => NOW * 1000);
      const h = createAuthHandlers({
        db: () => tx as never,
        keys: () => keys,
        botToken: () => BOT,
        counter: () => counter,
        once: () => once,
        expectedOrigin: () => 'https://northx.vip',
        send: () => async (m) => void sent.push(m),
        emailFrom: () => 'BYDP <no-reply@mail.northx.vip>',
        clientIp: (req) => req?.headers.get('x-test-ip') ?? 'unknown',
        log: (e) => void logs.push(e),
        nowSec: () => NOW,
      });
      out = await fn(h, tx, sent, logs);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

describe.skipIf(!url)('Auth.js 胶水（A-009）', () => {
  it('TG 登录：表单字段（csrfToken / callbackUrl）剔除后校验；同一 TG id 以新签名再登命中同一用户；篡改 → null 并记日志', async () => {
    const r = await withHandlers(async (h, _tx, _sent, logs) => {
      const a = await h.authorizeTelegram({ ...tgSigned({ id: 424242, username: 'am_test', auth_date: NOW - 5 }), csrfToken: 'x', callbackUrl: '/me' });
      const b = await h.authorizeTelegram(tgSigned({ id: 424242, username: 'am_test', auth_date: NOW - 3 }));
      const bad = await h.authorizeTelegram({ ...tgSigned({ id: 424242, auth_date: NOW - 1 }), id: '1' });
      return { a, b, bad, logs };
    });
    expect(r.a).toMatchObject({ epoch: 0 });
    expect(r.b!.id).toBe(r.a!.id);
    expect(r.bad).toBeNull();
    expect(r.logs).toEqual([{ evt: 'telegram_login_rejected', reason: 'bad_hash' }]);
  });

  it('自检 5：同一份 TG 签名数据只能换一次会话（10 分钟内重放 → null，记 replayed）；TG 新增的签名字段仍参与校验', async () => {
    const r = await withHandlers(async (h, _tx, _sent, logs) => {
      const data = tgSigned({ id: 5150, auth_date: NOW - 5, future_field: 'x' });
      return { first: await h.authorizeTelegram(data), replay: await h.authorizeTelegram({ ...data }), logs };
    });
    expect(r.first).not.toBeNull();
    expect(r.replay).toBeNull();
    expect(r.logs).toEqual([{ evt: 'telegram_login_rejected', reason: 'replayed' }]);
  });

  it('自检阻塞 1：magic link 链接来源不是 AUTH_URL → 拒发（抛错、不发信）；伪造 Host 生成的链接投不出去', async () => {
    const r = await withHandlers(async (h, _tx, sent, logs) => {
      const err = await h
        .sendVerificationRequest({ identifier: 'v@x.com', url: 'https://evil.example/api/auth/callback/resend?token=t' })
        .catch((e: Error) => e.message);
      return { err, sent: sent.length, logs };
    });
    expect(r.err).toMatch(/来源不符/);
    expect(r.sent).toBe(0);
    expect(r.logs).toEqual([{ evt: 'magic_link_origin_rejected' }]);
  });

  it('magic link：同一邮箱第 4 封静默不发（不抛错，对外响应一致）；日志不含邮箱', async () => {
    const r = await withHandlers(async (h, _tx, sent, logs) => {
      const req = new Request('https://northx.vip/api/auth/signin/resend', { headers: { 'x-test-ip': '203.0.113.1' } });
      for (let i = 0; i < 4; i++) await h.sendVerificationRequest({ identifier: 'ke.li@gmail.com', url: `https://northx.vip/api/auth/callback/resend?token=t${i}`, request: req });
      return { sent, logs };
    });
    expect(r.sent).toHaveLength(3);
    expect(r.sent[0]).toMatchObject({ to: 'ke.li@gmail.com' });
    expect(r.sent[0]!.text).toContain('不向中国大陆居民提供服务');
    expect(r.logs).toEqual([{ evt: 'magic_link_rate_limited' }]);
    expect(JSON.stringify(r.logs)).not.toContain('ke.li');
  });

  it('adapter 邮箱流程：令牌一次性；首登 createUser → getUserByEmail 命中同一用户（大小写不同亦然）', async () => {
    const H = 'd'.repeat(64);
    const r = await withHandlers(async (h) => {
      await h.adapter.createVerificationToken({ identifier: 'Ke.Li@gmail.com', token: H, expires: new Date(Date.now() + 900_000) });
      const used = await h.adapter.useVerificationToken({ identifier: 'ke.li@gmail.com', token: H });
      const again = await h.adapter.useVerificationToken({ identifier: 'ke.li@gmail.com', token: H });
      const none = await h.adapter.getUserByEmail('ke.li@gmail.com');
      const created = await h.adapter.createUser({ email: 'ke.li@gmail.com' });
      const found = await h.adapter.getUserByEmail('KE.LI@gmail.com');
      return { used, again, none, created, found };
    });
    expect(r.used).toMatchObject({ identifier: 'ke.li@gmail.com', token: H });
    expect(r.again).toBeNull();
    expect(r.none).toBeNull();
    expect(r.found!.id).toBe(r.created.id);
  });

  it('jwt 回调：签发写 uid / epoch（邮箱用户无 epoch 时查库补）；每次比对纪元，作废后返回 null', async () => {
    const r = await withHandlers(async (h, tx) => {
      const tg = await h.authorizeTelegram(tgSigned({ id: 99, auth_date: NOW }));
      const issued = await h.jwtCallback({ token: { email: 'leak@x.com', picture: 'p' }, user: tg });
      const next = await h.jwtCallback({ token: { ...issued } });
      const em = await h.adapter.createUser({ email: 'a@b.c' });
      const emailToken = await h.jwtCallback({ token: {}, user: { id: em.id } });
      await revokeAllSessions(tx as never, tg!.id);
      const revoked = await h.jwtCallback({ token: { ...issued } });
      const forged = await h.jwtCallback({ token: { uid: tg!.id } });
      const expiredAbs = await h.jwtCallback({ token: { ...next, authTime: NOW - 31 * 24 * 3600 } });
      return { issued, next, emailToken, revoked, forged, expiredAbs };
    });
    expect(r.issued).toMatchObject({ epoch: 0, name: 'TG ***99', authTime: NOW });
    expect(r.issued).not.toHaveProperty('email'); // 自检 10：会话不留邮箱 / 头像
    expect(r.issued).not.toHaveProperty('picture');
    expect(r.expiredAbs).toBeNull(); // 自检 4：30 天绝对上限
    expect(r.next).toMatchObject({ uid: r.issued!.uid, epoch: 0 });
    expect(r.emailToken).toMatchObject({ epoch: 0, name: 'a***@b***.c' });
    expect(r.revoked).toBeNull();
    expect(r.forged).toBeNull();
  });

  it('未配置 bot token → TG 登录一律 null', async () => {
    const h = createAuthHandlers({
      db: () => conn!.db,
      keys: () => keys,
      botToken: () => undefined,
      counter: () => new MemoryRateCounter(),
      once: () => new MemoryOnceStore(),
      expectedOrigin: () => null,
      send: () => async () => {},
      emailFrom: () => 'x@y.z',
      clientIp: () => 'unknown',
    });
    expect(await h.authorizeTelegram(tgSigned({ id: 1, auth_date: NOW }))).toBeNull();
  });
});
