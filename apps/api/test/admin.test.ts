/**
 * 后台接口（admin 契约 v0.2，第 1 轮）：RBAC 越权（协调官必测三条）、仲裁台全流程、公开确认与修订审计、证据下载。
 * 已迁移 + seed 的库；每例事务内执行后回滚；owner 回调造角色 / 缩短答辩期，接口以 bydp_app 执行；本地会话 X-Dev-User。
 */
import { connect, type CoreDb } from '@bydp/core/runtime';
import { submitComplaint, addEvidence } from '@bydp/core/complaint/write';
import { RoleChangeError, setUserRoles } from '@bydp/core/admin/rbac';
import { createDataRequest } from '@bydp/core/identity/privacy';
import { reconcileDeletedObjects } from '@bydp/core/admin/object-reconcile';
import { resolveDataRequest } from '@bydp/core/admin/data-requests';
import { createBinding, findBindingByAccountHash } from '@bydp/core/identity/bindings';
import { deviceFingerprint, purgeAnonymizedDevices, recordDeviceLogin } from '@bydp/core/identity/device';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../src/app';
import { devHeaderSession } from '../src/session';
import { pgCode, pgConstraint } from '../src/routes/admin';
import { listUndeliveredNotifications } from '@bydp/core/notify/deliver';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());

type Tx = { execute: (q: string) => Promise<unknown> };
const ROLES: [string, string][] = [
  ['u_102', 'arbitrator'],
  ['u_233', 'editor'],
  ['u_412', 'commerce'],
  ['u_509', 'admin'],
];
async function withApp<T>(fn: (app: ReturnType<typeof createApp>, tx: CoreDb & Tx) => Promise<T>, opts: AppOptions = {}): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      const t = tx as unknown as Tx;
      for (const [k, n] of [['arbitrator', '仲裁员'], ['editor', '编辑'], ['commerce', '商务'], ['admin', '管理员']]) {
        await t.execute(`insert into "role" ("key","name") values ('${k}','${n}') on conflict do nothing`);
      }
      for (const [u, r] of ROLES) await t.execute(`insert into "user_role" ("userId","roleKey") values ('${u}','${r}')`);
      await t.execute('set local role bydp_app');
      out = await fn(createApp(tx as unknown as CoreDb, { resolveUser: devHeaderSession, ...opts }), tx as unknown as CoreDb & Tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}
const as = (user: string | null, method = 'GET', body?: unknown): RequestInit => ({
  method,
  headers: { ...(user ? { 'X-Dev-User': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const COMPLAINT = { brandId: 'br_winner', category: 'refused' as const, amountUsdt: 800, eventDate: '2026-09-20', description: '原文：客服 小王 13800001111 拒付' };
const CHECKLIST = { noPersonalNames: true, noContactInfo: true, noAccountIds: true, noImagesWithFaces: true };

describe.skipIf(!url)('admin RBAC', () => {
  it('未登录 401；登录但无后台角色 403 forbidden；有角色可取会话', async () => {
    const r = await withApp(async (app) => [
      (await app.request('/admin/v1/session')).status,
      [(await app.request('/admin/v1/session', as('u_777'))).status, await (await app.request('/admin/v1/session', as('u_777'))).json()],
      await (await app.request('/admin/v1/session', as('u_102'))).json(),
    ]);
    expect(r[0]).toBe(401);
    expect(r[1]).toEqual([403, { code: 'forbidden', message: '无后台角色' }]);
    expect(r[2]).toEqual({ userId: 'u_102', roles: ['arbitrator'] });
  });

  it('协调官必测：editor 调仲裁动作 → 403；commerce 调任何写 → 403；admin 自降权 → 409', async () => {
    const r = await withApp(async (app) => {
      const s = (res: Response) => res.status;
      return {
        editorTransition: s(await app.request('/admin/v1/complaints/cp_001/transition', as('u_233', 'POST', { to: 'accepted' }))),
        editorExpose: s(await app.request('/admin/v1/complaints/cp_001/expose', as('u_233', 'POST', { reason: 'x' }))),
        editorRead: s(await app.request('/admin/v1/complaints', as('u_233'))),
        commerceWrites: [
          s(await app.request('/admin/v1/complaints/cp_001/transition', as('u_412', 'POST', { to: 'accepted' }))),
          s(await app.request('/admin/v1/complaints/cp_001/operator-notice', as('u_412', 'POST', { which: 'first', channel: 'mail' }))),
          s(await app.request('/admin/v1/complaints/cp_001/publish', as('u_412', 'POST', { publicDescription: 'x', checklist: CHECKLIST }))),
          s(await app.request('/admin/v1/users/u_412/roles', as('u_412', 'PUT', { roles: ['admin'] }))),
        ],
        commerceDownload: s(await app.request('/admin/v1/evidence/ev_001/download', as('u_412'))),
        selfDemote: [
          (await app.request('/admin/v1/users/u_509/roles', as('u_509', 'PUT', { roles: ['editor'] }))).status,
          await (await app.request('/admin/v1/users/u_509/roles', as('u_509', 'PUT', { roles: [] }))).json(),
        ],
        arbitratorRoles: s(await app.request('/admin/v1/users/u_102/roles', as('u_102'))),
      };
    });
    expect(r.editorTransition).toBe(403);
    expect(r.editorExpose).toBe(403);
    expect(r.editorRead).toBe(403);
    expect(r.commerceWrites).toEqual([403, 403, 403, 403]);
    expect(r.commerceDownload).toBe(403);
    expect(r.selfDemote).toEqual([409, { code: 'invalid_argument', message: '不能移除自己的管理员角色' }]);
    expect(r.arbitratorRoles).toBe(403);
  });

  it('角色管理：仲裁与商务互斥 → 409；合法替换写 audit_log（before / after）；撤销角色立即生效', async () => {
    const r = await withApp(async (app, tx) => {
      const both = (await app.request('/admin/v1/users/u_233/roles', as('u_509', 'PUT', { roles: ['arbitrator', 'commerce'] }))).status;
      const set = await (await app.request('/admin/v1/users/u_102/roles', as('u_509', 'PUT', { roles: ['editor'] }))).json();
      const after = (await app.request('/admin/v1/complaints', as('u_102'))).status; // 已无 arbitrator
      const [a] = (await tx.execute(
        `select "actorId", "actorRole", "before"->'roles' as b, "after"->'roles' as af from "audit_log" where "action" = 'user_roles_set' and "targetId" = 'u_102'`,
      )) as { actorId: string; actorRole: string; b: string[]; af: string[] }[];
      return { both, set, after, a };
    });
    expect(r.both).toBe(409);
    expect(r.set).toEqual(['editor']);
    expect(r.after).toBe(403);
    expect(r.a).toEqual({ actorId: 'u_509', actorRole: 'admin', b: ['arbitrator'], af: ['editor'] });
  });
});

describe.skipIf(!url)('admin 第 2 轮须改：回避与重新验证', () => {
  const at = (user: string, ageSec: number, method = 'GET', body?: unknown): RequestInit => {
    const init = as(user, method, body);
    return { ...init, headers: { ...(init.headers as Record<string, string>), 'X-Dev-Auth-Time': String(Math.floor(Date.now() / 1000) - ageSec) } };
  };
  it('回避：本人提交的案件，本人以仲裁员身份流转 / 通知 / 曝光 / 公开 → 409 conflict_of_interest；他人案件照常', async () => {
    const r = await withApp(async (app, tx) => {
      const mine = await submitComplaint(tx as never, 'u_102', COMPLAINT);
      const other = await submitComplaint(tx as never, 'u_233', COMPLAINT);
      const post = (id: string, path: string, body: unknown) => app.request(`/admin/v1/complaints/${id}${path}`, as('u_102', 'POST', body));
      return {
        transition: await (await post(mine.id, '/transition', { to: 'accepted' })).json(),
        notice: (await post(mine.id, '/operator-notice', { which: 'first', channel: 'x' })).status,
        expose: (await post(mine.id, '/expose', { reason: 'x' })).status,
        publish: (await post(mine.id, '/publish', { publicDescription: 'x', checklist: CHECKLIST })).status,
        otherOk: (await post(other.id, '/transition', { to: 'accepted' })).status,
      };
    });
    expect(r.transition).toEqual({ code: 'conflict_of_interest', message: '不得处理本人提交的投诉（回避）' });
    expect([r.notice, r.expose, r.publish]).toEqual([409, 409, 409]);
    expect(r.otherOk).toBe(200);
  });
  it('重新验证：登录 30 分钟——读队列 / 流转可，确认曝光 / 公开 / 改角色 → 401 reauth_required；登录 25 小时——任何后台请求 401', async () => {
    const r = await withApp(async (app, tx) => {
      const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
      const m30 = 30 * 60;
      return {
        queue: (await app.request('/admin/v1/complaints', at('u_102', m30))).status,
        transition: (await app.request(`/admin/v1/complaints/${c.id}/transition`, at('u_102', m30, 'POST', { to: 'accepted' }))).status,
        expose: await (await app.request(`/admin/v1/complaints/${c.id}/expose`, at('u_102', m30, 'POST', { reason: 'x' }))).json(),
        publish: (await app.request(`/admin/v1/complaints/${c.id}/publish`, at('u_102', m30, 'POST', { publicDescription: 'x', checklist: CHECKLIST }))).status,
        roles: (await app.request('/admin/v1/users/u_233/roles', at('u_509', m30, 'PUT', { roles: ['editor'] }))).status,
        rolesFresh: (await app.request('/admin/v1/users/u_233/roles', at('u_509', 60, 'PUT', { roles: ['editor'] }))).status,
        stale: await (await app.request('/admin/v1/session', at('u_102', 25 * 3600))).json(),
      };
    });
    expect([r.queue, r.transition]).toEqual([200, 200]);
    expect(r.expose).toEqual({ error: 'reauth_required', message: '该操作需 10 分钟内重新登录' });
    expect([r.publish, r.roles, r.rolesFresh]).toEqual([401, 401, 200]);
    expect(r.stale).toEqual({ error: 'reauth_required', message: '后台会话已超过 24 小时，请重新登录' });
  });
});

describe.skipIf(!url)('admin 角色并发兜底（自检）', () => {
  it('不能移除系统中最后一个 admin（两位 admin 互相撤销时，后执行者的授权已过期）；非法 cursor → 400', async () => {
    const r = await withApp(async (app, tx) => {
      // 模拟「两位 admin 互撤」串行后的第二步：u_233 的 admin 已被撤销，但其请求在撤销前已通过中间件授权
      const stale = await setUserRoles(tx as never, { id: 'u_233', role: 'admin', ip: null }, 'u_509', ['editor']).catch((e) => e);
      const cursor = (await app.request('/admin/v1/complaints?cursor=abc|x', as('u_102'))).status;
      const page = await (await app.request('/admin/v1/complaints?status=screening', as('u_102'))).json();
      return { stale, cursor, page };
    });
    expect(r.stale).toBeInstanceOf(RoleChangeError);
    expect((r.stale as Error).message).toBe('不能移除系统中最后一个管理员');
    expect(r.cursor).toBe(400);
    expect(Array.isArray(r.page.items)).toBe(true);
  });
});

describe.skipIf(!url)('admin 仲裁台', () => {
  it('全流程：受理 → 通知 ×2（记渠道）→ 期满 → 确认曝光 → 公开确认（清单不全 409）→ 公开页只显示公开陈述 → 修订写 audit before / after', async () => {
    const r = await withApp(async (app, tx) => {
      const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
      const post = (path: string, body: unknown) => app.request(`/admin/v1/complaints/${c.id}${path}`, as('u_102', 'POST', body));
      const steps: unknown[] = [];
      steps.push((await post('/transition', { to: 'accepted' })).status);
      steps.push((await post('/publish', { publicDescription: '提款被拒', checklist: CHECKLIST })).status); // 未结案
      steps.push((await post('/operator-notice', { which: 'first', channel: '认领邮箱' })).status);
      // 答辩期剩 ≤ 72h 且未发二次通知才标 second_notice_due：缩短至 48h
      await tx.execute('reset role');
      await tx.execute(`update "complaint" set "replyDeadline" = now() + interval '48 hours' where "id" = '${c.id}'`);
      await tx.execute('set local role bydp_app');
      const due = await (await app.request('/admin/v1/complaints?flag=second_notice_due', as('u_102'))).json();
      steps.push((await post('/operator-notice', { which: 'second', channel: '官方 TG' })).status);
      steps.push((await post('/expose', { reason: '两次通知无响应' })).status); // 期满前
      await tx.execute('reset role');
      await tx.execute(`update "complaint" set "replyDeadline" = now() - interval '1 hour' where "id" = '${c.id}'`);
      await tx.execute('set local role bydp_app');
      const pending = await (await app.request('/admin/v1/complaints?flag=pending_exposure_decision', as('u_102'))).json();
      steps.push((await post('/expose', { reason: '两次通知无响应，答辩期届满' })).status);
      steps.push([(await post('/publish', { publicDescription: '用户提款被拒', checklist: { ...CHECKLIST, noContactInfo: false } })).status]);
      const pub = await (await post('/publish', { publicDescription: '用户提款 800 USDT 被拒，运营商两次通知未回应。', checklist: CHECKLIST })).json();
      const casePage = await (await app.request(`/v1/cases/${c.id}`)).text();
      await post('/publish', { publicDescription: '用户提款 800 USDT 被拒（修订）。', checklist: CHECKLIST });
      const detail = await (await app.request(`/admin/v1/complaints/${c.id}`, as('u_102'))).json();
      const [rev] = (await tx.execute(
        `select "before"->>'publicDescription' as b, "after"->>'publicDescription' as a, "actorRole" from "audit_log" where "action" = 'complaint_public_revise' and "targetId" = '${c.id}'`,
      )) as { b: string; a: string; actorRole: string }[];
      const [notice] = (await tx.execute(`select "after"->>'channel' as ch from "audit_log" where "action" = 'operator_notice_second' and "targetId" = '${c.id}'`)) as { ch: string }[];
      return { id: c.id, steps, due, pending, pub, casePage, detail, rev, notice };
    });
    expect(r.steps).toEqual([200, 409, 200, 200, 409, 200, [409]]);
    expect(r.due.items.map((x: { id: string }) => x.id)).toContain(r.id);
    expect(r.pending.items.map((x: { id: string }) => x.id)).toContain(r.id);
    expect(r.pub).toMatchObject({ status: 'exposed', publicSummary: true, publicDescription: '用户提款 800 USDT 被拒，运营商两次通知未回应。', notices: 2 });
    expect(r.casePage).toContain('运营商两次通知未回应');
    expect(r.casePage).not.toContain('13800001111');
    expect(r.casePage).not.toContain('小王');
    expect(r.detail.description).toBe(COMPLAINT.description); // 后台可见原文
    expect(r.detail.audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['complaint_transition', 'operator_notice_first', 'operator_notice_second', 'exposure_confirmed', 'complaint_publish', 'complaint_public_revise']),
    );
    expect(r.rev).toEqual({ b: '用户提款 800 USDT 被拒，运营商两次通知未回应。', a: '用户提款 800 USDT 被拒（修订）。', actorRole: 'arbitrator' });
    expect(r.notice).toEqual({ ch: '官方 TG' });
  });

  it('初筛驳回须填原因（409 invalid_argument）；驳回案件不能公开（409 invalid_transition）；不存在 → 404', async () => {
    const r = await withApp(async (app, tx) => {
      const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
      const post = (path: string, body: unknown) => app.request(`/admin/v1/complaints/${c.id}${path}`, as('u_509', 'POST', body));
      const noReason = await (await post('/transition', { to: 'rejected' })).json();
      const ok = (await post('/transition', { to: 'rejected', reason: '重复投诉' })).status;
      const pub = await (await post('/publish', { publicDescription: 'x', checklist: CHECKLIST })).json();
      const nf = (await app.request('/admin/v1/complaints/cp_nope', as('u_509'))).status;
      return { noReason, ok, pub, nf };
    });
    expect(r.noReason.code).toBe('invalid_argument');
    expect(r.ok).toBe(200);
    expect(r.pub.code).toBe('invalid_transition');
    expect(r.nf).toBe(404);
  });

  it('证据下载：attachment + nosniff + 沙箱 CSP，写 audit_log；原文已删 → 410', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const objects = new Map<string, Uint8Array>();
    const store = { put: async (k: string, b: Uint8Array) => void objects.set(k, b), get: async (k: string) => objects.get(k) ?? null };
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'screenshot', content: PNG });
        const res = await app.request(`/admin/v1/evidence/${ev.id}/download`, as('u_102'));
        const headers = Object.fromEntries(['content-type', 'content-disposition', 'x-content-type-options', 'content-security-policy'].map((h) => [h, res.headers.get(h)]));
        const bytes = new Uint8Array(await res.arrayBuffer()).byteLength;
        const [a] = (await tx.execute(`select "actorId", "actorRole" from "audit_log" where "action" = 'evidence_download' and "targetId" = '${ev.id}'`)) as Record<string, string>[];
        await tx.execute(`update "evidence" set "deletedAt" = now(), "storageKey" = null where "id" = '${ev.id}'`);
        const gone = (await app.request(`/admin/v1/evidence/${ev.id}/download`, as('u_102'))).status;
        return { id: ev.id, status: res.status, headers, bytes, a, gone };
      },
      { evidenceStore: store },
    );
    expect(r.status).toBe(200);
    expect(r.headers).toEqual({
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="${r.id}.png"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect(r.bytes).toBe(10);
    expect(r.a).toEqual({ actorId: 'u_102', actorRole: 'arbitrator' });
    expect(r.gone).toBe(410);
  });
});

const HAS_PDFTOPPM = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
/** 最小单页 PDF（无脚本），用于渲染测试 */
function tinyPdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 18 Tf 20 50 Td (BYDP evidence) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe.skipIf(!url)('admin 证据沙箱预览（第 2 轮）', () => {
  const mkStore = () => {
    const objects = new Map<string, Uint8Array>();
    return { objects, store: { put: async (k: string, b: Uint8Array) => void objects.set(k, b), get: async (k: string) => objects.get(k) ?? null, delete: async (k: string) => void objects.delete(k) } };
  };
  it('图片：重编码为 PNG、去元数据、宽 ≤ 2000；二次读取命中缓存；第 2 页 404；不写 audit；editor 403；原文已删 410', async () => {
    const { objects, store } = mkStore();
    const jpeg = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#336699' } }).jpeg().withMetadata({ exif: { IFD0: { Artist: 'SECRET-AUTHOR' } } }).toBuffer();
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'screenshot', content: new Uint8Array(jpeg) });
        const res = await app.request(`/admin/v1/evidence/${ev.id}/preview`, as('u_102'));
        const png = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(png).metadata();
        const cachedKey = [...objects.keys()].find((k) => k.startsWith(`preview/${ev.id}/`));
        const again = (await app.request(`/admin/v1/evidence/${ev.id}/preview`, as('u_102'))).status;
        const p2 = (await app.request(`/admin/v1/evidence/${ev.id}/preview?page=2`, as('u_102'))).status;
        const editor = (await app.request(`/admin/v1/evidence/${ev.id}/preview`, as('u_233'))).status;
        const [a] = (await tx.execute(`select count(*)::int as n from "audit_log" where "targetId" = '${ev.id}'`)) as { n: number }[];
        await tx.execute(`update "evidence" set "deletedAt" = now(), "storageKey" = null where "id" = '${ev.id}'`);
        const gone = (await app.request(`/admin/v1/evidence/${ev.id}/preview`, as('u_102'))).status;
        return { status: res.status, type: res.headers.get('content-type'), nosniff: res.headers.get('x-content-type-options'), meta, leaks: png.includes(Buffer.from('SECRET-AUTHOR')), cachedKey, again, p2, editor, audits: a!.n, gone };
      },
      { evidenceStore: store },
    );
    expect([r.status, r.type, r.nosniff]).toEqual([200, 'image/png', 'nosniff']);
    expect([r.meta.format, r.meta.width, r.meta.exif]).toEqual(['png', 2000, undefined]);
    expect(r.leaks).toBe(false);
    expect(r.cachedKey).toMatch(/^preview\/ev_[0-9a-f]+\/1\.png$/);
    expect([r.again, r.p2, r.editor, r.audits, r.gone]).toEqual([200, 404, 403, 0, 410]);
  });
  it('纯文本：text/plain + nosniff，不缓存', async () => {
    const { objects, store } = mkStore();
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'chat_log', content: new TextEncoder().encode('<script>alert(1)</script> 客服：审核中') });
        const res = await app.request(`/admin/v1/evidence/${ev.id}/preview`, as('u_102'));
        return { type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), body: await res.text(), cached: [...objects.keys()].some((k) => k.startsWith('preview/')) };
      },
      { evidenceStore: store },
    );
    expect(r).toEqual({ type: 'text/plain; charset=utf-8', csp: "default-src 'none'; sandbox", body: '<script>alert(1)</script> 客服：审核中', cached: false });
  });
  it.skipIf(!HAS_PDFTOPPM)('PDF：poppler 渲染首页为 PNG（宽 2000）；超出页数 → 404（本机无 pdftoppm 时跳过，测试站镜像内验证）', async () => {
    const { store } = mkStore();
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'other', content: tinyPdf() });
        const res = await app.request(`/admin/v1/evidence/${ev.id}/preview`, as('u_102'));
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        const p2 = (await app.request(`/admin/v1/evidence/${ev.id}/preview?page=2`, as('u_102'))).status;
        return { status: res.status, format: meta.format, width: meta.width, p2 };
      },
      { evidenceStore: store },
    );
    expect(r).toEqual({ status: 200, format: 'png', width: 2000, p2: 404 });
  });
});

describe.skipIf(!url)('admin 数据请求处理（第 2 轮下）', () => {
  const FRESH = () => ({ authTime: Math.floor(Date.now() / 1000) });
  const mkStore = () => {
    const objects = new Map<string, Uint8Array>();
    return {
      objects,
      store: {
        put: async (k: string, b: Uint8Array) => void objects.set(k, b),
        get: async (k: string) => objects.get(k) ?? null,
        delete: async (k: string) => void objects.delete(k),
        exists: async (k: string) => objects.has(k),
        presign: (k: string, sec: number) => `https://r2.example/${k}?X-Amz-Expires=${sec}`,
      },
    };
  };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  const close = async (tx: Tx, id: string) => {
    await tx.execute('reset role');
    await tx.execute(`update "complaint" set "status" = 'exposed', "exposedAt" = now() where "id" = '${id}'`);
    await tx.execute('set local role bydp_app');
  };

  it('导出：admin done → 生成本人导出包（不含他人数据）+ 站内通知 + audit；本人取 7 天下载链接，他人 404；仲裁员无权 403', async () => {
    const { objects, store } = mkStore();
    const r = await withApp(
      async (app, tx) => {
        const dr = await createDataRequest(tx as never, 'u_233', { kind: 'export' }, FRESH());
        const arb = (await app.request('/admin/v1/data-requests', as('u_102'))).status;
        const list = await (await app.request('/admin/v1/data-requests', as('u_509'))).json();
        const done = await (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).json();
        const pkg = JSON.parse(new TextDecoder().decode(objects.get(`exports/u_233/${dr.id}.json`)!));
        const mine = await (await app.request(`/v1/me/data-requests/${dr.id}/download`, as('u_233'))).json();
        const other = (await app.request(`/v1/me/data-requests/${dr.id}/download`, as('u_102'))).status;
        const [n] = (await tx.execute(`select "title" from "notification" where "userId" = 'u_233' and "type" = 'data_request' and "title" like '数据请求已%' order by "sentAt" desc, "id" desc limit 1`)) as { title: string }[];
        const [a] = (await tx.execute(`select "actorRole", "after"->>'status' as s from "audit_log" where "action" = 'data_request_resolve' and "targetId" = '${dr.id}'`)) as Record<string, string>[];
        return { id: dr.id, arb, listed: list.items.some((x: { id: string }) => x.id === dr.id), done, pkg, mine, other, n, a };
      },
      { evidenceStore: store },
    );
    expect(r.arb).toBe(403);
    expect(r.listed).toBe(true);
    expect(r.done).toMatchObject({ status: 'done', kind: 'export' });
    expect(r.pkg).toMatchObject({ format: 'bydp-export-v1', user: { id: 'u_233' } });
    expect(JSON.stringify(r.pkg)).not.toContain('u_102');
    expect(r.mine.url).toBe(`https://r2.example/exports/u_233/${r.id}.json?X-Amz-Expires=604800`);
    expect(r.other).toBe(404);
    expect(r.n!.title).toBe('数据请求已完成：导出我的数据');
    expect(r.a).toEqual({ actorRole: 'admin', s: 'done' });
  });

  /** 新用户（owner 建行，回到 bydp_app；不建 identity——A-009 lint 禁止 api 裸写）：u_233 等 seed 用户有未结案投诉，注销会被 open_complaints 拦下 */
  const mkUser = async (tx: Tx, id: string, extra: string[] = []) => {
    await tx.execute('reset role');
    await tx.execute(`insert into "app_user" ("id", "displayName") values ('${id}', '待注销')`);
    for (const s of extra) await tx.execute(s);
    await tx.execute('set local role bydp_app');
  };
  const confirmAndDone = async (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, drId: string) => {
    await app.request(`/admin/v1/data-requests/${drId}/contact-confirmed`, as('u_509', 'POST', { channel: 'telegram' }));
    const res = await app.request(`/admin/v1/data-requests/${drId}/resolve`, as('u_509', 'POST', { result: 'done' }));
    return { status: res.status, body: await res.json() };
  };

  it('注销：未联系确认 done → 409；确认 / 结案须 10 分钟内登录；确认后 done → 执行匿名化（同事务置 done + audit 计数，不发结果通知）', async () => {
    const r = await withApp(async (app, tx) => {
      await mkUser(tx, 'u_anon_api');
      const dr = await createDataRequest(tx as never, 'u_anon_api', { kind: 'anonymize' }, FRESH());
      const stale = { ...as('u_509', 'POST', { channel: 'telegram' }) };
      (stale.headers as Record<string, string>)['X-Dev-Auth-Time'] = String(Math.floor(Date.now() / 1000) - 1800);
      const early = await (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).json();
      const staleConfirm = (await app.request(`/admin/v1/data-requests/${dr.id}/contact-confirmed`, stale)).status;
      const done = await confirmAndDone(app, dr.id);
      const again = (await app.request(`/admin/v1/data-requests/${dr.id}/contact-confirmed`, as('u_509', 'POST', { channel: 'email' }))).status;
      const [u] = (await tx.execute(`select "displayName", "anonymizedAt" is not null as anon, "sessionEpoch" from "app_user" where "id" = 'u_anon_api'`)) as Record<string, unknown>[];
      const [idn] = (await tx.execute(`select count(*)::int as n from "identity" where "userId" = 'u_anon_api'`)) as { n: number }[];
      const [a] = (await tx.execute(`select "actorRole", "after" from "audit_log" where "action" = 'data_request_resolve' and "targetId" = '${dr.id}'`)) as { actorRole: string; after: Record<string, unknown> }[];
      const [nt] = (await tx.execute(`select count(*)::int as n from "notification" where "userId" = 'u_anon_api'`)) as { n: number }[];
      return { early, staleConfirm, done, again, u, idn: idn!.n, a, nt: nt!.n };
    });
    expect(r.early).toEqual({ code: 'invalid_argument', message: '注销须先经登记联系方式确认' });
    expect(r.staleConfirm).toBe(401);
    expect(r.done.status).toBe(200);
    expect(r.done.body).toMatchObject({ kind: 'anonymize', status: 'done', contactChannel: 'telegram' });
    expect(r.again).toBe(409);
    expect(r.u).toEqual({ displayName: '已注销用户', anon: true, sessionEpoch: 1 });
    expect(r.idn).toBe(0);
    expect(r.a!.actorRole).toBe('admin');
    expect(r.a!.after).toMatchObject({ status: 'done', kind: 'anonymize', counts: { identities: 0, pointsReversed: 0, bindingsRevoked: 0 } }); // identity 清除由 db guards 0012 覆盖（lint：api 不得裸写 identity）
    expect(r.nt).toBe(0);
  });

  it('注销前提（0013 起）：临时自我排除期内可注销（A-015 过渡拦截解除，重新注册由 identity_block 拦）；有未结案投诉 → 409 open_complaints；permanent 可注销', async () => {
    const r = await withApp(async (app, tx) => {
      await mkUser(tx, 'u_anon_se', [`insert into "self_exclusion" ("id", "userId", "period") values ('se_t', 'u_anon_se', '90')`]);
      const d1 = await createDataRequest(tx as never, 'u_anon_se', { kind: 'anonymize' }, FRESH());
      const se = (await confirmAndDone(app, d1.id)).status;
      await mkUser(tx, 'u_anon_cp');
      await submitComplaint(tx as never, 'u_anon_cp', COMPLAINT);
      const d2 = await createDataRequest(tx as never, 'u_anon_cp', { kind: 'anonymize' }, FRESH());
      const cp = await confirmAndDone(app, d2.id);
      await mkUser(tx, 'u_anon_pm', [`insert into "self_exclusion" ("id", "userId", "period") values ('se_p', 'u_anon_pm', 'permanent')`]);
      const d3 = await createDataRequest(tx as never, 'u_anon_pm', { kind: 'anonymize' }, FRESH());
      const pm = (await confirmAndDone(app, d3.id)).status;
      return { se, cp, pm };
    });
    expect(r.se).toBe(200);
    expect(r.cp).toEqual({ status: 409, body: { code: 'open_complaints', message: '本人有 1 件未结案投诉，须先结案或撤诉再执行注销' } });
    expect(r.pm).toBe(200);
  });

  it('注销（0013）：已结案案件证据原文删除（哈希保留，逐条写 evidence_delete_original audit，对象删除）；原文覆盖为公开陈述 / 「（已注销）」；未公开案件标题覆盖、已公开保留', async () => {
    const { objects, store } = mkStore();
    const r = await withApp(
      async (app, tx) => {
        await mkUser(tx, 'u_anon_ev');
        const c1 = await submitComplaint(tx as never, 'u_anon_ev', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_anon_ev', c1.id, { type: 'screenshot', content: PNG });
        const key = [...objects.keys()].find((k) => k.endsWith(ev.id))!;
        objects.set(`preview/${ev.id}/1.png`, PNG);
        await close(tx, c1.id);
        const c2 = await submitComplaint(tx as never, 'u_anon_ev', COMPLAINT);
        await close(tx, c2.id);
        await tx.execute('reset role');
        await tx.execute(`update "complaint" set "publicSummary" = true, "publicDescription" = '公开陈述：提款被拒', "title" = '已公开标题' where "id" = '${c2.id}'`);
        await tx.execute('set local role bydp_app');
        const d = await createDataRequest(tx as never, 'u_anon_ev', { kind: 'anonymize' }, FRESH());
        const done = await confirmAndDone(app, d.id);
        const rows = (await tx.execute(`select "id", "title", "description" from "complaint" where "userId" = 'u_anon_ev' order by "id"`)) as { id: string; title: string; description: string }[];
        const [e] = (await tx.execute(`select "storageKey" is null as gone, "deletedAt" is not null as del, "sha256" = '${ev.sha256}' as kept from "evidence" where "id" = '${ev.id}'`)) as Record<string, boolean>[];
        const [a] = (await tx.execute(`select "actorRole", "before"->>'storageKey' as k, "after"->>'via' as via from "audit_log" where "action" = 'evidence_delete_original' and "targetId" = '${ev.id}'`)) as Record<string, string>[];
        const [res] = (await tx.execute(`select "after"->'counts' as c from "audit_log" where "action" = 'data_request_resolve' and "targetId" = '${d.id}'`)) as { c: Record<string, unknown> }[];
        return { done: done.status, c1: rows.find((x) => x.id === c1.id), c2: rows.find((x) => x.id === c2.id), e, a, key, counts: res!.c, left: [...objects.keys()].filter((k) => k.includes(ev.id)) };
      },
      { evidenceStore: store },
    );
    expect(r.done).toBe(200);
    expect(r.c1).toMatchObject({ title: '（已注销）', description: '（已注销）' });
    expect(r.c2).toMatchObject({ title: '已公开标题', description: '公开陈述：提款被拒' });
    expect(r.e).toEqual({ gone: true, del: true, kept: true });
    expect(r.a).toEqual({ actorRole: 'admin', k: r.key, via: 'anonymize' });
    expect(r.counts).toMatchObject({ evidenceDeleted: 1, descriptionsOverwritten: 2 });
    expect(r.counts).not.toHaveProperty('evidenceKeys');
    expect(r.left).toEqual([]);
  });

  it('公开确认（契约 v0.2.2）：可一并修订标题（1–80 字），audit before / after 含标题；超长 400', async () => {
    const r = await withApp(async (app, tx) => {
      const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
      await close(tx, c.id);
      const [orig] = (await tx.execute(`select "title" from "complaint" where "id" = '${c.id}'`)) as { title: string }[];
      const body = (title?: string) => ({ ...(title !== undefined && { title }), publicDescription: '公开陈述', checklist: { noPersonalNames: true, noContactInfo: true, noAccountIds: true, noImagesWithFaces: true } });
      const long = (await app.request(`/admin/v1/complaints/${c.id}/publish`, as('u_102', 'POST', body('x'.repeat(81))))).status;
      const ok = (await app.request(`/admin/v1/complaints/${c.id}/publish`, as('u_102', 'POST', body('提款被拒（脱敏后标题）')))).status;
      const [row] = (await tx.execute(`select "title" from "complaint" where "id" = '${c.id}'`)) as { title: string }[];
      const [a] = (await tx.execute(`select "before"->>'title' as b, "after"->>'title' as af from "audit_log" where "action" = 'complaint_publish' and "targetId" = '${c.id}'`)) as Record<string, string>[];
      const keep = (await app.request(`/admin/v1/complaints/${c.id}/publish`, as('u_102', 'POST', body()))).status;
      const [row2] = (await tx.execute(`select "title" from "complaint" where "id" = '${c.id}'`)) as { title: string }[];
      return { long, ok, title: row!.title, a, keep, title2: row2!.title, original: orig!.title };
    });
    expect([r.long, r.ok, r.keep]).toEqual([400, 200, 200]);
    expect(r.title).toBe('提款被拒（脱敏后标题）');
    expect(r.a).toEqual({ b: r.original, af: '提款被拒（脱敏后标题）' });
    expect(r.title2).toBe('提款被拒（脱敏后标题）');
  });

  it('设备 180 天清理：只删已注销且超过保留期的用户的设备行；dryRun 只计数；未注销用户不动', async () => {
    const r = await withApp(async (app, tx) => {
      await mkUser(tx, 'u_dev_anon', [`insert into "device" ("id", "userId", "fingerprint") values ('dv_a', 'u_dev_anon', '${'1'.repeat(64)}')`]);
      await tx.execute('reset role');
      await tx.execute(`insert into "device" ("id", "userId", "fingerprint") values ('dv_live', 'u_233', '${'2'.repeat(64)}')`);
      await tx.execute('set local role bydp_app');
      const d = await createDataRequest(tx as never, 'u_dev_anon', { kind: 'anonymize' }, FRESH());
      await confirmAndDone(app, d.id);
      const kept180 = await purgeAnonymizedDevices(tx as never); // 刚注销：未满 180 天，不删
      // anonymizedAt 由守卫取服务端时间、不可回填：用负保留期模拟「已超过保留期」
      const dry = await purgeAnonymizedDevices(tx as never, { dryRun: true, retentionDays: -1 });
      const stillThere = (await tx.execute(`select count(*)::int as n from "device" where "id" = 'dv_a'`)) as { n: number }[];
      const deleted = await purgeAnonymizedDevices(tx as never, { retentionDays: -1 });
      const left = (await tx.execute(`select "id" from "device" where "id" in ('dv_a', 'dv_live') order by "id"`)) as { id: string }[];
      return { kept180, dry, stillThere: stillThere[0]!.n, deleted, left: left.map((x) => x.id) };
    });
    expect(r).toEqual({ kept180: 0, dry: 1, stillThere: 1, deleted: 1, left: ['dv_live'] });
  });

  it('Candidate 去刷（D-016 第 6 项）：未收录查询计入；同一 IP 网段一天只计 1 次；爬虫 UA 不计；后台按加权排序', async () => {
    const prev = process.env.IDENTITY_HMAC_KEY;
    process.env.IDENTITY_HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
    try {
      const r = await withApp(
        async (app) => {
          const q = (ip: string, ua = 'Mozilla/5.0 test') => app.request('/v1/check?q=never-seen-d016.com', { headers: { 'CF-Connecting-IP': ip, 'User-Agent': ua } });
          await q('203.0.113.10');
          await q('203.0.113.99'); // 同一 /24 网段：不重复计
          await q('198.51.100.7');
          await q('192.0.2.1', 'Googlebot/2.1'); // 爬虫不计
          for (const ip of ['100.1.1.1', '100.2.2.2', '100.3.3.3']) await app.request('/v1/check?q=hot-d016.com', { headers: { 'CF-Connecting-IP': ip, 'User-Agent': 'Mozilla/5.0' } });
          const last = await (await q('198.51.100.8')).json();
          const list = await (await app.request('/admin/v1/candidates', as('u_233'))).json();
          const arb = (await app.request('/admin/v1/candidates', as('u_102'))).status;
          return { cand: last.candidate, top: list.items.slice(0, 2).map((x: { value: string; weightedPriority: number }) => `${x.value}:${x.weightedPriority}`), arb };
        },
        { postback: { trustProxy: true } },
      );
      expect(r.cand).toMatchObject({ queryCount7d: 2, weightedPriority: 2 });
      expect(r.top).toEqual(['hot-d016.com:3', 'never-seen-d016.com:2']);
      expect(r.arb).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.IDENTITY_HMAC_KEY;
      else process.env.IDENTITY_HMAC_KEY = prev;
    }
  });

  it('死锁（40P01）识别：驱动错误与 drizzle 包装（cause）都能取到错误码', () => {
    expect(pgCode({ code: '40P01' })).toBe('40P01');
    expect(pgCode(Object.assign(new Error('Failed query'), { cause: { code: '40P01' } }))).toBe('40P01');
    expect(pgCode(new Error('x'))).toBeUndefined();
  });

  it('对象删除失败不静默：结案照常完成，写告警日志（evt + key）；对账任务重删仍存在的旧对象与预览缓存', async () => {
    const { objects, store } = mkStore();
    let failDelete = true;
    const flaky = { ...store, delete: async (k: string) => { if (failDelete) throw new Error('r2 down'); objects.delete(k); } };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(String(m)));
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'screenshot', content: PNG });
        const key = [...objects.keys()].find((k) => k.endsWith(ev.id))!;
        objects.set(`preview/${ev.id}/1.png`, PNG);
        const dr = await createDataRequest(tx as never, 'u_233', { kind: 'delete_evidence', evidenceIds: [ev.id] }, FRESH());
        await close(tx, c.id);
        const done = (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).status;
        const leftAfterFail = objects.has(key);
        failDelete = false;
        const rec = await reconcileDeletedObjects(tx as never, flaky);
        return { done, key, leftAfterFail, rec, leftAfterReconcile: [...objects.keys()].filter((k) => k.includes(ev.id)) };
      },
      { evidenceStore: flaky },
    );
    spy.mockRestore();
    expect(r.done).toBe(200);
    expect(r.leftAfterFail).toBe(true);
    const alert = errors.map((e) => { try { return JSON.parse(e); } catch { return null; } }).find((e) => e?.evt === 'evidence_object_delete_failed' && e.key === r.key);
    expect(alert).toMatchObject({ alert: true, via: 'delete_original', error: 'r2 down' });
    expect(r.rec.redeleted).toBeGreaterThanOrEqual(2); // 原文 + 预览第 1 页
    expect(r.leftAfterReconcile).toEqual([]);
  });

  it('注销前提（自检补）：不得执行本人的注销（回避 409）；最后一个管理员 409；其他待处理请求 409；过期临时排除与已结案投诉不拦，unresolved 拦', async () => {
    const r = await withApp(async (app, tx) => {
      // u_509 = 测试库唯一 admin：本人申请注销 → 本人执行回避；他人（另授 admin）执行 → 最后一个管理员
      const self = await createDataRequest(tx as never, 'u_509', { kind: 'anonymize' }, FRESH());
      const selfRes = await confirmAndDone(app, self.id);
      // 最后一个管理员：经 api 不可达（执行者必须是另一位 admin），并发互相注销时由锁内复核兜底——这里直接调 core 模拟
      const lastRes = await resolveDataRequest(tx as never, { put: async () => {} }, { id: 'u_concurrent', role: 'admin', ip: null }, self.id, 'done', null).catch((e: Error) => e.message);
      // 其他待处理请求
      await mkUser(tx, 'u_anon_or');
      await createDataRequest(tx as never, 'u_anon_or', { kind: 'export' }, FRESH());
      const d1 = await createDataRequest(tx as never, 'u_anon_or', { kind: 'anonymize' }, FRESH());
      const otherRes = await confirmAndDone(app, d1.id);
      // 过期临时排除（owner 回填过去时间）+ 已结案投诉：不拦
      await mkUser(tx, 'u_anon_ok', [
        `set local bydp.allow_backfill = 'on'`,
        `insert into "self_exclusion" ("id", "userId", "period", "startsAt") values ('se_old', 'u_anon_ok', '30', now() - interval '60 days')`,
      ]);
      const c = await submitComplaint(tx as never, 'u_anon_ok', COMPLAINT);
      await close(tx, c.id);
      const d2 = await createDataRequest(tx as never, 'u_anon_ok', { kind: 'anonymize' }, FRESH());
      const okRes = (await confirmAndDone(app, d2.id)).status;
      // unresolved 视为未结案
      await mkUser(tx, 'u_anon_un');
      const c2 = await submitComplaint(tx as never, 'u_anon_un', COMPLAINT);
      await tx.execute('reset role');
      await tx.execute(`update "complaint" set "status" = 'unresolved' where "id" = '${c2.id}'`);
      await tx.execute('set local role bydp_app');
      const d3 = await createDataRequest(tx as never, 'u_anon_un', { kind: 'anonymize' }, FRESH());
      const unRes = (await confirmAndDone(app, d3.id)).body.code;
      return { selfRes, lastRes, otherRes, okRes, unRes };
    });
    expect(r.selfRes).toEqual({ status: 409, body: { code: 'conflict_of_interest', message: '不得执行本人的注销请求（回避）' } });
    expect(r.lastRes).toBe('申请人是系统中最后一个管理员，须先把管理员角色交给他人再执行注销');
    expect(r.otherRes).toEqual({ status: 409, body: { code: 'invalid_argument', message: '申请人还有其他待处理的数据请求，请先处理完再执行注销' } });
    expect(r.okRes).toBe(200);
    expect(r.unRes).toBe('open_complaints');
  });

  it('注销后：已生成的导出包删除；绑定失效后同账号由新用户重绑，回传匹配只找到新绑定', async () => {
    const { objects, store } = mkStore();
    // 绑定只经 core createBinding 写（D-003 lint）；测试用固定密钥
    const KEY = 'test-key-for-api-admin-anonymize-0123456789';
    const PII = Buffer.alloc(32, 7);
    const bind = (tx: Tx, userId: string) => createBinding(tx as never, { userId, brandId: 'br_winner', operatorAccountId: 'RB-9', source: 'manual' }, KEY, PII);
    const r = await withApp(
      async (app, tx) => {
        await mkUser(tx, 'u_anon_ex');
        const old = await bind(tx, 'u_anon_ex');
        const ex = await createDataRequest(tx as never, 'u_anon_ex', { kind: 'export' }, FRESH());
        await app.request(`/admin/v1/data-requests/${ex.id}/resolve`, as('u_509', 'POST', { result: 'done' }));
        const pkgBefore = objects.has(`exports/u_anon_ex/${ex.id}.json`);
        const d = await createDataRequest(tx as never, 'u_anon_ex', { kind: 'anonymize' }, FRESH());
        const done = (await confirmAndDone(app, d.id)).status;
        const pkgAfter = objects.has(`exports/u_anon_ex/${ex.id}.json`);
        await mkUser(tx, 'u_rebind');
        const fresh = await bind(tx, 'u_rebind');
        const found = await findBindingByAccountHash(tx as never, 'br_winner', old!.operatorAccountIdHash);
        return { pkgBefore, done, pkgAfter, found: found && { same: found.id === fresh!.id, userId: found.userId } };
      },
      { evidenceStore: store },
    );
    expect(r).toEqual({ pkgBefore: true, done: 200, pkgAfter: false, found: { same: true, userId: 'u_rebind' } });
  });

  it('对账（脱敏分支）：旧原文仍在则重删；当前脱敏件与其预览缓存不动', async () => {
    const { objects, store } = mkStore();
    let failDelete = true;
    const flaky = { ...store, delete: async (k: string) => { if (failDelete) throw new Error('r2 down'); objects.delete(k); } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'screenshot', content: PNG });
        const orig = [...objects.keys()].find((k) => k.endsWith(ev.id))!;
        const dr = await createDataRequest(tx as never, 'u_233', { kind: 'redact_evidence', evidenceIds: [ev.id] }, FRESH());
        const fd = new FormData();
        fd.set('evidenceId', ev.id);
        fd.set('file', new File([PNG], 'r.png', { type: 'image/png' }));
        const up = (await app.request(`/admin/v1/data-requests/${dr.id}/redact`, { method: 'POST', headers: { 'X-Dev-User': 'u_509' }, body: fd })).status;
        objects.set(`preview/${ev.id}/1.png`, PNG); // 按脱敏件重新生成的预览
        failDelete = false;
        const rec = await reconcileDeletedObjects(tx as never, flaky);
        return { up, origGone: !objects.has(orig), redactedKept: objects.has(`${orig}.redacted`), previewKept: objects.has(`preview/${ev.id}/1.png`), rec };
      },
      { evidenceStore: flaky },
    );
    spy.mockRestore();
    expect(r).toMatchObject({ up: 200, origGone: true, redactedKept: true, previewKept: true });
    expect(r.rec.redeleted).toBeGreaterThanOrEqual(1);
  });

  it('删除原文：未结案 → 409（只能脱敏）；结案后 done → deletedAt、清空指向、删对象与预览缓存，哈希保留', async () => {
    const { objects, store } = mkStore();
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'screenshot', content: PNG });
        objects.set(`preview/${ev.id}/1.png`, PNG);
        const dr = await createDataRequest(tx as never, 'u_233', { kind: 'delete_evidence', evidenceIds: [ev.id] }, FRESH());
        const open = await (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).json();
        await close(tx, c.id);
        const done = (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).status;
        const [e] = (await tx.execute(`select "sha256" = '${ev.sha256}' as kept, "storageKey" is null as gone, "deletedAt" is not null as del from "evidence" where "id" = '${ev.id}'`)) as Record<string, boolean>[];
        return { open, done, e, objects: [...objects.keys()].filter((k) => k.includes(ev.id)) };
      },
      { evidenceStore: store },
    );
    expect(r.open).toEqual({ code: 'invalid_argument', message: '未结案案件的证据只能脱敏、不能删除原文（§9.2 v1.9）' });
    expect(r.done).toBe(200);
    expect(r.e).toEqual({ kept: true, gone: true, del: true });
    expect(r.objects).toEqual([]);
  });

  it('脱敏：未上传脱敏件 done → 409；上传脱敏件 → redacted + redactedSha256、旧原文对象删除；非本请求证据 → 409；之后 done → 200', async () => {
    const { objects, store } = mkStore();
    const r = await withApp(
      async (app, tx) => {
        const c = await submitComplaint(tx as never, 'u_233', COMPLAINT);
        const ev = await addEvidence(tx as never, store, 'u_233', c.id, { type: 'screenshot', content: PNG });
        const origKey = [...objects.keys()].find((k) => k.endsWith(ev.id))!;
        const dr = await createDataRequest(tx as never, 'u_233', { kind: 'redact_evidence', evidenceIds: [ev.id] }, FRESH());
        const early = (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).status;
        const up = (evId: string) => {
          const fd = new FormData();
          fd.set('evidenceId', evId);
          fd.set('file', new File([PNG], 'r.png', { type: 'image/png' }));
          return app.request(`/admin/v1/data-requests/${dr.id}/redact`, { method: 'POST', headers: { 'X-Dev-User': 'u_509' }, body: fd });
        };
        const wrong = (await up('ev_001')).status;
        const ok = (await up(ev.id)).status;
        const [e] = (await tx.execute(`select "redacted", "redactedSha256" is not null as h, "storageKey" from "evidence" where "id" = '${ev.id}'`)) as Record<string, unknown>[];
        const done = (await app.request(`/admin/v1/data-requests/${dr.id}/resolve`, as('u_509', 'POST', { result: 'done' }))).status;
        return { early, wrong, ok, e, origGone: !objects.has(origKey), newExists: objects.has(`${origKey}.redacted`), done };
      },
      { evidenceStore: store },
    );
    expect([r.early, r.wrong, r.ok, r.done]).toEqual([409, 409, 200, 200]);
    expect(r.e).toMatchObject({ redacted: true, h: true });
    expect([r.origGone, r.newExists]).toEqual([true, true]);
  });
});

describe.skipIf(!url)('admin 风控 / 看板 / 审核台骨架（第 2 轮下）', () => {
  it('风控：同设备多账号列表（账号取自设备表）；仅 admin；看板全部后台角色可读', async () => {
    const r = await withApp(async (app, tx) => {
      const fp = deviceFingerprint('abcdefabcdefabcdefabcdefabcdef12', Buffer.alloc(32, 3));
      await recordDeviceLogin(tx as never, { userId: 'u_102', fingerprint: fp });
      await recordDeviceLogin(tx as never, { userId: 'u_233', fingerprint: fp });
      const flags = await (await app.request('/admin/v1/risk/device-flags', as('u_509'))).json();
      return {
        flag: flags.items.find((x: { device: string }) => x.device === fp.slice(0, 16)),
        arb: (await app.request('/admin/v1/risk/device-flags', as('u_102'))).status,
        dash: await (await app.request('/admin/v1/dashboard', as('u_412'))).json(),
      };
    });
    expect(r.flag).toMatchObject({ accounts: 2, userIds: ['u_102', 'u_233'] });
    expect(r.arb).toBe(403);
    expect(Object.keys(r.dash).sort()).toEqual(
      ['awaitingFirstNotice', 'awaitingPublish', 'complaintsScreening', 'dataRequestsPending', 'deviceFlags7d', 'pendingExposureDecision', 'reviewPending', 'secondNoticeDue'].sort(),
    );
    expect(r.dash.deviceFlags7d).toBeGreaterThanOrEqual(1);
  });
  it('审核台：editor 看队列并决定；结构不合法的提议不能批准（409，仍待决）、可驳回（applied=false）；二次决定 409；仲裁员 403', async () => {
    const r = await withApp(async (app, tx) => {
      await tx.execute(`insert into "review_item" ("id","kind","subject","proposal","source") values ('ri_api','brand_attribute','br_jinlong','{"field":"licenseNo","value":"X-1"}','collector@0.1')`);
      const q = await (await app.request('/admin/v1/review-queue?kind=brand_attribute', as('u_233'))).json();
      const bad = await app.request('/admin/v1/review-queue/ri_api/decision', as('u_233', 'POST', { decision: 'approve' }));
      const [st] = (await tx.execute(`select "status" from "review_item" where "id" = 'ri_api'`)) as { status: string }[];
      const d = await (await app.request('/admin/v1/review-queue/ri_api/decision', as('u_233', 'POST', { decision: 'reject', note: '结构不对' }))).json();
      const again = (await app.request('/admin/v1/review-queue/ri_api/decision', as('u_233', 'POST', { decision: 'approve' }))).status;
      const arb = (await app.request('/admin/v1/review-queue', as('u_102'))).status;
      const [a] = (await tx.execute(`select "actorRole", "after"->>'applied' as applied from "audit_log" where "action" = 'review_item_decision' and "targetId" = 'ri_api'`)) as Record<string, string>[];
      return { listed: q.items.some((x: { id: string }) => x.id === 'ri_api'), bad: { status: bad.status, body: await bad.json() }, pending: st!.status, d, again, arb, a };
    });
    expect(r.listed).toBe(true);
    expect(r.bad).toEqual({ status: 409, body: { code: 'invalid_argument', message: '提议内容不符合该类型的结构，不能落地' } });
    expect(r.pending).toBe('pending');
    expect(r.d).toMatchObject({ id: 'ri_api', status: 'rejected', decidedBy: 'u_233', note: '结构不对' });
    expect([r.again, r.arb]).toEqual([409, 403]);
    expect(r.a).toEqual({ actorRole: 'editor', applied: 'false' });
  });

  it('审核台 approve 落地（D-016）：品牌属性 / 站点下线 / 换域名 / 条款变更 / 本地化（品牌名 + 内容）写入且 audit applied=true；初筛只是建议（applied=false）', async () => {
    const H = (c: string) => c.repeat(64);
    const items: [string, string, string, unknown][] = [
      ['ri_ba', 'brand_attribute', 'br_jinlong:payment', { brandId: 'br_jinlong', dimension: 'payment', values: ['USDT-TRC20', '银行卡', ' usdt-trc20 '], sourceUrl: 'https://jinlong88.com/pay', fetchedAt: '2026-10-03T00:00:00Z', snippet: '支持 USDT 与银行卡' }],
      ['ri_off', 'site_monitor', 'idf_001#offline', { type: 'offline', identifierId: 'idf_001', url: 'https://jinlong88.com/', consecutiveFailures: 3, lastErrors: ['timeout', 'timeout', 'ECONNREFUSED'] }],
      ['ri_dom', 'site_monitor', 'idf_001#domain_changed', { type: 'domain_changed', identifierId: 'idf_001', url: 'https://jinlong88.com/', newHost: 'www.jl-new-test.com', hops: [{ url: 'https://jinlong88.com/', status: 301 }, { url: 'https://jl-new-test.com/', status: 200 }] }],
      ['ri_terms', 'site_monitor', 'idf_001#terms_changed', { type: 'terms_changed', identifierId: 'idf_001', url: 'https://jinlong88.com/terms', previousHash: H('a'), currentHash: H('b') }],
      ['ri_scr', 'complaint_screening', 'cp_001', { complaintId: 'cp_001', suggest: 'reject', rules: [{ rule: 'duplicate_24h', note: '重复' }] }],
      ['ri_loc', 'localization', 'brand:br_jinlong:zh-Hant', { target: { type: 'brand_name', brandId: 'br_jinlong' }, locale: 'zh-Hant', engine: 'opencc', sourceText: '金龙', title: '金龍' }],
    ];
    const r = await withApp(async (app, tx) => {
      await tx.execute('reset role');
      await tx.execute(`insert into "content" ("id","type","key","locale","title","body") values ('ct_api','advice','api-key','zh-Hans','防骗','先查再存')`);
      await tx.execute(`update "brand" set "name" = "name" - 'zhHant' where "id" = 'br_jinlong'`); // seed 品牌都已有繁体名；落地只填空缺
      await tx.execute('set local role bydp_app');
      items.push(['ri_ct', 'localization', 'content:ct_api:zh-Hant', { target: { type: 'content', contentId: 'ct_api' }, locale: 'zh-Hant', engine: 'opencc', sourceText: '防骗\n\n先查再存', title: '防騙', body: '先查再存' }]);
      for (const [id, kind, subject, proposal] of items)
        await tx.execute(`insert into "review_item" ("id","kind","subject","proposal","source") values ('${id}','${kind}','${subject}','${JSON.stringify(proposal)}','test@0')`);
      const statuses: Record<string, number> = {};
      for (const [id] of items) statuses[id] = (await app.request(`/admin/v1/review-queue/${id}/decision`, as('u_233', 'POST', { decision: 'approve' }))).status;
      const one = async (s: string) => ((await tx.execute(s)) as Record<string, unknown>[])[0];
      return {
        statuses,
        ba: await one(`select "values", "source", "verified", "sourceUrl", "reviewItemId" from "brand_attribute" where "brandId" = 'br_jinlong' and "dimension" = 'payment'`), // 重复值已去重
        off: await one(`select "online" from "identifier" where "id" = 'idf_001'`),
        dom: await one(`select "ownership", "brandId" = (select "brandId" from "identifier" where "id" = 'idf_001') as "sameBrand" from "identifier" where "value" = 'jl-new-test.com'`),
        terms: await one(`select "values"[2] as h from "brand_attribute" where "brandId" = (select "brandId" from "identifier" where "id" = 'idf_001') and "dimension" = 'termsChanged'`),
        name: await one(`select "name"->>'zhHant' as t, "name"->>'zhHans' as s from "brand" where "id" = 'br_jinlong'`),
        ct: await one(`select "locale", "title", "sourceId" from "content" where "sourceId" = 'ct_api'`),
        cp: await one(`select "status" from "complaint" where "id" = 'cp_001'`),
        audit: Object.fromEntries(
          ((await tx.execute(`select "targetId", "after"->>'applied' as a from "audit_log" where "action" = 'review_item_decision' and "targetId" like 'ri_%'`)) as { targetId: string; a: string }[]).map((x) => [x.targetId, x.a]),
        ),
      };
    });
    expect(Object.values(r.statuses).every((s) => s === 200)).toBe(true);
    expect(r.ba).toEqual({ values: ['USDT-TRC20', '银行卡'], source: 'agent', verified: true, sourceUrl: 'https://jinlong88.com/pay', reviewItemId: 'ri_ba' });
    expect(r.off).toEqual({ online: false });
    expect(r.dom).toEqual({ ownership: 'pending', sameBrand: true });
    expect(r.terms).toEqual({ h: 'b'.repeat(64) });
    expect(r.name!.t).toBe('金龍');
    expect(r.ct).toEqual({ locale: 'zh-Hant', title: '防騙', sourceId: 'ct_api' });
    expect(r.cp!.status).not.toBe('rejected'); // 初筛建议不改案件状态
    expect(r.audit).toMatchObject({ ri_ba: 'true', ri_off: 'true', ri_dom: 'true', ri_terms: 'true', ri_loc: 'true', ri_ct: 'true', ri_scr: 'false' });
  });

  it('落地前置（自检）：对象与内容不一致 → 409；人工录入的品牌属性不被覆盖 → 409；已有该语种品牌名不覆盖 → 409；均保持待决', async () => {
    const r = await withApp(async (app, tx) => {
      const ins = (id: string, kind: string, subject: string, proposal: unknown) =>
        tx.execute(`insert into "review_item" ("id","kind","subject","proposal","source") values ('${id}','${kind}','${subject}','${JSON.stringify(proposal)}','test@0')`);
      // 显示的对象是 br_winner，实际内容写 br_jinlong
      await ins('ri_mis', 'brand_attribute', 'br_winner:payment', { brandId: 'br_jinlong', dimension: 'payment', values: ['USDT'], sourceUrl: 'https://x/p', fetchedAt: '2026-10-03T00:00:00Z' });
      await ins('ri_hum', 'brand_attribute', 'br_jinlong:withdrawalLimit', { brandId: 'br_jinlong', dimension: 'withdrawalLimit', values: ['无限额'], sourceUrl: 'https://x/l', fetchedAt: '2026-10-03T00:00:00Z' });
      await tx.execute('reset role');
      await tx.execute(`update "brand" set "name" = "name" || '{"zhHant":"人工繁體名"}'::jsonb where "id" = 'br_crown'`);
      await tx.execute('set local role bydp_app');
      await ins('ri_nm', 'localization', 'brand:br_crown:zh-Hant', { target: { type: 'brand_name', brandId: 'br_crown' }, locale: 'zh-Hant', engine: 'opencc', sourceText: 'x', title: 'y' });
      const out: Record<string, unknown> = {};
      for (const id of ['ri_mis', 'ri_hum', 'ri_nm']) {
        const res = await app.request(`/admin/v1/review-queue/${id}/decision`, as('u_233', 'POST', { decision: 'approve' }));
        out[id] = { status: res.status, message: (await res.json()).message };
      }
      const st = (await tx.execute(`select string_agg("status"::text, ',' order by "id") as s from "review_item" where "id" in ('ri_mis','ri_hum','ri_nm')`)) as { s: string }[];
      return { out, st: st[0]!.s };
    });
    expect(r.out).toEqual({
      ri_mis: { status: 409, message: '提议的对象与内容不一致，不能落地' },
      ri_hum: { status: 409, message: '该维度已有人工录入的数据，Agent 提议不能覆盖，请人工合并' },
      ri_nm: { status: 409, message: '该品牌已有此语种的名称，请人工处理' },
    });
    expect(r.st).toBe('pending,pending,pending');
  });

  it('案件详情带最近一条初筛建议；通知补推扫描只取未送达且未跳过、15 分钟以上 7 天以内的通知', async () => {
    const r = await withApp(async (app, tx) => {
      await tx.execute(`insert into "review_item" ("id","kind","subject","proposal","source") values ('ri_cs','complaint_screening','cp_001','{"complaintId":"cp_001","suggest":"needs_info","rules":[{"rule":"missing_amount","note":"金额为 0"}]}','screening-rules@0.1')`);
      const d = await (await app.request('/admin/v1/complaints/cp_001', as('u_102'))).json();
      await tx.execute('reset role');
      await tx.execute(`set local bydp.allow_backfill = 'on'`);
      await tx.execute(`insert into "notification" ("id","userId","type","title","sentAt") values
        ('nt_old','u_233','t','a', now() - interval '1 hour'), ('nt_new','u_233','t','b', now()), ('nt_ancient','u_233','t','c', now() - interval '8 days')`);
      await tx.execute(`insert into "notification" ("id","userId","type","title","sentAt","skippedAt","skipReason") values ('nt_skip','u_233','t','d', now() - interval '1 hour', now(), 'tg_blocked')`);
      await tx.execute('set local role bydp_app');
      const ids = await listUndeliveredNotifications(tx as never);
      return { screening: d.screening, ids: ids.filter((x) => x.startsWith('nt_') && ['nt_old', 'nt_new', 'nt_ancient', 'nt_skip'].includes(x)) };
    });
    expect(r.screening).toMatchObject({ reviewItemId: 'ri_cs', status: 'pending', suggest: 'needs_info', rules: [{ rule: 'missing_amount', note: '金额为 0' }] });
    expect(r.ids).toEqual(['nt_old']);
  });
});

describe.skipIf(!url)('D-018 品牌状态变更（契约 v0.4.0）', () => {
  const at = (user: string, ageSec: number, method = 'GET', body?: unknown): RequestInit => {
    const init = as(user, method, body);
    return { ...init, headers: { ...(init.headers as Record<string, string>), 'X-Dev-Auth-Time': String(Math.floor(Date.now() / 1000) - ageSec) } };
  };
  const BODY = { to: 'blacklist', reason: '多名用户提款被拒且运营商未答辩', evidenceCaseIds: [] as string[] };

  it('权限：editor / commerce → 403；仲裁员可读列表；10 分钟外 → 401 reauth_required；同状态 → 409 invalid_transition；原因空 → 400', async () => {
    const r = await withApp(async (app) => {
      const post = (init: RequestInit) => app.request('/admin/v1/brands/br_jinlong/status', init);
      return {
        editor: (await post(as('u_233', 'POST', BODY))).status,
        commerce: (await post(as('u_412', 'POST', BODY))).status,
        editorList: (await app.request('/admin/v1/brands', as('u_233'))).status,
        arbList: (await (await app.request('/admin/v1/brands?q=jinlong', as('u_102'))).json()) as { items: { id: string; status: string }[] },
        stale: [(await post(at('u_509', 11 * 60, 'POST', BODY))).status, await (await post(at('u_509', 11 * 60, 'POST', BODY))).json()],
        same: await (await post(as('u_509', 'POST', { ...BODY, to: 'certified' }))).json(),
        emptyReason: (await post(as('u_509', 'POST', { ...BODY, reason: '   ' }))).status,
        foreignCase: await (await post(as('u_509', 'POST', { ...BODY, evidenceCaseIds: ['cp_002'] }))).json(),
        missing: (await app.request('/admin/v1/brands/br_nope/status', as('u_509', 'POST', BODY))).status,
        banned: await (await post(as('u_509', 'POST', { ...BODY, reason: '疑似跑路' }))).json(),
        personal: await (await post(as('u_509', 'POST', { ...BODY, reason: '联系人 13800000000 称拒付' }))).json(),
        badJson: (await post({ method: 'POST', headers: { 'X-Dev-User': 'u_509', 'Content-Type': 'application/json' }, body: '{' })).status,
        likeEscaped: ((await (await app.request('/admin/v1/brands?q=%25', as('u_509'))).json()) as { items: unknown[] }).items.length,
      };
    });
    expect([r.editor, r.commerce, r.editorList]).toEqual([403, 403, 403]);
    expect(r.arbList.items.map((b) => [b.id, b.status])).toEqual([['br_jinlong', 'certified']]);
    expect(r.stale).toEqual([401, { error: 'reauth_required', message: '该操作需 10 分钟内重新登录' }]);
    expect(r.same).toEqual({ code: 'invalid_transition', message: '品牌已是「平台认证」' });
    expect(r.emptyReason).toBe(400);
    expect(r.foreignCase).toEqual({ code: 'invalid_argument', message: '依据案件须为该品牌的案件' });
    expect(r.missing).toBe(404);
    expect(r.banned).toEqual({ code: 'invalid_argument', message: '原因含不可对外使用的措辞（如「黑盘」「跑路」），请改用中性描述' });
    expect(r.personal).toEqual({ code: 'invalid_argument', message: '原因会推送给订阅者，不得包含电话、邮箱、账号或链接等个人信息' });
    expect(r.badJson).toBe(400);
    expect(r.likeEscaped).toBe(0);
  });

  it('裁定收紧（§9.2 v1.15）：转认证 / 离开黑名单只限 admin；关联方永不认证 → 409 related_party；未登记保证金 → 409；金额数字不误拦', async () => {
    const r = await withApp(async (app, tx) => {
      const st = async (user: string, id: string, to: string, reason = '依据仲裁结论调整') => {
        const res = await app.request(`/admin/v1/brands/${id}/status`, as(user, 'POST', { to, reason }));
        return [res.status, res.status === 200 ? ((await res.json()) as { status: string }).status : ((await res.json()) as { code: string }).code];
      };
      return {
        arbLeaveBlacklist: await st('u_102', 'br_caishen', 'watch'),
        arbToCertified: await st('u_102', 'br_winner', 'certified'),
        arbCertifiedToWatch: await st('u_102', 'br_royal', 'watch'),
        arbToBlacklist: await st('u_102', 'br_starlight', 'blacklist'),
        relatedParty: await st('u_509', 'br_crown', 'certified'),
        noDeposit: await st('u_509', 'br_longteng', 'certified'),
        adminLeaveBlacklist: await st('u_509', 'br_caishen', 'watch', '运营商已补发全部提款 12345678 USDT，转观察'),
        adminBackToCertified: await st('u_509', 'br_royal', 'certified'),
        auditRole: (await tx.execute(`select "actorRole" from "audit_log" where "action" = 'brand_status_change' and "targetId" = 'br_caishen'`)) as unknown[],
      };
    });
    expect(r.arbLeaveBlacklist).toEqual([403, 'forbidden']);
    expect(r.arbToCertified).toEqual([403, 'forbidden']);
    expect(r.arbCertifiedToWatch).toEqual([200, 'watch']);
    expect(r.arbToBlacklist).toEqual([200, 'blacklist']);
    expect(r.relatedParty).toEqual([409, 'related_party']);
    expect(r.noDeposit).toEqual([409, 'invalid_argument']);
    expect(r.adminLeaveBlacklist).toEqual([200, 'watch']);
    expect(r.adminBackToCertified).toEqual([200, 'certified']);
    expect(r.auditRole).toEqual([{ actorRole: 'admin' }]);
  });

  it('黑名单连带①：Offer 下架（品牌页与全站列表）', async () => {
    const r = await withApp(async (app) => {
      const n = async () => ((await (await app.request('/v1/brands/jinlong/offers')).json()) as unknown[]).length;
      const before = await n();
      const st = (await app.request('/admin/v1/brands/br_jinlong/status', as('u_509', 'POST', BODY))).status;
      return { before, st, after: await n() };
    });
    expect(r.before).toBeGreaterThan(0);
    expect([r.st, r.after]).toEqual([200, 0]);
  });

  it('黑名单连带②：评分置 null（confidence = none）；转回观察后评分恢复', async () => {
    const r = await withApp(async (app) => {
      const score = async () => ((await (await app.request('/v1/brands/jinlong')).json()) as { score: { score: number | null; confidence: string } | null }).score;
      const before = await score();
      await app.request('/admin/v1/brands/br_jinlong/status', as('u_509', 'POST', BODY));
      const black = await score();
      await app.request('/admin/v1/brands/br_jinlong/status', as('u_509', 'POST', { to: 'watch', reason: '运营商已补发提款，转观察' }));
      return { before, black, watch: await score() };
    });
    expect(r.before?.score).not.toBeNull();
    expect(r.black).toMatchObject({ score: null, confidence: 'none' });
    expect(r.watch?.score).toBe(r.before?.score);
  });

  it('通知：既订阅又有进行中案件的用户只收一条；未配置站点地址时省略「查看」', async () => {
    const r = await withApp(async (app, tx) => {
      await submitComplaint(tx as never, 'u_102', { ...COMPLAINT, brandId: 'br_jinlong' }); // u_102 已订阅 br_jinlong
      await app.request('/admin/v1/brands/br_jinlong/status', as('u_509', 'POST', { to: 'watch', reason: '近期提款延迟投诉增多' }));
      return (await tx.execute(`select "userId", "body" from "notification" where "type" = 'brand_status_changed'`)) as { userId: string; body: string }[];
    });
    expect(r.map((n) => n.userId)).toEqual(['u_102']);
    expect(r[0]!.body).toBe(`金龙娱乐城 的 BYDP 状态由 平台认证 变更为 观察（${new Date().toISOString().slice(0, 10)}）。依据：近期提款延迟投诉增多。`);
  });

  it('转入黑名单：同事务改状态 + status_history + audit；Offer 下架、评分 null；订阅者与进行中案件投诉人各收一条中性通知并入队', async () => {
    const notify = vi.fn(async (_ids: string[]) => {});
    const r = await withApp(
      async (app, tx) => {
        const open = await submitComplaint(tx as never, 'u_233', { ...COMPLAINT, brandId: 'br_jinlong' });
        const before = {
          offers: ((await (await app.request('/v1/brands/jinlong/offers')).json()) as unknown[]).length,
          score: ((await (await app.request('/v1/brands/jinlong')).json()) as { score: { score: number | null } | null }).score?.score ?? null,
        };
        const res = await app.request('/admin/v1/brands/br_jinlong/status', as('u_102', 'POST', { ...BODY, evidenceCaseIds: [open.id] }));
        const body = (await res.json()) as { status: string; statusSince: string; subscribers: number; openComplaints: number };
        const detail = (await (await app.request('/v1/brands/jinlong')).json()) as { status: string; score: { score: number | null; confidence: string } | null };
        const allOffers = (await (await app.request('/v1/offers')).json()) as { items?: { brand?: { slug: string } }[] } | { brand?: { slug: string } }[];
        const list = Array.isArray(allOffers) ? allOffers : (allOffers.items ?? []);
        const hist = (await tx.execute(`select "from", "to", "reason", "actor" from "status_history" where "brandId" = 'br_jinlong' order by "id" desc limit 1`)) as unknown[];
        const audit = (await tx.execute(
          `select "actorRole", "before"->>'status' as b, "after"->>'status' as a, "after"->'evidenceCaseIds' as ev from "audit_log" where "action" = 'brand_status_change' and "targetId" = 'br_jinlong'`,
        )) as unknown[];
        const notes = (await tx.execute(
          `select "userId", "title", "body" from "notification" where "type" = 'brand_status_changed' order by "userId"`,
        )) as { userId: string; title: string; body: string }[];
        return { before, status: res.status, body, detail, jinlongOffers: list.filter((o) => o.brand?.slug === 'jinlong').length, hist, audit, notes, openId: open.id };
      },
      { notify, siteUrl: 'https://bydp.example' },
    );
    expect(r.before.offers).toBeGreaterThan(0);
    expect(r.before.score).not.toBeNull();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'blacklist', statusSince: new Date().toISOString().slice(0, 10), subscribers: 1, openComplaints: 1 });
    expect(r.detail.status).toBe('blacklist');
    expect(r.detail.score).toMatchObject({ score: null, confidence: 'none' });
    expect(r.jinlongOffers).toBe(0);
    expect(r.hist).toEqual([{ from: 'certified', to: 'blacklist', reason: BODY.reason, actor: 'u_102' }]);
    expect(r.audit).toEqual([{ actorRole: 'arbitrator', b: 'certified', a: 'blacklist', ev: [r.openId] }]);
    const date = new Date().toISOString().slice(0, 10);
    expect(r.notes.map((n) => n.userId)).toEqual(['u_102', 'u_233']);
    expect(r.notes[0]!.body).toBe(`金龙娱乐城 的 BYDP 状态由 平台认证 变更为 黑名单（${date}）。依据：${BODY.reason}。查看：https://bydp.example/brand/jinlong`);
    for (const n of r.notes) expect(n.body).not.toMatch(/黑盘|跑路|保险|留存率/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toHaveLength(2);
  });
});

describe.skipIf(!url)('A-018 Offer 上线 / 下线（契约 v0.5.0）', () => {
  it('仲裁员可看不可改（403）；admin 下线 → 公开列表消失 + audit；同状态 409；黑名单期间上线 → 409（数据库约束精确映射）；解除黑名单后人工上线', async () => {
    const r = await withApp(async (app, tx) => {
      const list = (await (await app.request('/admin/v1/brands/br_jinlong/offers', as('u_102'))).json()) as { items: { id: string; status: string }[] };
      const arbWrite = (await app.request('/admin/v1/offers/of_001/status', as('u_102', 'POST', { to: 'offline', reason: 'x' }))).status;
      const off = (await (await app.request('/admin/v1/offers/of_001/status', as('u_509', 'POST', { to: 'offline', reason: '运营商暂停活动' }))).json()) as { status: string };
      const pub = ((await (await app.request('/v1/brands/jinlong/offers')).json()) as { id: string }[]).map((o) => o.id);
      const same = await (await app.request('/admin/v1/offers/of_001/status', as('u_509', 'POST', { to: 'offline', reason: 'x' }))).json();
      await app.request('/admin/v1/brands/br_jinlong/status', as('u_509', 'POST', { to: 'blacklist', reason: '多起提款被拒且未答辩' }));
      const blocked = await (await app.request('/admin/v1/offers/of_001/status', as('u_509', 'POST', { to: 'active', reason: '恢复' }))).json();
      await app.request('/admin/v1/brands/br_jinlong/status', as('u_509', 'POST', { to: 'watch', reason: '运营商已补发提款' }));
      const stillOff = ((await (await app.request('/admin/v1/brands/br_jinlong/offers', as('u_509'))).json()) as { items: { status: string }[] }).items.map((o) => o.status);
      const back = (await app.request('/admin/v1/offers/of_001/status', as('u_509', 'POST', { to: 'active', reason: '核实后恢复' }))).status;
      const audit = (await tx.execute(`select "actorRole", "before"->>'status' as b, "after"->>'status' as a from "audit_log" where "action" = 'offer_status_change' and "targetId" = 'of_001' order by "at", "id"`)) as unknown[];
      return { list: list.items.map((o) => o.id), arbWrite, off: off.status, pub, same, blocked, stillOff, back, audit };
    });
    expect(r.list).toContain('of_001');
    expect(r.arbWrite).toBe(403);
    expect(r.off).toBe('offline');
    expect(r.pub).not.toContain('of_001');
    expect(r.same).toEqual({ code: 'invalid_transition', message: '优惠已是「下线」' });
    expect(r.blocked).toEqual({ code: 'invalid_transition', message: '品牌在黑名单中，优惠不能上线' });
    expect(r.stillOff.every((s) => s === 'offline')).toBe(true);
    expect(r.back).toBe(200);
    expect(r.audit).toEqual([
      { actorRole: 'admin', b: 'active', a: 'offline' },
      { actorRole: 'admin', b: 'offline', a: 'active' },
    ]);
  });

  it('pgConstraint 只认命名约束（经 drizzle cause 包装也能取到）', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('x'), { code: '23514', constraint_name: 'offer_blacklisted_brand_inactive' }) });
    expect(pgConstraint(wrapped)).toBe('offer_blacklisted_brand_inactive');
    expect(pgConstraint(new Error('plain'))).toBeUndefined();
  });
});
