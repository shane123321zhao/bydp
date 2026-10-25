/** 领码 / postback 端点（D-007 + R2）。app 跑在事务里（结束回滚），被测代码以 bydp_app 执行；fixtures 以表 owner 写。 */
import { createHmac } from 'node:crypto';
import { ClaimResponse } from '@bydp/core/commerce';
import { revokeAllSessions } from '@bydp/core/identity/auth';
import { connect, type CoreDb } from '@bydp/core/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../src/app';
import type { PostbackLog } from '../src/routes/postback';
import { encode } from '@auth/core/jwt';
import { ADMIN_SESSION_COOKIE, adminSessionFromEnv, authJsBearerSession, devHeaderSession, noSession, sessionFromEnv } from '../src/session';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());

const SECRET = 'p'.repeat(40);
const ENV = { POSTBACK_SECRET_WINNER: SECRET };
/** 与 packages/db/src/seed/build.ts SEED_BINDING_HMAC_KEY 相同（仅测试） */
process.env.BINDING_HMAC_KEY ??= 'bydp-seed-only-test-key-not-for-production-0001';

async function withApp<T>(opts: AppOptions, fn: (app: ReturnType<typeof createApp>, tx: CoreDb) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(`insert into "operator_integration" ("id","brandId","postbackSecretRef") values ('oi_w','br_winner','POSTBACK_SECRET_WINNER')`);
      await tx.execute(`insert into "operator_integration" ("id","brandId","postbackSecretRef") values ('oi_r','br_royal','POSTBACK_SECRET_ROYAL')`);
      // A-018：黑名单品牌下的 Offer 只能为 offline（触发器）
      await tx.execute(`insert into "offer" ("id","brandId","title","type","terms","trueValue","status") values ('of_bl','br_caishen','x','deposit','{}','{}','offline')`);
      await tx.execute(`set local role bydp_app`);
      out = await fn(createApp(tx as unknown as CoreDb, opts), tx as unknown as CoreDb);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

const claim = (app: ReturnType<typeof createApp>, id: string, user?: string) =>
  app.request(`/v1/offers/${id}/claim`, { method: 'POST', headers: { ...(user ? { 'X-Dev-User': user } : {}), 'CF-IPCountry': 'MY' } });

function signed(body: object | string, secret = SECRET) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST',
    body: raw,
    headers: { 'Content-Type': 'application/json', 'X-BYDP-Timestamp': ts, 'X-BYDP-Signature': createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex'), 'CF-Connecting-IP': '203.0.113.9' },
  };
}
const EVENT = { externalEventId: 'api-1', event: 'register', operatorAccountId: 'WS-API-1' };

describe('本地会话（Auth.js 接入前）', () => {
  it('默认关闭；只在明确的开发 / 测试环境可开启（白名单）：NODE_ENV 未设 / production 均拒绝启动', () => {
    expect(sessionFromEnv({})).toBe(noSession);
    expect(sessionFromEnv({ NODE_ENV: 'production' })).toBe(noSession);
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'Production' }, { BYDP_ENV: 'prod' }])
      expect(() => sessionFromEnv({ BYDP_DEV_SESSION: '1', ...env }), JSON.stringify(env)).toThrow(/开发环境/);
    expect(sessionFromEnv({ BYDP_DEV_SESSION: '1', NODE_ENV: 'test' })).toBe(devHeaderSession);
    expect(sessionFromEnv({ BYDP_DEV_SESSION: '1', BYDP_ENV: 'local' })).toBe(devHeaderSession);
  });
});

describe.skipIf(!url)('POST /v1/offers/{id}/claim', () => {
  it('未登录 → 401；默认 app 无会话（生产未接 Auth.js 前一律 401）', async () => {
    const r = await withApp({}, async (app) => [await claim(app, 'of_001', 'u_102'), await claim(app, 'of_001')].map((x) => x.status));
    expect(r).toEqual([401, 401]);
    const bad = await withApp({ resolveUser: devHeaderSession }, async (app) => [await claim(app, 'of_001', 'admin'), await claim(app, 'of_001', "u_1' or 1=1")].map((x) => x.status));
    expect(bad).toEqual([401, 401]); // X-Dev-User 只接受 u_ 前缀的安全字符
  });

  it('本地会话 → 200 契约形状；24h 内重复领码同一 clickId；非认证品牌带风险标签', async () => {
    const r = await withApp({ resolveUser: devHeaderSession }, async (app) => {
      const a = ClaimResponse.parse(await (await claim(app, 'of_001', 'u_102')).json());
      const b = ClaimResponse.parse(await (await claim(app, 'of_001', 'u_102')).json());
      const crown = ClaimResponse.parse(await (await claim(app, 'of_002', 'u_102')).json());
      return { a, b, crown };
    });
    expect(r.a).toMatchObject({ code: 'BYDP-JL500', trackingUrl: null });
    expect(r.b.clickId).toBe(r.a.clickId);
    expect(r.crown.riskLabel).toBeTruthy();
  });

  it('不存在 → 404；黑名单品牌 → 409', async () => {
    const r = await withApp({ resolveUser: devHeaderSession }, async (app) => [
      { s: (await claim(app, 'of_nope', 'u_102')).status },
      { s: (await claim(app, 'of_bl', 'u_102')).status, body: await (await claim(app, 'of_bl', 'u_102')).json() },
    ]);
    expect(r).toEqual([{ s: 404 }, { s: 409, body: { code: 'blacklist', message: '该平台在黑名单中，不可领取' } }]);
  });

  it('自我排除期内：领码 → 409 self_excluded；添加绑定 → 409 self_excluded（契约 Error 体）', async () => {
    const r = await withApp({ resolveUser: devHeaderSession }, async (app, tx) => {
      await tx.execute(`insert into "self_exclusion" ("id","userId","period") values ('se_api','u_102','30')`);
      const c = await claim(app, 'of_001', 'u_102');
      const b = await app.request('/v1/me/bindings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Dev-User': 'u_102' },
        body: JSON.stringify({ brandId: 'br_royal', operatorAccountId: 'RA-SE-API-1' }),
      });
      return [c.status, await c.json(), b.status, await b.json()];
    });
    const body = { code: 'self_excluded', message: '自我排除期内，不可领码或添加绑定' };
    expect(r).toEqual([409, body, 409, body]);
  });

  it('领码进入公开 OpenAPI 文档；postback 不进（契约另行定义）', async () => {
    const r = await withApp({}, async (app) => (await (await app.request('/v1/openapi.json')).json()) as { paths: Record<string, unknown>; components: { securitySchemes?: Record<string, unknown> } });
    expect(Object.keys(r.paths)).toContain('/offers/{id}/claim');
    expect(Object.keys(r.paths).some((p) => p.includes('postback'))).toBe(false);
    expect(r.components.securitySchemes).toHaveProperty('bearer');
  });
});

describe.skipIf(!url)('Auth.js Bearer 会话（A-009 签核条件 1 + 会话纪元）', () => {
  const SECRET_A = 's'.repeat(44);
  const mint = (claims: Record<string, unknown>, secret = SECRET_A, salt = 'authjs.session-token') => encode({ token: claims, secret, salt });

  it('有 AUTH_SECRET 时 sessionFromEnv 用 Bearer 解码；无则 noSession', () => {
    expect(sessionFromEnv({})).toBe(noSession);
    expect(sessionFromEnv({ AUTH_SECRET: SECRET_A })).not.toBe(noSession);
    expect(() => authJsBearerSession('short')).toThrow(/AUTH_SECRET/);
  });

  it('D-020 #3 后台独立子域：/admin/v1 只认后台 cookie salt（主站会话无效）；公开 /v1 不认后台 salt；未配 ADMIN_HOST 时沿用主站会话', async () => {
    const now = Math.floor(Date.now() / 1000);
    const web = await mint({ uid: 'u_509', epoch: 0, authTime: now });
    const adm = await mint({ uid: 'u_509', epoch: 0, authTime: now }, SECRET_A, ADMIN_SESSION_COOKIE);
    const env = { AUTH_SECRET: SECRET_A, ADMIN_HOST: 'admin.example.test' };
    const r = await withApp({ resolveUser: sessionFromEnv(env), resolveAdminUser: adminSessionFromEnv(env) }, async (app, tx) => {
      const t = tx as unknown as { execute: (q: string) => Promise<unknown> };
      await t.execute('reset role');
      await t.execute(`insert into "role" ("key","name") values ('admin','管理员') on conflict do nothing`);
      await t.execute(`insert into "user_role" ("userId","roleKey") values ('u_509','admin') on conflict do nothing`);
      await t.execute('set local role bydp_app');
      const get = async (p: string, t: string) => (await app.request(p, { headers: { Authorization: `Bearer ${t}` } })).status;
      return { adminWithWeb: await get('/admin/v1/session', web), adminWithAdmin: await get('/admin/v1/session', adm), meWithAdmin: await get('/v1/me', adm), meWithWeb: await get('/v1/me', web) };
    });
    expect(r).toEqual({ adminWithWeb: 401, adminWithAdmin: 200, meWithAdmin: 401, meWithWeb: 200 });
    expect(adminSessionFromEnv({ AUTH_SECRET: SECRET_A })).not.toBe(noSession);
  });

  it('D-014 注销二次验证（Bearer 通道）：token 签发超过 10 分钟 → 401 reauth_required；无 authTime → 401；10 分钟内 → 202；导出不受限', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await mint({ uid: 'u_102', epoch: 0, authTime: now - 11 * 60 });
    const none = await mint({ uid: 'u_102', epoch: 0 });
    const fresh = await mint({ uid: 'u_102', epoch: 0, authTime: now - 60 });
    const r = await withApp({ resolveUser: authJsBearerSession(SECRET_A) }, async (app) => {
      const post = async (t: string, kind: string) => {
        const res = await app.request('/v1/me/data-requests', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
        return res.status === 202 ? 202 : [res.status, await res.json()];
      };
      return [await post(stale, 'anonymize'), await post(none, 'anonymize'), await post(stale, 'export'), await post(fresh, 'anonymize')];
    });
    expect(r).toEqual([[401, { error: 'reauth_required' }], [401, { error: 'reauth_required' }], 202, 202]);
  });

  it('合法 Bearer → 200；同一 token 放 Cookie（无 Authorization）→ 401：api 不读 cookie，跨站请求无从借用会话', async () => {
    const token = await mint({ uid: 'u_102', epoch: 0 });
    const secure = await mint({ uid: 'u_102', epoch: 0 }, SECRET_A, '__Secure-authjs.session-token');
    const r = await withApp({ resolveUser: authJsBearerSession(SECRET_A) }, async (app) => {
      const post = (headers: Record<string, string>) => app.request('/v1/offers/of_001/claim', { method: 'POST', headers });
      return [
        (await post({ Authorization: `Bearer ${token}` })).status,
        (await post({ Authorization: `Bearer ${secure}` })).status,
        (await post({ Cookie: `authjs.session-token=${token}`, Origin: 'https://evil.example' })).status,
      ];
    });
    expect(r).toEqual([200, 200, 401]);
  });

  it('会话纪元（审核增补）：作废（epoch + 1）后旧 token → 401；新 epoch 的 token 可用', async () => {
    const r = await withApp({ resolveUser: authJsBearerSession(SECRET_A) }, async (app, tx) => {
      const post = async (t: string) => (await app.request('/v1/offers/of_001/claim', { method: 'POST', headers: { Authorization: `Bearer ${t}` } })).status;
      const old = await mint({ uid: 'u_102', epoch: 0 });
      const before = await post(old);
      expect(await revokeAllSessions(tx, 'u_102')).toBe(1);
      return [before, await post(old), await post(await mint({ uid: 'u_102', epoch: 1 }))];
    });
    expect(r).toEqual([200, 401, 200]);
  });

  it('篡改 / 错密钥 / 缺 claims / 用户不存在 / 已过期 → 401', async () => {
    const good = await mint({ uid: 'u_102', epoch: 0 });
    const cases = [
      `${good.slice(0, -4)}AAAA`,
      await mint({ uid: 'u_102', epoch: 0 }, 'x'.repeat(44)),
      await mint({ uid: 'u_102' }),
      await mint({ uid: 'u_nope', epoch: 0 }),
      'not-a-jwt-token-but-long-enough',
      await encode({ token: { uid: 'u_102', epoch: 0 }, secret: SECRET_A, salt: 'authjs.session-token', maxAge: -60 }), // 已过期
    ];
    const r = await withApp({ resolveUser: authJsBearerSession(SECRET_A) }, async (app) => {
      const out: number[] = [];
      for (const t of cases) out.push((await app.request('/v1/offers/of_001/claim', { method: 'POST', headers: { Authorization: `Bearer ${t}` } })).status);
      return out;
    });
    expect(r).toEqual([401, 401, 401, 401, 401, 401]);
  });
});

describe.skipIf(!url)('POST /v1/postback/{brandId}', () => {
  it('签名通过 → 200 recorded；重复 → 200 duplicate', async () => {
    const r = await withApp({ postback: { env: ENV } }, async (app) => [
      await (await app.request('/v1/postback/br_winner', signed(EVENT))).json(),
      await (await app.request('/v1/postback/br_winner', signed(EVENT))).json(),
    ]);
    expect(r).toEqual([{ ok: true, conversion: 'recorded' }, { ok: true, conversion: 'duplicate' }]);
  });

  it('R2 日志：验签失败 → 401 并记结构化日志（原因、IP、正文哈希），不含正文 / 签名 / 密钥', async () => {
    const logs: PostbackLog[] = [];
    const res = await withApp({ postback: { env: ENV, trustProxy: true, log: (e) => logs.push(e) } }, async (app) => {
      const x = await app.request('/v1/postback/br_winner', signed(EVENT, 'q'.repeat(40)));
      return { status: x.status, body: await x.json() };
    });
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } }); // D-008 #5：对外统一
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ evt: 'postback_rejected', level: 'warn', brandId: 'br_winner', status: 401, reason: 'bad_signature', ip: '203.0.113.9' });
    const s = JSON.stringify(logs);
    expect(s).not.toContain('WS-API-1');
    expect(s).not.toContain(SECRET);
  });

  it('R2 体积：> 64KB → 413', async () => {
    const big = JSON.stringify({ ...EVENT, pad: 'x'.repeat(64 * 1024) });
    const s = await withApp({ postback: { env: ENV, log: () => {} } }, async (app) => (await app.request('/v1/postback/br_winner', signed(big))).status);
    expect(s).toBe(413);
  });

  it('R2 限流只计失败：同 (brandId, IP) 失败超额 → 429（含随后的正确签名）；正确签名的请求不消耗配额；他 IP 不受影响', async () => {
    const r = await withApp({ postback: { env: ENV, trustProxy: true, rateLimit: { max: 2, windowMs: 60_000 }, log: () => {} } }, async (app) => {
      const from = (ip: string, init: ReturnType<typeof signed>) => app.request('/v1/postback/br_winner', { ...init, headers: { ...init.headers, 'CF-Connecting-IP': ip } });
      const out: number[] = [];
      for (let i = 0; i < 4; i++) out.push((await from('198.51.100.7', signed({ ...EVENT, externalEventId: `ok-${i}` }))).status);
      for (let i = 0; i < 2; i++) out.push((await from('203.0.113.66', signed({ ...EVENT, externalEventId: `bad-${i}` }, 'q'.repeat(40)))).status);
      out.push((await from('203.0.113.66', signed({ ...EVENT, externalEventId: 'after' }))).status);
      out.push((await from('198.51.100.8', signed({ ...EVENT, externalEventId: 'other' }))).status);
      return out;
    });
    expect(r).toEqual([200, 200, 200, 200, 401, 401, 429, 200]);
  });

  it('审核 D-015 #2：限流计数器（Redis）故障 → 放行（fail-open）并记 alert，正确签名的转化照常 200、失败请求仍 401', async () => {
    const logs: PostbackLog[] = [];
    const broken = {
      hit: async () => Promise.reject(new Error('ECONNREFUSED')),
      add: async () => Promise.reject(new Error('ECONNREFUSED')),
      peek: async () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const r = await withApp({ postback: { env: ENV, counter: broken, log: (e) => logs.push(e) } }, async (app) => [
      (await app.request('/v1/postback/br_winner', signed({ ...EVENT, externalEventId: 'fo-ok' }))).status,
      (await app.request('/v1/postback/br_winner', signed({ ...EVENT, externalEventId: 'fo-bad' }, 'q'.repeat(40)))).status,
    ]);
    expect(r).toEqual([200, 401]);
    expect(logs.some((e) => e.level === 'alert' && e.evt === 'postback_rejected' && e.reason.startsWith('rate_counter_unavailable_fail_open'))).toBe(true);
  });

  it('默认不信任代理头：伪造 CF-Connecting-IP 不改变限流键（无 socket 时记为 unknown）', async () => {
    const logs: PostbackLog[] = [];
    await withApp({ postback: { env: ENV, log: (e) => logs.push(e) } }, async (app) => app.request('/v1/postback/br_winner', signed(EVENT, 'q'.repeat(40))));
    expect(logs[0]!.ip).toBe('unknown');
    const viaSocket: PostbackLog[] = [];
    await withApp({ postback: { env: ENV, remoteAddr: () => '192.0.2.10', log: (e) => viaSocket.push(e) } }, async (app) => app.request('/v1/postback/br_winner', signed(EVENT, 'q'.repeat(40))));
    expect(viaSocket[0]!.ip).toBe('192.0.2.10');
  });

  it('R2 体积：带 Content-Length 的超限请求同样 413；恰好 64KB 放行', async () => {
    const r = await withApp({ postback: { env: ENV, log: () => {} } }, async (app) => {
      const over = signed(JSON.stringify({ ...EVENT, pad: 'x'.repeat(70_000) }));
      const a = (await app.request('/v1/postback/br_winner', { ...over, headers: { ...over.headers, 'Content-Length': String(Buffer.byteLength(over.body)) } })).status;
      const base = JSON.stringify({ ...EVENT, externalEventId: 'exact', pad: '' });
      const exact = signed(JSON.stringify({ ...EVENT, externalEventId: 'exact', pad: 'x'.repeat(64 * 1024 - Buffer.byteLength(base)) }));
      expect(Buffer.byteLength(exact.body)).toBe(64 * 1024);
      const b = (await app.request('/v1/postback/br_winner', exact)).status;
      return [a, b];
    });
    expect(r).toEqual([413, 200]);
  });

  it('异常 → 500 internal 且记日志（不透露细节）', async () => {
    const logs: PostbackLog[] = [];
    const key = process.env.BINDING_HMAC_KEY;
    delete process.env.BINDING_HMAC_KEY;
    try {
      const r = await withApp({ postback: { env: ENV, log: (e) => logs.push(e) } }, async (app) => {
        const x = await app.request('/v1/postback/br_winner', signed(EVENT));
        return [x.status, await x.json()];
      });
      expect(r).toEqual([500, { error: 'internal' }]);
      expect(logs[0]).toMatchObject({ status: 500, reason: 'internal_error' });
    } finally {
      process.env.BINDING_HMAC_KEY = key;
    }
  });

  it('D-008 #5：未对接 / 密钥缺失 / 非法 brandId 对外一律 401 unauthorized；日志保留真实原因，密钥缺失记 alert', async () => {
    const logs: PostbackLog[] = [];
    const r = await withApp({ postback: { env: ENV, log: (e) => logs.push(e) } }, async (app) =>
      Promise.all(
        ['/v1/postback/br_jinlong', '/v1/postback/br_royal', '/v1/postback/..%2Fx'].map(async (p) => {
          const x = await app.request(p, signed(EVENT));
          return [x.status, await x.json()];
        }),
      ),
    );
    expect(r).toEqual([
      [401, { error: 'unauthorized' }],
      [401, { error: 'unauthorized' }],
      [401, { error: 'unauthorized' }],
    ]);
    const byReason = Object.fromEntries(logs.map((l) => [l.evt === 'postback_rejected' ? l.reason : l.evt, l.level]));
    expect(byReason).toEqual({ no_integration: 'warn', secret_missing: 'alert', bad_brand_id: 'warn' });
  });

  it('D-008 #1：来自屏蔽地区（CN）的回传豁免 451 并先记日志；其余路径仍 451', async () => {
    const logs: PostbackLog[] = [];
    const r = await withApp({ resolveUser: devHeaderSession, postback: { env: ENV, log: (e) => logs.push(e) } }, async (app) => {
      const pb = signed(EVENT);
      const a = await app.request('/v1/postback/br_winner', { ...pb, headers: { ...pb.headers, 'CF-IPCountry': 'CN' } });
      const b = await app.request('/v1/offers/of_001/claim', { method: 'POST', headers: { 'X-Dev-User': 'u_102', 'CF-IPCountry': 'CN' } });
      return [a.status, b.status];
    });
    expect(r).toEqual([200, 451]);
    expect(logs).toEqual([{ evt: 'postback_geo_exempt', level: 'info', brandId: 'br_winner', country: 'CN', ip: 'unknown' }]);
  });
});
