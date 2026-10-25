/** handlePostback 编排 + 绑定「回传确认」升级（A-007 §2 / §6）。每例事务内执行后回滚；被测代码以 bydp_app 执行。 */
import { createDb, sql } from '@bydp/db';
import { commissionStatus, signPostback } from '@bydp/tracking';
import { afterAll, describe, expect, it } from 'vitest';
import { handlePostback } from '../src/commerce/tracking';
import { createBinding } from '../src/identity/bindings';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());

/** 与 packages/db/src/seed/build.ts SEED_BINDING_HMAC_KEY 相同（seed 绑定哈希用它计算；仅测试） */
const SEED_KEY = 'bydp-seed-only-test-key-not-for-production-0001';
const SECRET = 'w'.repeat(40);
const ENV = { POSTBACK_SECRET_WINNER: SECRET };
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local bydp.allow_backfill = 'on'`);
      await tx.execute(sql`insert into "operator_integration" ("id","brandId","postbackSecretRef") values ('oi_w','br_winner','POSTBACK_SECRET_WINNER')`);
      await tx.execute(sql`insert into "commission_term" ("id","brandId","mode","cpaUsdt","validFrom") values ('ct_w','br_winner','cpa',30,'2026-01-01')`);
      await tx.execute(sql`insert into "click" ("id","brandId","userId","createdAt") values ('clk_w','br_winner','u_233', now() - interval '3 days')`);
      await tx.execute(sql`insert into "click" ("id","brandId","userId","createdAt") values ('clk_x','br_winner','u_102', now() - interval '2 days')`);
      await tx.execute(sql`insert into "click" ("id","brandId","createdAt") values ('clk_j','br_jinlong', now() - interval '1 day')`);
      await tx.execute(sql`set local role bydp_app`);
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

function signed(body: object, opts: { secret?: string; skewSec?: number; tamper?: boolean } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) + (opts.skewSec ?? 0));
  const signature = signPostback(opts.secret ?? SECRET, timestamp, rawBody);
  return { brandId: 'br_winner', timestamp, signature, rawBody: opts.tamper ? rawBody.replace('first_deposit', 'deposit') : rawBody };
}
const post = (tx: Tx, req: ReturnType<typeof signed>, env: Record<string, string> = ENV) => handlePostback(tx, req, { env, bindingHmacKey: SEED_KEY });
const level = async (tx: Tx, id: string) =>
  ((await tx.execute(sql`select "verificationLevel" as l, "postbackAt" is not null as p from "user_brand_binding" where "id" = ${id}`)) as unknown as { l: string; p: boolean }[])[0]!;

// ubb_002：u_233 @ br_winner，账号 WS***9021，自报级，绑定于 2026-08-14（seed）；clk_w 是 u_233 本人的点击
const DEPOSIT = { externalEventId: 'w-1', event: 'first_deposit', operatorAccountId: 'WS***9021', amountUsdt: 100, clickId: 'clk_w' };

describe.skipIf(!url)('handlePostback', () => {
  it('四条件齐备：验签 + 哈希匹配绑定 + 绑定早于回传 + 回传自带 clickId 属绑定用户本人 → 升为回传确认；CPA 佣金', async () => {
    const pts = async (tx: Tx) =>
      (await tx.execute(sql`select "event", "points", "refId", "dedupeKey" from "points_event" where "userId" = 'u_233' order by "createdAt"`)) as unknown as Record<string, unknown>[];
    const r = await inTx(async (tx) => {
      const out = await post(tx, signed(DEPOSIT));
      const lv = await level(tx, 'ubb_002');
      const after = await pts(tx);
      await post(tx, signed({ ...DEPOSIT, externalEventId: 'w-2' })); // 已是回传确认：不再升级、不重复发分
      return { out, lv, after, again: await pts(tx) };
    });
    expect(r.out).toMatchObject({ ok: true, binding: 'upgraded', commission: { status: 'created', termId: 'ct_w', model: 'cpa', amountUsdt: 30 } });
    // A-010：回传确认 +500（每用户每品牌一次）
    expect(r.after).toEqual([{ event: 'binding_confirmed', points: 500, refId: 'ubb_002', dedupeKey: 'binding_confirmed:u_233:br_winner' }]);
    expect(r.again).toEqual(r.after);
    expect(r.out.ok && r.out.conversion.status === 'recorded' && r.out.conversion.conversion.clickId).toBe('clk_w');
    expect(r.lv).toEqual({ l: 'postback_confirmed', p: true });
  });

  it('K1 攻击路径：自报他人账号，真实主人经别人的领码链接充值（clickId 属他人）→ 不升级', async () => {
    const r = await inTx(async (tx) => ({ out: await post(tx, signed({ ...DEPOSIT, clickId: 'clk_x' })), lv: await level(tx, 'ubb_002') }));
    expect(r.out).toMatchObject({ ok: true, binding: 'no_click_proof' });
    expect(r.lv).toEqual({ l: 'self_reported', p: false });
  });

  it('K1：不带 clickId 靠哈希兜底归因 → 转化照记、归因到绑定用户末次点击，但不升级', async () => {
    const r = await inTx(async (tx) => {
      const { clickId: _omit, ...noClick } = DEPOSIT;
      return { out: await post(tx, signed(noClick)), lv: await level(tx, 'ubb_002') };
    });
    expect(r.out).toMatchObject({ ok: true, binding: 'no_click_proof' });
    expect(r.out.ok && r.out.conversion.status === 'recorded' && r.out.conversion.conversion.clickId).toBe('clk_w');
    expect(r.lv).toEqual({ l: 'self_reported', p: false });
  });

  it('缺条件 ①：签名不通过（篡改 / 过期 / 错密钥）→ 401，不写转化、不升级', async () => {
    const r = await inTx(async (tx) => {
      const outs = [await post(tx, signed(DEPOSIT, { tamper: true })), await post(tx, signed(DEPOSIT, { skewSec: -301 })), await post(tx, signed(DEPOSIT, { secret: 'x'.repeat(40) }))];
      const [n] = (await tx.execute(sql`select count(*)::int as n from "conversion"`)) as unknown as { n: number }[];
      return { outs, n: n!.n, lv: await level(tx, 'ubb_002') };
    });
    expect(r.outs.map((o) => (o.ok ? 'ok' : `${o.httpStatus}:${o.reason}`))).toEqual(['401:bad_signature', '401:stale', '401:bad_signature']);
    expect(r.n).toBe(0);
    expect(r.lv).toEqual({ l: 'self_reported', p: false });
  });

  it('缺条件 ②：账号哈希匹配不到绑定 → 不升级、不自动创建绑定', async () => {
    const r = await inTx(async (tx) => {
      const out = await post(tx, signed({ ...DEPOSIT, operatorAccountId: 'WS-OTHER' }));
      const [n] = (await tx.execute(sql`select count(*)::int as n from "user_brand_binding" where "brandId" = 'br_winner'`)) as unknown as { n: number }[];
      return { out, n: n!.n, lv: await level(tx, 'ubb_002') };
    });
    expect(r.out).toMatchObject({ ok: true, binding: 'no_binding' });
    expect(r.n).toBe(1);
    expect(r.lv.l).toBe('self_reported');
  });

  it('缺条件 ③：绑定时间不早于回传（同一时刻新建的绑定）→ 不升级', async () => {
    const r = await inTx(async (tx) => {
      const b = await createBinding(tx, { userId: 'u_102', brandId: 'br_winner', operatorAccountId: 'WS-NEW', source: 'manual' }, SEED_KEY);
      const out = await post(tx, signed({ ...DEPOSIT, operatorAccountId: 'WS-NEW', clickId: 'clk_x' })); // clk_x 属 u_102 本人，只缺条件 ③
      return { out, lv: await level(tx, b.id) };
    });
    expect(r.out).toMatchObject({ ok: true, binding: 'not_eligible' });
    expect(r.lv.l).toBe('self_reported');
  });

  it('只升不降：运营商确认级不被回传改动', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`reset role`);
      // eslint-disable-next-line no-restricted-syntax -- 测试夹具：以表 owner 身份把绑定预置为运营商确认级（事务回滚）
      await tx.execute(sql`update "user_brand_binding" set "verificationLevel" = 'operator_confirmed' where "id" = 'ubb_002'`);
      await tx.execute(sql`set local role bydp_app`);
      return { out: await post(tx, signed(DEPOSIT)), lv: await level(tx, 'ubb_002') };
    });
    expect(r.out).toMatchObject({ ok: true, binding: 'not_eligible' });
    expect(r.lv.l).toBe('operator_confirmed');
  });

  it('幂等回传 200 不重复处理；冲正 → 佣金 void、不触发绑定升级', async () => {
    const r = await inTx(async (tx) => {
      const first = await post(tx, signed(DEPOSIT));
      const dup = await post(tx, signed(DEPOSIT));
      const rev = await post(tx, signed({ externalEventId: 'w-r1', event: 'reversal', operatorAccountId: 'WS***9021', reversesExternalEventId: 'w-1' }));
      const cm = first.ok && first.commission?.status === 'created' ? first.commission.commissionId : '';
      return { first, dup, rev, st: await commissionStatus(tx, cm) };
    });
    expect(r.first.ok).toBe(true);
    expect(r.dup).toMatchObject({ ok: true, httpStatus: 200, conversion: { status: 'duplicate' }, commission: null });
    expect(r.rev).toMatchObject({ ok: true, binding: 'skipped', commission: { status: 'voided' } });
    expect(r.st).toBe('void');
  });

  it('错误映射：无对接 / 密钥缺失 401 · 非 JSON / 不合规 400 · 跨品牌 clickId 400 · 冲正原行不存在 409', async () => {
    const r = await inTx(async (tx) => {
      const bad = signed(DEPOSIT);
      return [
        await handlePostback(tx, { ...signed(DEPOSIT), brandId: 'br_royal' }, { env: ENV, bindingHmacKey: SEED_KEY }),
        await post(tx, signed(DEPOSIT), {}),
        await post(tx, { ...bad, rawBody: 'x', signature: signPostback(SECRET, bad.timestamp, 'x') }),
        await post(tx, signed({ externalEventId: 'w-2', event: 'deposit' })),
        await post(tx, signed({ ...DEPOSIT, externalEventId: 'w-3', clickId: 'clk_j' })),
        await post(tx, signed({ externalEventId: 'w-4', event: 'reversal', operatorAccountId: 'A', reversesExternalEventId: 'none' })),
      ].map((o) => (o.ok ? 'ok' : `${o.httpStatus}:${o.reason}`));
    });
    // D-008 #5：未对接 / 配置缺失对外同为 401，reason 保留真实原因
    expect(r).toEqual(['401:no_integration', '401:secret_missing', '400:invalid_json', '400:invalid_body', '400:click_brand_mismatch', '409:reversal_target_not_found']);
  });
});
