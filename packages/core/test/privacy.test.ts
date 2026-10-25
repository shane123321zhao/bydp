/**
 * 限额提醒偏好 + 数据请求（A-011 · 契约 /me/preferences、/me/data-requests）。已迁移 + seed 的库；事务内执行后回滚；以 bydp_app 执行。
 * seed：u_233 的案件 cp_002 有证据 ev_001 / ev_002（已脱敏）、ev_003（未脱敏）；u_102 的 cp_001 有 ev_004。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MeInputError } from '../src/identity/me';
import { createDataRequest, getPreferences, listMyDataRequests, putPreferences, ReauthRequiredError } from '../src/identity/privacy';

/** 刚登录的会话（注销二次验证用） */
const FRESH = { authTime: Math.floor(Date.now() / 1000) };

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
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
const targets = async (tx: Tx, id: string) =>
  ((await tx.execute(sql`select "targetIds" as t from "data_request" where "id" = ${id}`)) as unknown as { t: string[] }[])[0]!.t;

describe.skipIf(!url)('限额提醒偏好', () => {
  it('无记录全关；写入后读回；再写整体替换', async () => {
    const r = await inTx(async (tx) => {
      const none = await getPreferences(tx, 'u_509');
      await putPreferences(tx, 'u_509', { dailyDepositAlertUsdt: 500, sessionAlertMinutes: 120, nightAlert: false });
      const replaced = await putPreferences(tx, 'u_509', { dailyDepositAlertUsdt: null, sessionAlertMinutes: 120, nightAlert: true });
      return { none, replaced, read: await getPreferences(tx, 'u_509') };
    });
    expect(r.none).toEqual({ dailyDepositAlertUsdt: null, sessionAlertMinutes: null, nightAlert: false });
    expect(r.replaced).toEqual({ dailyDepositAlertUsdt: null, sessionAlertMinutes: 120, nightAlert: true });
    expect(r.read).toEqual(r.replaced);
  });
});

describe.skipIf(!url)('数据请求', () => {
  it('脱敏未指定证据 → 取本人原文仍在且未脱敏的证据；删除未指定 → 本人未删除的全部证据；并发站内确认通知', async () => {
    const r = await inTx(async (tx) => {
      const redact = await createDataRequest(tx, 'u_233', { kind: 'redact_evidence' }, FRESH);
      const del = await createDataRequest(tx, 'u_233', { kind: 'delete_evidence', note: '案件已结，删除原图' }, FRESH);
      const notes = (await tx.execute(
        sql`select "title", "body" from "notification" where "userId" = 'u_233' and "type" = 'data_request' order by "sentAt", "id"`,
      )) as unknown as { title: string; body: string }[];
      return { redact, del, rt: await targets(tx, redact.id), dt: await targets(tx, del.id), notes, list: await listMyDataRequests(tx, 'u_233') };
    });
    expect(r.rt).toEqual(['ev_003']);
    expect([...r.dt].sort()).toEqual(['ev_001', 'ev_002', 'ev_003']);
    expect(r.redact.notificationIds).toHaveLength(1);
    expect(r.notes.map((n) => n.title).sort()).toEqual(['已收到你的数据请求：删除证据原文', '已收到你的数据请求：证据原文脱敏']);
    expect(r.notes[0]!.body).toMatch(/处理期 7 天/);
    expect(r.list.map((x) => [x.kind, x.status]).sort()).toEqual([
      ['delete_evidence', 'pending'],
      ['redact_evidence', 'pending'],
    ]);
  });

  it('他人证据 → 拒；非证据类带证据 → 拒；无可处理证据 → 拒；备注超长 → 拒', async () => {
    const r = await inTx(async (tx) => ({
      other: await createDataRequest(tx, 'u_233', { kind: 'delete_evidence', evidenceIds: ['ev_004'] }, FRESH).catch((e) => e),
      exportIds: await createDataRequest(tx, 'u_233', { kind: 'export', evidenceIds: ['ev_003'] }, FRESH).catch((e) => e),
      none: await createDataRequest(tx, 'u_509', { kind: 'redact_evidence' }, FRESH).catch((e) => e),
      long: await createDataRequest(tx, 'u_233', { kind: 'export', note: 'x'.repeat(201) }, FRESH).catch((e) => e),
    }));
    for (const e of Object.values(r)) expect(e).toBeInstanceOf(MeInputError);
  });

  it('同类请求处理中不重复创建（返回原请求、不再发通知）；注销请求可提交', async () => {
    const r = await inTx(async (tx) => {
      const a = await createDataRequest(tx, 'u_233', { kind: 'export' }, FRESH);
      const b = await createDataRequest(tx, 'u_233', { kind: 'export' }, FRESH);
      const anon = await createDataRequest(tx, 'u_233', { kind: 'anonymize', note: '不再使用' }, FRESH);
      return { a, b, anon };
    });
    expect(r.b).toEqual({ id: r.a.id, kind: 'export', created: false, notificationIds: [] });
    expect(r.anon).toMatchObject({ kind: 'anonymize', created: true });
  });

  it('注销二次验证（D-014，web 与 Bearer 共用）：会话签发超过 10 分钟 / 无 authTime → ReauthRequiredError，不落库；10 分钟内 → 通过', async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await inTx(async (tx) => {
      const stale = await createDataRequest(tx, 'u_233', { kind: 'anonymize' }, { authTime: now - 11 * 60, nowSec: now }).catch((e) => e);
      const missing = await createDataRequest(tx, 'u_233', { kind: 'anonymize' }, { authTime: undefined, nowSec: now }).catch((e) => e);
      const [n] = (await tx.execute(sql`select count(*)::int as n from "data_request" where "userId" = 'u_233' and "kind" = 'anonymize'`)) as unknown as { n: number }[];
      const fresh = await createDataRequest(tx, 'u_233', { kind: 'anonymize' }, { authTime: now - 9 * 60, nowSec: now });
      // 非注销请求不要求近期登录
      const exp = await createDataRequest(tx, 'u_233', { kind: 'export' }, { authTime: now - 20 * 86400, nowSec: now });
      return { stale, missing, n: n!.n, fresh, exp };
    });
    expect(r.stale).toBeInstanceOf(ReauthRequiredError);
    expect(r.missing).toBeInstanceOf(ReauthRequiredError);
    expect(r.n).toBe(0);
    expect(r.fresh.created).toBe(true);
    expect(r.exp.created).toBe(true);
  });
});
