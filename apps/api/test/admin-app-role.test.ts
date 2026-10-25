/**
 * D-020 #12（协调官裁定 ②）：后台写操作以 **bydp_app 登录身份**（不是 owner + SET ROLE）跑一遍——证明线上运行身份的授权足够、审计照写。
 * CI 由 scripts/ci.sh 给临时库的 bydp_app 设测试密码并导出 DATABASE_URL_APP；缺失即失败。每例事务内执行后回滚。
 */
import { connect, type CoreDb } from '@bydp/core/runtime';
import { submitComplaint } from '@bydp/core/complaint/write';
import { createDataRequest } from '@bydp/core/identity/privacy';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { devHeaderSession } from '../src/session';

const url = process.env.DATABASE_URL_APP;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL_APP（bydp_app 登录身份）');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());

type Tx = { execute: (q: string) => Promise<unknown> };
const as = (user: string, method = 'GET', body?: unknown): RequestInit => ({
  method,
  headers: { 'X-Dev-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const store = () => {
  const objects = new Map<string, Uint8Array>();
  return { put: async (k: string, b: Uint8Array) => void objects.set(k, b), get: async (k: string) => objects.get(k) ?? null, delete: async (k: string) => void objects.delete(k) };
};

describe.skipIf(!url)('后台写操作 · bydp_app 登录身份（§9 #12）', () => {
  it('受理 → 一次通知 · 品牌状态变更 · 改角色 · 数据请求完成 · 审核台决定：均 200 且写 audit_log', async () => {
    let out: Record<string, unknown> = {};
    await conn!.db
      .transaction(async (tx) => {
        const t = tx as unknown as Tx;
        const [who] = (await t.execute(`select current_user as u`)) as { u: string }[];
        for (const [u, r] of [['u_102', 'arbitrator'], ['u_233', 'editor'], ['u_509', 'admin']]) {
          await t.execute(`insert into "user_role" ("userId","roleKey") values ('${u}','${r}') on conflict do nothing`);
        }
        const app = createApp(tx as unknown as CoreDb, { resolveUser: devHeaderSession, evidenceStore: store() });
        const c = await submitComplaint(tx as never, 'u_412', { brandId: 'br_winner', category: 'refused', amountUsdt: 500, eventDate: '2026-09-20', description: 'bydp_app 后台测试' });
        const post = async (u: string, p: string, b: unknown) => (await app.request(`/admin/v1${p}`, as(u, 'POST', b))).status;
        const steps = {
          accept: await post('u_102', `/complaints/${c.id}/transition`, { to: 'accepted' }),
          notice: await post('u_102', `/complaints/${c.id}/operator-notice`, { which: 'first', channel: '认领邮箱' }),
          brand: await post('u_509', '/brands/br_winner/status', { to: 'blacklist', reason: '多起提款被拒且未答辩' }),
          roles: (await app.request('/admin/v1/users/u_412/roles', as('u_509', 'PUT', { roles: ['editor'] }))).status,
        };
        const dr = await createDataRequest(tx as never, 'u_233', { kind: 'export' }, { authTime: Math.floor(Date.now() / 1000) });
        const resolve = await post('u_509', `/data-requests/${dr.id}/resolve`, { result: 'done' });
        await t.execute(`insert into "review_item" ("id","kind","subject","proposal","source") values ('ri_app','brand_attribute','br_jinlong','{"x":1}','collector@0.1')`);
        const review = await post('u_233', '/review-queue/ri_app/decision', { decision: 'reject', note: '测试' });
        const audits = (await t.execute(
          `select "action" from "audit_log" where "action" in ('complaint_transition','operator_notice_first','brand_status_change','user_roles_set','data_request_resolve','review_item_decision') order by "action"`,
        )) as { action: string }[];
        out = { who: who!.u, steps, resolve, review, audits: [...new Set(audits.map((a) => a.action))] };
        tx.rollback();
      })
      .catch((e: Error) => {
        if (!/rollback/i.test(e.message)) throw e;
      });
    expect(out.who).toBe('bydp_app');
    expect(out.steps).toEqual({ accept: 200, notice: 200, brand: 200, roles: 200 });
    expect([out.resolve, out.review]).toEqual([200, 200]);
    expect(out.audits).toEqual(expect.arrayContaining(['brand_status_change', 'data_request_resolve', 'review_item_decision', 'user_roles_set']));
  });
});
