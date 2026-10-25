import { describe, expect, it } from 'vitest';
import { ALGORITHM_VERSION, capPerBinding, computeBrand, confidenceOf, rankBrands, timeScore, type BrandInput } from '../src/index';

const NOW = new Date('2026-09-23T02:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const paid = (mins: number, ago = 10, fromBinding = true) => ({
  kind: 'user' as const,
  fromBinding,
  outcome: 'paid' as const,
  requestedAt: days(ago),
  receivedAt: new Date(days(ago).getTime() + mins * 60_000),
});
type W = BrandInput['withdrawals'][number];
type WIn = Omit<W, 'id' | 'bindingId'> & Partial<Pick<W, 'id' | 'bindingId'>>;
/** 默认：每条凭证一个独立绑定（A-005 不同绑定口径下与旧用例等价） */
const brand = ({ withdrawals, ...o }: Omit<Partial<BrandInput>, 'withdrawals'> & { withdrawals?: WIn[] } = {}): BrandInput => ({
  withdrawals: (withdrawals ?? []).map((w, i) => ({ id: `wr${String(i).padStart(4, '0')}`, bindingId: w.fromBinding ? `b${i}` : null, ...w })),
  id: 'br_t',
  slug: 't',
  status: 'watch',
  statusSince: '2025-01-01',
  foundedYear: 2018,
  listedSince: '2025-01-01',
  complaints: [],
  reviews: [],
  attributes: [],
  officialDomains: [{ online: true }],
  linkedToBlacklist: false,
  ...o,
});
const fac = (s: ReturnType<typeof computeBrand>, k: string) => s.factors.find((f) => f.key === k)!;

describe('子分公式（v0.3-draft）', () => {
  it('到账时长分：1h=100、24h=50、72h=0，单调', () => {
    expect(timeScore(30)).toBe(100);
    expect(Math.round(timeScore(1440))).toBe(50);
    expect(timeScore(4320)).toBe(0);
    expect(timeScore(120)).toBeGreaterThan(timeScore(600));
  });

  it('出款：25 份绑定凭证、中位 38 分、无拒付 → 100；metrics 结构化（C3）', () => {
    const s = computeBrand(brand({ withdrawals: Array.from({ length: 25 }, () => paid(38)) }), NOW);
    expect(fac(s, 'withdrawal')).toMatchObject({ available: true, score: 100, sampleSize: 25, metrics: { medianMinutes: 38, refusalRate: 0, sample: 25 } });
  });

  it('S1：非绑定用户凭证不计门槛', () => {
    const s = computeBrand(brand({ withdrawals: Array.from({ length: 25 }, () => paid(38, 10, false)) }), NOW);
    expect(fac(s, 'withdrawal').available).toBe(false);
  });

  it('S2：180 天窗口外不计', () => {
    const s = computeBrand(brand({ withdrawals: Array.from({ length: 25 }, () => paid(38, 200)) }), NOW);
    expect(fac(s, 'withdrawal').available).toBe(false);
  });

  it('S3：pending 超 72h 计入拒付，拒付分截到 0', () => {
    const pendingOld = { kind: 'user' as const, fromBinding: true, outcome: 'pending' as const, requestedAt: days(5), receivedAt: null };
    const s = computeBrand(brand({ withdrawals: [...Array.from({ length: 10 }, () => paid(38)), ...Array.from({ length: 10 }, () => pendingOld)] }), NOW);
    const w = fac(s, 'withdrawal');
    expect(w.metrics.refusalRate).toBe(0.5);
    expect(w.score).toBe(60); // 0.6 × 100 + 0.4 × max(0, 1 − 0.5×5)=0
  });

  it('S4：评价门槛按 Σ trustWeight', () => {
    const r = (w: number) => ({ rating: 5, trustWeight: w, createdAt: days(5) });
    expect(fac(computeBrand(brand({ reviews: Array.from({ length: 100 }, () => r(0.1)) }), NOW), 'playerReviews').available).toBe(false);
    expect(fac(computeBrand(brand({ reviews: Array.from({ length: 40 }, () => r(1)) }), NOW), 'playerReviews')).toMatchObject({ available: true, score: 100 });
  });

  const c = (status: string, replyDays: number | null, notifiedAgo = 20) => ({
    status,
    acceptedAt: days(notifiedAgo),
    operatorNotifiedAt: days(notifiedAgo),
    operatorRepliedAt: replyDays == null ? null : new Date(days(notifiedAgo).getTime() + replyDays * 86_400_000),
    replyDeadline: null,
  });

  it('仲裁：失联按未解决、驳回不计入分母；答辩期届满未答辩按 7 天', () => {
    const s = computeBrand(brand({ complaints: [c('resolved', 1), c('resolved', 1), c('resolved', 1), c('resolved', 1), c('exposed', null), c('rejected', 1)] }), NOW);
    expect(fac(s, 'arbitration').metrics).toMatchObject({ resolveRate: 0.8, medianResponseDays: 1, sample: 5 });
    expect(fac(s, 'arbitration').score).toBe(86); // 0.7×80 + 0.3×100
  });

  it('自检 I3：门槛只计已结案；答辩期内未答辩的案件不计入响应时长', () => {
    const open = [c('arbitrating', null), c('awaiting_reply', null), c('screening', null)];
    expect(fac(computeBrand(brand({ complaints: [...open, c('resolved', 1), c('resolved', 1)] }), NOW), 'arbitration').available).toBe(false);
    const fresh = Array.from({ length: 5 }, () => c('resolved', null, 0.1)); // 2.4 小时前通知、未答辩
    const f = fac(computeBrand(brand({ complaints: fresh }), NOW), 'arbitration');
    expect(f.metrics.medianResponseDays).toBeNull(); // 答辩期未届满，不按 7 天计
    expect(f.score).toBe(70);
  });

  it('自检 I1：到账早于申请的凭证剔除', () => {
    const bad = { kind: 'user' as const, fromBinding: true, outcome: 'paid' as const, requestedAt: days(10), receivedAt: days(11) };
    expect(fac(computeBrand(brand({ withdrawals: Array.from({ length: 25 }, () => bad) }), NOW), 'withdrawal').available).toBe(false);
  });

  it('自检 I2：72h 内的 pending 不计门槛、不计拒付率', () => {
    const fresh = { kind: 'user' as const, fromBinding: true, outcome: 'pending' as const, requestedAt: new Date(NOW.getTime() - 3_600_000), receivedAt: null };
    expect(fac(computeBrand(brand({ withdrawals: Array.from({ length: 25 }, () => fresh) }), NOW), 'withdrawal').available).toBe(false);
  });
});

describe('A-005 不同绑定门槛（E1–E3）', () => {
  it('单个绑定连刷 20 条「秒到账」→ 出款不可用', () => {
    const one = Array.from({ length: 20 }, (_, i) => ({ ...paid(1, 10 + i * 0.01), bindingId: 'b_same' }));
    const f = fac(computeBrand(brand({ withdrawals: one }), NOW), 'withdrawal');
    expect(f.available).toBe(false);
    expect(f.metrics.bindings).toBe(1);
  });
  it('20 个绑定各 1 条 → 可用，metrics.bindings = 20', () => {
    const f = fac(computeBrand(brand({ withdrawals: Array.from({ length: 20 }, () => paid(38)) }), NOW), 'withdrawal');
    expect(f).toMatchObject({ available: true, metrics: { bindings: 20, sample: 20 } });
  });
  it('E1：同一绑定 30 天内第 4 条不计；跨过 30 天边界的第 4 条计入', () => {
    const at = (d: number) => ({ ...paid(38, d), bindingId: 'b1' });
    expect(capPerBinding([at(40), at(39), at(38), at(37)].map((w, i) => ({ ...w, id: `w${i}` }))).length).toBe(3);
    // 第 1 条在 70 天前，第 4 条在 39.9 天前：两者相距 > 30 天，窗口内只有 2 条 → 计入
    expect(capPerBinding([at(70), at(45), at(44), at(39.9)].map((w, i) => ({ ...w, id: `w${i}` }))).length).toBe(4);
  });
  it('E1：同一时刻按 id 决定先后（确定性）', () => {
    const same = ['w3', 'w1', 'w4', 'w2'].map((id) => ({ ...paid(38, 20), bindingId: 'b1', id }));
    expect(capPerBinding(same).map((w) => w.id).sort()).toEqual(['w1', 'w2', 'w3']);
  });
  it('E3：版本 v0.4', () => expect(ALGORITHM_VERSION).toBe('v0.4'));
});

describe('总分 / 冷启动 / 黑名单', () => {
  const full = brand({
    withdrawals: Array.from({ length: 25 }, () => paid(38)),
    attributes: [
      { dimension: 'payment', values: ['a', 'b', 'c', 'd'], verified: true },
      { dimension: 'gameProvider', values: ['a', 'b', 'c', 'd'], verified: true },
      { dimension: 'support', values: ['a', 'b', 'c'], verified: true },
    ],
  });

  it('按可用因子权重归一化', () => {
    const s = computeBrand(full, NOW);
    // 可用：出款 100（30）、硬指标 100（20）、稳定性 100（10）→ 100
    expect(s).toMatchObject({ score: 100, factorsAvailable: 3, factorsTotal: 5, confidence: 'medium', algorithmVersion: ALGORITHM_VERSION });
  });

  it('S5（严格口径）：只有硬指标 / 稳定性可用 → 暂无评分', () => {
    const s = computeBrand({ ...full, withdrawals: [] }, NOW);
    expect(s.factorsAvailable).toBe(2);
    expect(s.score).toBeNull();
    expect(s.confidence).toBe('none');
  });

  it('黑名单：score 为 null，因子分数全部置空但明细保留', () => {
    const s = computeBrand({ ...full, status: 'blacklist' }, NOW);
    expect(s.score).toBeNull();
    expect(s.factors.every((f) => f.score === null)).toBe(true);
    expect(fac(s, 'withdrawal').detail).toContain('中位到账');
  });

  it('收录 < 30 天：稳定性不可用', () => {
    expect(fac(computeBrand(brand({ listedSince: '2026-09-10' }), NOW), 'stability').available).toBe(false);
  });

  it('在线状态未知的域名不计入分母', () => {
    expect(fac(computeBrand(brand({ officialDomains: [{ online: true }, { online: null }] }), NOW), 'stability').metrics.domainOnlineRatio).toBe(1);
  });

  it('与黑名单关联：稳定性风险分为 0', () => {
    expect(fac(computeBrand(brand({ linkedToBlacklist: true }), NOW), 'stability').score).toBe(80); // 50×100/100 + 30×1 + 0
  });

  it('置信度映射', () => {
    expect([0, 1, 2, 3, 4, 5].map(confidenceOf)).toEqual(['none', 'low', 'low', 'medium', 'medium', 'high']);
  });

  it('C5 确定性：同输入同输出', () => {
    expect(computeBrand(full, NOW)).toEqual(computeBrand(structuredClone(full), NOW));
  });
});

describe('排序（ADR-0006：归 scoring）', () => {
  const x = (slug: string, score: number | null, confidence: 'none' | 'low' | 'medium' | 'high', statusSince = '2026-01-01') => ({ slug, statusSince, score: { score, confidence } });
  it('score_desc：分数降序、null 置后、同分按置信度', () => {
    expect(rankBrands([x('a', null, 'none'), x('b', 80, 'low'), x('c', 80, 'high'), x('d', 90, 'low')], 'score_desc').map((i) => i.slug)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('listed_at_desc', () => {
    expect(rankBrands([x('a', 1, 'low', '2026-01-01'), x('b', 1, 'low', '2026-06-01')], 'listed_at_desc').map((i) => i.slug)).toEqual(['b', 'a']);
  });
});
