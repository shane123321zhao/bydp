/** D-029：真实价值换算（architecture §8.1 · tv-1）。fixtures 三条逐条复算 + 贡献率 / 多玩法 / 不支持类型。 */
import { readFileSync } from 'node:fs';
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { computeTrueValue, edgeOf, TrueValueError } from '../src/commerce/true-value';
import { recomputeTrueValues } from '../src/commerce/true-value-recompute';

const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());

const fixtures = JSON.parse(readFileSync(new URL('../../../docs/design/fixtures/commerce-users.json', import.meta.url), 'utf8')) as {
  offers: { id: string; type: string; matchPercent: number | null; maxBonusUsdt: number | null; minDepositUsdt: number | null; terms: never; trueValue: Record<string, unknown> }[];
};

describe('真实价值 tv-1', () => {
  it('fixtures 三条逐条复算：与样本完全一致（of_001 −40 · of_002 +33 · of_003 +8，含文案与 methodVersion）', () => {
    const got = Object.fromEntries(fixtures.offers.map((o) => [o.id, computeTrueValue(o)]));
    for (const o of fixtures.offers) expect(got[o.id], o.id).toEqual(o.trueValue);
    expect(fixtures.offers.map((o) => got[o.id]!.netExpectedValueUsdt)).toEqual([-40, 33, 8]);
  });

  it('流水贡献率 50%：有效流水翻倍，成本翻倍', () => {
    const base = { type: 'first_deposit_match', matchPercent: 100, maxBonusUsdt: 500, minDepositUsdt: 50, terms: { rolloverMultiple: 15, rolloverBase: 'deposit_plus_bonus', eligibleGames: ['老虎机'] } };
    const full = computeTrueValue(base);
    const half = computeTrueValue({ ...base, terms: { ...base.terms, contributionPercent: 50 } });
    expect(full.expectedCostAtRtp96Usdt).toBe(240);
    expect(half.expectedCostAtRtp96Usdt).toBe(480);
    expect(half.netExpectedValueUsdt).toBe(-280);
    expect(half.requiredTurnoverUsdt).toBe(6000); // 展示条款流水；贡献率只影响成本
  });

  it('多玩法取最高庄家优势（保守）：真人 + 体育 → 体育 5%；老虎机 + 真人 → 老虎机 4%', () => {
    expect(edgeOf(['真人百家乐', '体育'])).toEqual({ edge: 0.05, name: '体育' });
    expect(edgeOf(['真人百家乐', '老虎机'])).toEqual({ edge: 0.04, name: '老虎机' });
    const live = computeTrueValue({ type: 'reload_match', matchPercent: 50, maxBonusUsdt: 200, minDepositUsdt: 20, terms: { rolloverMultiple: 10, rolloverBase: 'bonus', eligibleGames: ['真人百家乐'] } });
    expect(live).toMatchObject({ exampleDepositUsdt: 200, bonusUsdt: 100, requiredTurnoverUsdt: 1000, expectedCostAtRtp96Usdt: 12, netExpectedValueUsdt: 88, verdict: 'positive' });
    expect(live.verdictText).toBe('按 98.8% RTP 真人打满流水，期望净值约 +88 USDT；扣除流水成本后仍为正');
  });

  it('示例存款夹在 [最低存款, 最高奖励 ÷ 匹配比例]；超过最高提款时文案追加上限；N = 0 记 negative', () => {
    const small = computeTrueValue({ type: 'first_deposit_match', matchPercent: 100, maxBonusUsdt: 50, minDepositUsdt: 10, terms: { rolloverMultiple: 0, rolloverBase: 'none', maxWithdrawalUsdt: 80, eligibleGames: ['老虎机'] } });
    expect(small).toMatchObject({ exampleDepositUsdt: 50, bonusUsdt: 50, netExpectedValueUsdt: 50 });
    expect(small.verdictText).toContain('；上限 80 USDT');
    const zero = computeTrueValue({ type: 'first_deposit_match', matchPercent: 100, maxBonusUsdt: 100, minDepositUsdt: 0, terms: { rolloverMultiple: 25, rolloverBase: 'bonus', eligibleGames: ['老虎机'] } });
    expect(zero).toMatchObject({ netExpectedValueUsdt: 0, verdict: 'negative' });
  });

  it('不支持 / 不完整 → TrueValueError（中文原因），不猜', () => {
    const bad = (o: object) => expect(() => computeTrueValue(o as never)).toThrow(TrueValueError);
    bad({ type: 'free_spins', terms: { rolloverMultiple: 0, rolloverBase: 'none', eligibleGames: ['老虎机'] } });
    bad({ type: 'first_deposit_match', matchPercent: 100, maxBonusUsdt: 100, terms: { rolloverMultiple: 10, rolloverBase: 'bonus', eligibleGames: ['彩票'] } });
    bad({ type: 'weekly_rebate', terms: { rolloverMultiple: 0, rolloverBase: 'none', eligibleGames: ['真人百家乐'] } });
    bad({ type: 'risk_free_bet', maxBonusUsdt: 100, terms: { rolloverMultiple: 5, rolloverBase: 'bonus', eligibleGames: ['体育'], contributionPercent: 0 } });
    expect(() => edgeOf([])).toThrow(/不能为空/);
  });

  it('W2#021 小改：数值非有限数报错（不静默变 0）；周返水基数只允许 无 / 奖励；返水上限只按返水额判断', () => {
    const m = { type: 'first_deposit_match', matchPercent: 100, maxBonusUsdt: 100, minDepositUsdt: 10, terms: { rolloverMultiple: 10, rolloverBase: 'bonus', eligibleGames: ['老虎机'] } };
    expect(() => computeTrueValue({ ...m, terms: { ...m.terms, rolloverMultiple: Number.NaN } })).toThrow(/流水倍数须为数字/);
    expect(() => computeTrueValue({ ...m, terms: { ...m.terms, rolloverMultiple: undefined as never } })).toThrow(/流水倍数须为数字/);
    expect(() => computeTrueValue({ ...m, maxBonusUsdt: Number.NaN })).toThrow(/最高奖励须为数字/);
    expect(() => computeTrueValue({ ...m, terms: { ...m.terms, contributionPercent: Number.NaN } })).toThrow(/流水贡献率须为数字/);
    const rb = { type: 'weekly_rebate', terms: { rolloverMultiple: 1, rolloverBase: 'deposit', rebatePercent: 1, eligibleGames: ['真人百家乐'] } };
    expect(() => computeTrueValue(rb)).toThrow(/只能是「无」或「奖励」/);
    const capped = computeTrueValue({ ...rb, terms: { ...rb.terms, rolloverBase: 'bonus', maxWithdrawalUsdt: 50 } });
    expect(capped.verdictText).not.toContain('上限'); // 返水 10 ≤ 上限 50：周流水 1000 不参与判断
    const over = computeTrueValue({ ...rb, terms: { ...rb.terms, rolloverBase: 'bonus', maxWithdrawalUsdt: 5 } });
    expect(over.verdictText).toContain('；上限 5 USDT');
  });
});

describe.skipIf(!url)('真实价值重算（库）', () => {
  it('of_002 旧值 +22 → 重算 +33（写 audit）；与公式一致的不动；--dry-run 不写', async () => {
    await conn!.db
      .transaction(async (tx) => {
        await tx.execute(sql`update "offer" set "trueValue" = jsonb_set("trueValue", '{netExpectedValueUsdt}', '22') where "id" = 'of_002'`);
        const SYS = { id: 'system:tv-recompute', role: 'admin' as const, ip: null };
        const dry = await recomputeTrueValues(tx, SYS, { write: false });
        expect(dry.changed.map((c) => c.id)).toContain('of_002');
        const [still] = (await tx.execute(sql`select ("trueValue"->>'netExpectedValueUsdt')::int as "n" from "offer" where "id" = 'of_002'`)) as unknown as { n: number }[];
        expect(still!.n).toBe(22);
        const r = await recomputeTrueValues(tx, SYS, { write: true });
        expect(r.changed.find((c) => c.id === 'of_002')).toEqual({ id: 'of_002', from: 22, to: 33 });
        expect(r.changed.map((c) => c.id)).not.toContain('of_001');
        const [now] = (await tx.execute(sql`select "trueValue" from "offer" where "id" = 'of_002'`)) as unknown as { trueValue: Record<string, unknown> }[];
        expect(now!.trueValue).toMatchObject({ netExpectedValueUsdt: 33, methodVersion: 'tv-1' });
        const [a] = (await tx.execute(sql`select "actorId" from "audit_log" where "action" = 'offer_true_value_recompute' and "targetId" = 'of_002'`)) as unknown as { actorId: string }[];
        expect(a!.actorId).toBe('system:tv-recompute');
        const again = await recomputeTrueValues(tx, SYS, { write: true });
        expect(again.changed).toEqual([]);
        tx.rollback();
      })
      .catch((e: Error) => {
        if (!/rollback/i.test(e.message)) throw e;
      });
  });
});
