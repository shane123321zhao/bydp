/** 登录后接口（/me* · /complaints）：app 在事务里跑（结束回滚），被测代码以 bydp_app 执行；本地会话 X-Dev-User */
import { ComplaintMine, Evidence } from '@bydp/core/complaint';
import { Binding, MePayload } from '@bydp/core/identity';
import { connect, type CoreDb } from '@bydp/core/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../src/app';
import { devHeaderSession } from '../src/session';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());
process.env.BINDING_HMAC_KEY ??= 'bydp-seed-only-test-key-not-for-production-0001';

async function withApp<T>(opts: AppOptions, fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(`set local role bydp_app`);
      out = await fn(createApp(tx as unknown as CoreDb, { resolveUser: devHeaderSession, ...opts }));
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}
const as = (user: string | null, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), ...(user ? { 'X-Dev-User': user } : {}) } });
const json = (user: string, body: unknown) => as(user, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const COMPLAINT = { brandId: 'br_winner', category: 'refused', amountUsdt: 1200, eventDate: '2026-09-20', description: '提款三天未到账' };

describe.skipIf(!url)('登录后接口', () => {
  it('偏好：默认全关；PUT 整体替换后 GET 一致；越界 → 400；未登录 → 401', async () => {
    const put = (u: string, body: unknown) => as(u, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const r = await withApp({}, async (app) => {
      const before = await (await app.request('/v1/me/preferences', as('u_233'))).json();
      const p = await app.request('/v1/me/preferences', put('u_233', { dailyDepositAlertUsdt: 500, sessionAlertMinutes: 120, nightAlert: true }));
      const after = await (await app.request('/v1/me/preferences', as('u_233'))).json();
      const bad = (await app.request('/v1/me/preferences', put('u_233', { dailyDepositAlertUsdt: null, sessionAlertMinutes: 5, nightAlert: false }))).status;
      const anon = (await app.request('/v1/me/preferences')).status;
      return { before, put: p.status, after, bad, anon };
    });
    expect(r.before).toEqual({ dailyDepositAlertUsdt: null, sessionAlertMinutes: null, nightAlert: false });
    expect(r.put).toBe(200);
    expect(r.after).toEqual({ dailyDepositAlertUsdt: 500, sessionAlertMinutes: 120, nightAlert: true });
    expect([r.bad, r.anon]).toEqual([400, 401]);
  });

  it('自我排除：204，GET /me settings.selfExclusion 生效；period 不在枚举 → 400', async () => {
    const r = await withApp({}, async (app) => {
      const ok = (await app.request('/v1/me/self-exclusion', json('u_233', { period: '90' }))).status;
      const bad = (await app.request('/v1/me/self-exclusion', json('u_233', { period: '7' }))).status;
      const me = MePayload.parse(await (await app.request('/v1/me', as('u_233'))).json());
      return { ok, bad, se: me.settings?.selfExclusion };
    });
    expect([r.ok, r.bad]).toEqual([204, 400]);
    expect(r.se?.period).toBe('90');
  });

  it('数据请求：导出 202 且同类处理中不重复建；导出带证据 → 400；注销（匿名化）202', async () => {
    const r = await withApp({}, async (app) => {
      const a = (await app.request('/v1/me/data-requests', json('u_233', { kind: 'export' }))).status;
      const b = (await app.request('/v1/me/data-requests', json('u_233', { kind: 'export', note: '再来一次' }))).status;
      const bad = (await app.request('/v1/me/data-requests', json('u_233', { kind: 'export', evidenceIds: ['ev_001'] }))).status;
      const anon = (await app.request('/v1/me/data-requests', json('u_233', { kind: 'anonymize' }))).status;
      return [a, b, bad, anon];
    });
    expect(r).toEqual([202, 202, 400, 202]);
  });

  it('未登录 → 401（/me、/me/bindings、/me/complaints/{id}、/complaints、/me/subscriptions、证据）', async () => {
    const r = await withApp({}, async (app) => [
      (await app.request('/v1/me')).status,
      (await app.request('/v1/me/bindings')).status,
      (await app.request('/v1/me/complaints/cp_001')).status,
      (await app.request('/v1/complaints', { method: 'POST', body: JSON.stringify(COMPLAINT), headers: { 'Content-Type': 'application/json' } })).status,
      (await app.request('/v1/me/subscriptions', { method: 'POST', body: '{"targetType":"brand","targetId":"br_royal"}', headers: { 'Content-Type': 'application/json' } })).status,
      (await app.request('/v1/complaints/cp_001/evidence', { method: 'POST', body: new FormData() })).status,
    ]);
    expect(r.every((s) => s === 401 || s === 400)).toBe(true);
    expect(r.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
  });

  it('GET /me 契约形状；GET /me/bindings 只给掩码', async () => {
    const r = await withApp({}, async (app) => ({
      me: MePayload.parse(await (await app.request('/v1/me', as('u_102'))).json()),
      bindings: (await (await app.request('/v1/me/bindings', as('u_102'))).json()) as unknown[],
    }));
    expect(r.me.user?.displayName).toBe('阿明');
    expect(Binding.parse(r.bindings[0])).toMatchObject({ operatorAccountIdMasked: 'JL*******1' });
  });

  it('POST /me/bindings：201 自报级；同品牌同账号 → 409；品牌不存在 → 400；黑名单品牌 → 400 brand_not_bindable', async () => {
    const r = await withApp({}, async (app) => {
      const a = await app.request('/v1/me/bindings', json('u_233', { brandId: 'br_royal', operatorAccountId: 'RA-API-0001' }));
      const bad = await app.request('/v1/me/bindings', json('u_233', { brandId: 'br_nope', operatorAccountId: 'X-1' }));
      const black = await app.request('/v1/me/bindings', json('u_233', { brandId: 'br_caishen', operatorAccountId: 'CS-API-1' }));
      const dup = await app.request('/v1/me/bindings', json('u_509', { brandId: 'br_royal', operatorAccountId: 'RA-API-0001' }));
      return { a: a.status, body: Binding.parse(await a.json()), bad: bad.status, black: [black.status, await black.json()], dup: [dup.status, await dup.json()] };
    });
    expect(r.black).toEqual([400, { error: 'brand_not_bindable' }]);
    expect(r.a).toBe(201);
    expect(r.body).toMatchObject({ source: 'manual', verificationLevel: 'self_reported' });
    expect(r.bad).toBe(400);
    expect(r.dup).toEqual([409, { code: 'already_bound', message: '该运营商账号已被绑定（同一账号只能被一个 BYDP 用户绑定）' }]);
  });

  it('POST /complaints → 201 ComplaintMine（待初筛、标题自动生成）；本人可查、他人 404；请求体里的 userId 被忽略', async () => {
    const r = await withApp({}, async (app) => {
      const res = await app.request('/v1/complaints', json('u_102', { ...COMPLAINT, userId: 'u_233' }));
      const body = ComplaintMine.parse(await res.json());
      return {
        status: res.status,
        body,
        mine: (await app.request(`/v1/me/complaints/${body.id}`, as('u_102'))).status,
        other: (await app.request(`/v1/me/complaints/${body.id}`, as('u_233'))).status,
      };
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'screening', title: '提款被拒 1,200 USDT' });
    expect([r.mine, r.other]).toEqual([200, 404]);
  });

  it('提交后按新通知 id 入队推送；入队失败不影响 201', async () => {
    const got: string[][] = [];
    const ok = await withApp({ notify: async (ids) => void got.push(ids) }, async (app) => (await app.request('/v1/complaints', json('u_102', COMPLAINT))).status);
    expect(ok).toBe(201);
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toMatch(/^nt_[0-9a-f]+$/);
    const failing = await withApp({ notify: async () => Promise.reject(new Error('redis down')) }, async (app) => (await app.request('/v1/complaints', json('u_102', COMPLAINT))).status);
    expect(failing).toBe(201);
  });

  it('证据：tx_hash 无文件直接存哈希；有文件无存储 → 503；注入存储 → 201 且原文写入存储（类型按文件头判定）；非白名单文件 → 400；他人案件 → 400', async () => {
    const stored: { key: string; bytes: number; type: string | null }[] = [];
    const store = { put: async (key: string, content: Uint8Array, type: string | null) => void stored.push({ key, bytes: content.byteLength, type }) };
    const run = (opts: AppOptions) =>
      withApp(opts, async (app) => {
        const c = ComplaintMine.parse(await (await app.request('/v1/complaints', json('u_102', COMPLAINT))).json());
        const tx = new FormData();
        tx.set('type', 'tx_hash');
        tx.set('txHash', '0xabc123');
        const file = new FormData();
        file.set('type', 'screenshot');
        file.set('label', '提款记录');
        file.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'shot.png', { type: 'text/html' }));
        const exe = new FormData();
        exe.set('type', 'other');
        exe.set('file', new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], 'shot.png', { type: 'image/png' }));
        const other = new FormData();
        other.set('type', 'tx_hash');
        other.set('txHash', '0xdef');
        const a = await app.request(`/v1/complaints/${c.id}/evidence`, as('u_102', { method: 'POST', body: tx }));
        const b = await app.request(`/v1/complaints/${c.id}/evidence`, as('u_102', { method: 'POST', body: file }));
        const d = await app.request(`/v1/complaints/${c.id}/evidence`, as('u_233', { method: 'POST', body: other }));
        const e = await app.request(`/v1/complaints/${c.id}/evidence`, as('u_102', { method: 'POST', body: exe }));
        return { a: [a.status, await a.json()], b: [b.status, await b.json()], d: d.status, e: e.status };
      });
    const noStore = await run({});
    expect(noStore.a[0]).toBe(201);
    expect(Evidence.parse(noStore.a[1]).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(noStore.b).toEqual([503, { error: 'evidence_storage_unavailable' }]);
    expect(noStore.d).toBe(400);
    const withStore = await run({ evidenceStore: store });
    expect(withStore.b[0]).toBe(201);
    expect(withStore.b[1]).toMatchObject({ type: 'screenshot', label: '提款记录', redacted: false });
    expect(stored).toEqual([{ key: expect.stringMatching(/^evidence\/cp_[0-9a-f]+\/ev_[0-9a-f]+$/), bytes: 8, type: 'image/png' }]);
    expect(withStore.e).toBe(400);
  });

  it('D-015 #2：每用户 24 小时第 4 件投诉 → 429 rate_limited（契约 Error 体）', async () => {
    const r = await withApp({}, async (app) => {
      const out: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await app.request('/v1/complaints', json('u_509', COMPLAINT));
        out.push(res.status === 201 ? 201 : [res.status, await res.json()]);
      }
      return out;
    });
    expect(r.slice(0, 3)).toEqual([201, 201, 201]);
    expect(r[3]).toEqual([429, { code: 'rate_limited', message: '24 小时内最多提交 3 件投诉，请稍后再试' }]);
  });

  it('POST /me/subscriptions → 201；对象不存在 → 400', async () => {
    const r = await withApp({}, async (app) => [
      (await app.request('/v1/me/subscriptions', json('u_233', { targetType: 'brand', targetId: 'br_royal' }))).status,
      (await app.request('/v1/me/subscriptions', json('u_233', { targetType: 'brand', targetId: 'br_nope' }))).status,
    ]);
    expect(r).toEqual([201, 400]);
  });
});
