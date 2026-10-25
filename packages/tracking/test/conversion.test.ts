import { sql } from '@bydp/db';
import { describe, expect, it } from 'vitest';
import { commissionStatus, PostbackBody, recordConversion, settleCommission, TrackingError, type RecordedConversion } from '../src/index';
import { asApp, HASH_A, HASH_B, inTx, oldClick, q, url, type Tx } from './helpers';

const body = (b: Partial<PostbackBody> & Pick<PostbackBody, 'externalEventId' | 'event'>) => PostbackBody.parse({ operatorAccountId: 'ACC-1', ...b });
const rec = (tx: Tx, brandId: string, b: PostbackBody, extra: { hash?: string; user?: string | null } = {}) =>
  recordConversion(tx, brandId, b, { operatorAccountIdHash: extra.hash ?? HASH_A, bindingUserId: extra.user ?? null, raw: b });
const recorded = async (p: ReturnType<typeof rec>) => {
  const r = await p;
  if (r.status !== 'recorded') throw new Error(`expected recorded, got ${r.status}`);
  return r.conversion;
};

describe('PostbackBody', () => {
  it('reversal 必须且只能带 reversesExternalEventId；账号不能为空白', () => {
    expect(PostbackBody.safeParse({ externalEventId: 'e', event: 'reversal', operatorAccountId: 'A' }).success).toBe(false);
    expect(PostbackBody.safeParse({ externalEventId: 'e', event: 'deposit', operatorAccountId: 'A', reversesExternalEventId: 'x' }).success).toBe(false);
    expect(PostbackBody.safeParse({ externalEventId: 'e', event: 'deposit', operatorAccountId: ' 　 ' }).success).toBe(false);
  });
});

describe.skipIf(!url)('recordConversion（bydp_app）', () => {
  it('幂等：同品牌重复 externalEventId → duplicate，只写一行；A-013 只存盲索引，表中无明文列', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const b = body({ externalEventId: 'e1', event: 'register', operatorAccountId: ' ＡCC-1 ' });
      const first = await rec(tx, 'br_jinlong', b);
      const second = await rec(tx, 'br_jinlong', b);
      const rows = await q(tx, sql`select "operatorAccountIdHash" from "conversion" where "externalEventId" = 'e1'`);
      const cols = await q(tx, sql`select column_name from information_schema.columns where table_name = 'conversion' and column_name = 'operatorAccountId'`);
      return { first, second, rows, cols };
    });
    expect(r.first.status).toBe('recorded');
    expect(r.second).toEqual({ status: 'duplicate', conversionId: r.first.status === 'recorded' ? r.first.conversion.id : '' });
    expect(r.rows).toEqual([{ operatorAccountIdHash: HASH_A }]);
    expect(r.cols).toEqual([]);
  });

  it('A-013 raw 白名单：只存 PostbackBody 规范字段，账号与运营商多传的字段（username / email 等）不入库', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const raw = { externalEventId: 'e-raw', event: 'register', operatorAccountId: 'ACC-RAW', clickId: null, username: 'player88', email: 'p@x.com', nested: { a: 1 } };
      await recordConversion(tx, 'br_jinlong', body({ externalEventId: 'e-raw', event: 'register' }), { operatorAccountIdHash: HASH_A, bindingUserId: null, raw });
      const [row] = await q<{ raw: Record<string, unknown> }>(tx, sql`select "raw" from "conversion" where "externalEventId" = 'e-raw'`);
      return row!.raw;
    });
    expect(r).toEqual({ externalEventId: 'e-raw', event: 'register', clickId: null });
  });

  it('带 clickId：不存在 / 跨品牌 → 拒绝；窗口边界 29 天 23 小时归因、30 天 1 小时不归因', async () => {
    const r = await inTx(async (tx) => {
      await oldClick(tx, 'clk_in', 'br_jinlong', '29 days 23 hours');
      await oldClick(tx, 'clk_out', 'br_jinlong', '30 days 1 hour');
      await oldClick(tx, 'clk_royal', 'br_royal', '1 hour');
      await asApp(tx);
      const err = (p: Promise<unknown>) => p.then(() => 'ok', (e: TrackingError) => e.code);
      return {
        missing: await err(rec(tx, 'br_jinlong', body({ externalEventId: 'e0', event: 'register', clickId: 'clk_nope' }))),
        cross: await err(rec(tx, 'br_jinlong', body({ externalEventId: 'e1', event: 'register', clickId: 'clk_royal' }))),
        inWin: (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e2', event: 'register', clickId: 'clk_in' })))).clickId,
        outWin: (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e3', event: 'register', clickId: 'clk_out' })))).clickId,
      };
    });
    expect(r).toEqual({ missing: 'click_not_found', cross: 'click_brand_mismatch', inWin: 'clk_in', outWin: null });
  });

  it('不带 clickId：取绑定用户同品牌 30 天内末次点击；无绑定用户不归因；他品牌点击不算', async () => {
    const r = await inTx(async (tx) => {
      await oldClick(tx, 'clk_a', 'br_jinlong', '10 days', { userId: 'u_102' });
      await oldClick(tx, 'clk_b', 'br_jinlong', '2 days', { userId: 'u_102' });
      await oldClick(tx, 'clk_c', 'br_royal', '1 hour', { userId: 'u_102' });
      await oldClick(tx, 'clk_d', 'br_jinlong', '31 days', { userId: 'u_233' });
      await oldClick(tx, 'clk_e', 'br_jinlong', '29 days 23 hours', { userId: 'u_412' });
      await oldClick(tx, 'clk_f', 'br_jinlong', '30 days 1 hour', { userId: 'u_509' });
      await asApp(tx);
      return [
        (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e1', event: 'register' }), { user: 'u_102' }))).clickId,
        (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e2', event: 'register' }), { user: null }))).clickId,
        (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e3', event: 'register' }), { user: 'u_233', hash: HASH_B }))).clickId,
        (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e4', event: 'register' }), { user: 'u_412' }))).clickId,
        (await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'e5', event: 'register' }), { user: 'u_509' }))).clickId,
      ];
    });
    expect(r).toEqual(['clk_b', null, null, 'clk_e', null]); // 后两项：同用户窗口边界 29d23h 归因 / 30d1h 不归因
  });

  it('冲正：指向原行；原行不存在 / 原行是冲正 → 拒绝；同一行第二次冲正 → already_reversed', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const orig = await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'd1', event: 'deposit', amountUsdt: 100 })));
      const rv = await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'r1', event: 'reversal', reversesExternalEventId: 'd1' })));
      const again = await rec(tx, 'br_jinlong', body({ externalEventId: 'r2', event: 'reversal', reversesExternalEventId: 'd1' }));
      const err = (p: Promise<unknown>) => p.then(() => 'ok', (e: TrackingError) => e.code);
      return {
        orig,
        rv,
        again,
        missing: await err(rec(tx, 'br_jinlong', body({ externalEventId: 'r3', event: 'reversal', reversesExternalEventId: 'nope' }))),
        ofReversal: await err(rec(tx, 'br_jinlong', body({ externalEventId: 'r4', event: 'reversal', reversesExternalEventId: 'r1' }))),
      };
    });
    expect(r.rv.reversesId).toBe(r.orig.id);
    expect(r.again).toEqual({ status: 'already_reversed', conversionId: r.orig.id });
    expect(r.missing).toBe('reversal_target_not_found');
    expect(r.ofReversal).toBe('reversal_target_invalid');
  });
});

describe.skipIf(!url)('settleCommission（bydp_app）', () => {
  const terms = (tx: Tx) =>
    tx.execute(sql`insert into "partner" ("id","kind","name","active") values ('pt_k','kol','K',true), ('pt_off','kol','Off',false);
      insert into "commission_term" ("id","brandId","partnerId","mode","cpaUsdt","sharePct","validFrom") values
        ('ct_gen','br_jinlong',null,'cpa',25,null,'2026-01-01'),
        ('ct_k','br_jinlong','pt_k','cpa',80,null,'2026-01-01'),
        ('ct_royal','br_royal',null,'cpa',80,null,'2026-01-01'),
        ('ct_rs','br_longteng',null,'revshare',null,0.3,'2026-01-01')`);
  const conv = async (tx: Tx, brandId: string, id: string, event: PostbackBody['event'], clickId: string | null, amountUsdt?: number, hash = HASH_A) =>
    recorded(rec(tx, brandId, body({ externalEventId: id, event, clickId, amountUsdt }), { hash }));

  it('条款同合作方优先，否则「不限合作方」；commission 记 termId + pending 事件', async () => {
    const r = await inTx(async (tx) => {
      await terms(tx);
      await oldClick(tx, 'clk_k', 'br_jinlong', '1 day', { partnerId: 'pt_k' });
      await oldClick(tx, 'clk_0', 'br_jinlong', '1 day');
      await asApp(tx);
      const a = await settleCommission(tx, await conv(tx, 'br_jinlong', 'd1', 'first_deposit', 'clk_k', 200));
      const b = await settleCommission(tx, await conv(tx, 'br_jinlong', 'd2', 'first_deposit', 'clk_0', 99.99, HASH_B));
      const st = a.status === 'created' ? await commissionStatus(tx, a.commissionId) : null;
      const rows = await q(tx, sql`select "termId","partnerId","model","amountUsdt"::float as "amount" from "commission" order by "amountUsdt" desc`);
      return { a, b, st, rows };
    });
    expect(r.a).toMatchObject({ status: 'created', termId: 'ct_k', model: 'cpa', amountUsdt: 80 });
    expect(r.b).toMatchObject({ status: 'created', termId: 'ct_gen', amountUsdt: 25 });
    expect(r.st).toBe('pending');
    expect(r.rows).toEqual([
      { termId: 'ct_k', partnerId: 'pt_k', model: 'cpa', amount: 80 },
      { termId: 'ct_gen', partnerId: null, model: 'cpa', amount: 25 },
    ]);
  });

  it('K2（§8 v1.6）：P1 只结 CPA——revshare 条款记 revshare_disabled、不产生佣金；D-006 #4 合作方停用 → partner_inactive', async () => {
    const r = await inTx(async (tx) => {
      await terms(tx);
      await oldClick(tx, 'clk_lt', 'br_longteng', '1 day');
      await oldClick(tx, 'clk_off', 'br_jinlong', '1 day', { partnerId: 'pt_off' });
      await asApp(tx);
      const rs = await settleCommission(tx, await conv(tx, 'br_longteng', 'l1', 'first_deposit', 'clk_lt', 500));
      const off = await settleCommission(tx, await conv(tx, 'br_jinlong', 'o1', 'first_deposit', 'clk_off', 500));
      const [n] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "commission"`);
      return { rs, off, n: n!.n };
    });
    expect(r.rs).toEqual({ status: 'skipped', reason: 'revshare_disabled' });
    expect(r.off).toEqual({ status: 'skipped', reason: 'partner_inactive' });
    expect(r.n).toBe(0);
  });

  it('CPA：只由 first_deposit 触发、同账号只结一次；register 与未归因不产生佣金；无生效条款不产生', async () => {
    const r = await inTx(async (tx) => {
      await terms(tx);
      await oldClick(tx, 'clk_r', 'br_royal', '1 day');
      await oldClick(tx, 'clk_w', 'br_winner', '1 day');
      await asApp(tx);
      return [
        await settleCommission(tx, await conv(tx, 'br_royal', 'r0', 'register', 'clk_r')),
        await settleCommission(tx, await conv(tx, 'br_royal', 'r1', 'first_deposit', 'clk_r', 50)),
        await settleCommission(tx, await conv(tx, 'br_royal', 'r2', 'first_deposit', 'clk_r', 50)),
        await settleCommission(tx, await conv(tx, 'br_royal', 'r3', 'deposit', 'clk_r', 50)),
        await settleCommission(tx, await conv(tx, 'br_royal', 'r4', 'first_deposit', null, 50, HASH_B)),
        await settleCommission(tx, await conv(tx, 'br_winner', 'w1', 'first_deposit', 'clk_w', 50)),
      ];
    });
    expect(r.map((x) => (x.status === 'skipped' ? x.reason : x.status === 'created' ? `${x.model}:${x.amountUsdt}` : x.status))).toEqual([
      'no_commission_event',
      'cpa:80',
      'cpa_already_paid',
      'no_commission_event',
      'unattributed',
      'no_term',
    ]);
  });

  it('条款生效区间 [validFrom, validTo)：validTo 当日不再生效，由新条款接替', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "commission_term" ("id","brandId","mode","cpaUsdt","validFrom","validTo") values
        ('ct_old','br_jinlong','cpa',10,'2026-01-01', (now() at time zone 'UTC')::date),
        ('ct_new','br_jinlong','cpa',20,(now() at time zone 'UTC')::date, null)`);
      await oldClick(tx, 'clk_0', 'br_jinlong', '1 day');
      await asApp(tx);
      return settleCommission(tx, await conv(tx, 'br_jinlong', 'd1', 'first_deposit', 'clk_0', 100));
    });
    expect(r).toMatchObject({ status: 'created', termId: 'ct_new', amountUsdt: 20 });
  });

  it('void 为终态：void 之后再追加 approved，状态仍为 void（自检 S1）', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "commission" ("id","brandId","model","amountUsdt") values ('cm_t','br_jinlong','cpa',5);
        insert into "commission_event" ("id","commissionId","status","actor","createdAt") values
          ('e1','cm_t','pending','t', now() - interval '3 hours'),
          ('e2','cm_t','void','t', now() - interval '2 hours'),
          ('e3','cm_t','approved','t', now() - interval '1 hour')`);
      await asApp(tx);
      return commissionStatus(tx, 'cm_t');
    });
    expect(r).toBe('void');
  });

  it('ADR-0003 硬拦截：黑名单品牌 / 关联方品牌即使有条款与归因也不产生佣金', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "commission_term" ("id","brandId","mode","cpaUsdt","validFrom") values ('ct_cs','br_caishen','cpa',50,'2026-01-01'), ('ct_cr','br_crown','cpa',50,'2026-01-01')`);
      await oldClick(tx, 'clk_cs', 'br_caishen', '1 day');
      await oldClick(tx, 'clk_cr', 'br_crown', '1 day');
      await asApp(tx);
      const a = await settleCommission(tx, await conv(tx, 'br_caishen', 'c1', 'first_deposit', 'clk_cs', 10));
      const b = await settleCommission(tx, await conv(tx, 'br_crown', 'c2', 'first_deposit', 'clk_cr', 10));
      const [n] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "commission"`);
      return { a, b, n: n!.n };
    });
    expect(r.a).toEqual({ status: 'skipped', reason: 'ineligible_brand' });
    expect(r.b).toEqual({ status: 'skipped', reason: 'ineligible_brand' });
    expect(r.n).toBe(0);
  });

  it('冲正 → 原佣金追加 void 事件（原行不改）；重复冲正处理不重复 void', async () => {
    const r = await inTx(async (tx) => {
      await terms(tx);
      await oldClick(tx, 'clk_0', 'br_jinlong', '1 day');
      await asApp(tx);
      const created = await settleCommission(tx, await conv(tx, 'br_jinlong', 'd1', 'first_deposit', 'clk_0', 100));
      const rv: RecordedConversion = await recorded(rec(tx, 'br_jinlong', body({ externalEventId: 'r1', event: 'reversal', reversesExternalEventId: 'd1' })));
      const voided = await settleCommission(tx, rv);
      const again = await settleCommission(tx, rv);
      const id = created.status === 'created' ? created.commissionId : '';
      const events = await q(tx, sql`select "status" from "commission_event" where "commissionId" = ${id} order by "status"`);
      const [row] = await q(tx, sql`select "amountUsdt"::float as "amount" from "commission" where "id" = ${id}`);
      return { id, voided, again, events, st: await commissionStatus(tx, id), row };
    });
    expect(r.voided).toEqual({ status: 'voided', commissionIds: [r.id] });
    expect(r.again).toEqual({ status: 'voided', commissionIds: [] });
    expect(r.events).toEqual([{ status: 'pending' }, { status: 'void' }]); // 枚举序
    expect(r.st).toBe('void');
    expect(r.row).toEqual({ amount: 25 });
  });
});
