/**
 * /check 五个验收用例（D-001 M1）：verdict 与三事实对照 prototype CHECK 表；输出须通过契约 zod（CheckResult）。
 * now 固定为设计稿日期 2026-09-22（"< 30 天"等相对时间）。需 DATABASE_URL（已迁移 + seed）。
 */
import { createDb } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { checkIdentifier } from '../src/trust/check';
import { CheckResult } from '../src/trust/index';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
const NOW = new Date('2026-09-22T12:00:00Z');
const run = (q: string) => checkIdentifier(conn!.db, q, NOW);
const facts = (r: Awaited<ReturnType<typeof run>>) => (r.facts ?? []).map((f) => [f.v, f.k, f.tone]);

describe.skipIf(!url)('GET /check 五态验收', () => {
  it('cs-poker.net → blacklist「别存。」', async () => {
    const r = await run('cs-poker.net');
    expect(CheckResult.parse(r)).toBeTruthy();
    expect(r.verdict).toBe('blacklist');
    expect(r.matchNote).toBe('标识匹配 · 财神棋牌重开域名');
    expect(facts(r)).toEqual([
      ['17 起', '同类投诉', 'red'],
      ['38,400', '申报被困 USDT', 'red'],
      ['16 个月', '原站存活', 'neutral'],
    ]);
    expect(r.brand?.score?.score ?? null).toBeNull(); // 黑名单不计分（无快照或快照被置空）
    expect(r.related?.map((x) => x.subject)).toEqual(
      expect.arrayContaining(['caishenqp.com', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', '赢家体育']),
    );
    expect(r.alternative?.slug).toBe('jinlong');
  });

  it('jinlong88.com → certified「可以存。」', async () => {
    const r = await run('https://www.JinLong88.com/');
    expect(CheckResult.parse(r)).toBeTruthy();
    expect(r.verdict).toBe('certified');
    expect(r.matchNote).toBe('官方域名 · 主站');
    expect(facts(r)).toEqual([
      ['38 分', '出款中位到账', 'green'],
      ['92.6%', '仲裁解决率', 'green'],
      ['0.6%', '拒付率', 'neutral'],
    ]);
    expect(r.brand?.score?.score).toBe(92); // 方案 A 重算（原公开 91，D-004 允许 ±2）
    expect(r.brand?.primaryDomain).toBe('jinlong88.com');
    expect(r.brand?.reviewCount).toBe(2); // prod seed 不含 demo 评价
    expect(r.factors).toHaveLength(5);
    expect(r.alternative).toBeUndefined();
  });

  it('jin1ong88.com → fake「这是假的。」', async () => {
    const r = await run('jin1ong88.com');
    expect(CheckResult.parse(r)).toBeTruthy();
    expect(r.verdict).toBe('fake');
    expect(r.matchNote).toBe('形近标识 · 非官方');
    expect(facts(r)).toEqual([
      ['97%', '仿冒置信度', 'purple'],
      ['< 30 天', '首次发现', 'neutral'],
      ['3 个', '官方标识', 'green'],
    ]);
    expect(r.officialIdentifiers?.map((i) => i.value)).toEqual(['jinlong88.com', 'jinlong88.vip', '@jinlong_official']);
    expect(r.timeline?.map((e) => e.subject)).toEqual(['首次发现', '人工确认']); // 不混入被冒充品牌的历史
  });

  it('winner-sport.co → watch「谨慎。」', async () => {
    const r = await run('winner-sport.co');
    expect(CheckResult.parse(r)).toBeTruthy();
    expect(r.verdict).toBe('watch');
    expect(facts(r)).toEqual([
      ['14%', '拒付率', 'red'],
      ['3.2 天', '出款中位', 'amber'],
      ['41.7%', '仲裁解决率', 'amber'],
    ]);
    expect(r.related?.map((x) => x.subject)).toEqual(expect.arrayContaining(['TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', '财神棋牌']));
  });

  it('lucky777-my.com → unknown「先别存。」（WHOIS 天数无字段，只出 2 条事实）', async () => {
    const r = await run('lucky777-my.com');
    expect(CheckResult.parse(r)).toBeTruthy();
    expect(r.verdict).toBe('unknown');
    expect(facts(r)).toEqual([
      ['43 次', '本周查询', 'neutral'],
      ['3 项', '风险信号', 'amber'],
    ]);
    expect(r.candidate?.queryCount7d).toBe(43);
  });

  it('共用收款地址命中两个品牌 → 取最严重（黑名单）', async () => {
    const r = await run('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE');
    expect(r.verdict).toBe('blacklist');
  });

  it('未收录的形近域名 → unknown + 高危形近信号（不自动判假，待人工确认）', async () => {
    const r = await run('jinl0ng88.com');
    expect(r.verdict).toBe('unknown');
    expect(r.riskSignals?.[0]).toMatchObject({ severity: 'high', source: 'entity-graph' });
  });

  it('品牌名查询', async () => {
    expect((await run('金龙娱乐城')).verdict).toBe('certified');
    expect((await run('財神棋牌')).verdict).toBe('blacklist');
  });
});
