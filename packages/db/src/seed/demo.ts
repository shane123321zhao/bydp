/**
 * 演示数据（PO 裁定 2026-09-27 方案 A）：按各品牌已公开的数字批量生成原始数据（绑定用户出款凭证、已结案案件、评价），
 * 让 scoring 重算自然得出分数；重算结果回写 fixtures 快照，不手改分数。
 *
 * - 全部行 id 带 `demo` 前缀、正文带 `[demo]` 标记；只由 `pnpm db:seed:demo` 写入，**不得进入生产库**。
 * - 确定性：固定种子 PRNG + 固定基准时刻 DEMO_AT，同一代码永远生成同一批行。
 * - 目标 = 公开数字 − base fixtures 已有行（注释逐项写明）。
 * - D-004：重算分数须与原公开分数偏差 ≤ ±2，超出只调 mock 数据、不调公式。可调的只有「未公开」指标
 *   （拒付数、仲裁响应中位、失联件中答辩与否），调整值逐项写在各品牌注释；已公开的三事实数字一律不动。
 * - 已按 A-005 / W1 预留：每个绑定最多 3 条凭证、同一绑定的凭证间隔 > 30 天，故「≥ 20 个不同绑定」口径下结果不变。
 */
import { hashOperatorAccountId } from '../binding-hash';
import { SEED_BINDING_HMAC_KEY, SEED_PII_KEY, sealBindingRow } from './build';

export const DEMO_AT = new Date('2026-09-23T02:00:00Z');
export const DEFAULT_RESPONSE_DAYS = 2;
const DAY = 86_400_000;

type Target = {
  /** 公开数字：绑定用户出款凭证总数 / 其中拒付数 / 到账中位（分钟） */
  withdrawal?: { total: number; refused: number; medianMinutes: number; baseBound: number; baseRefused: number; pendingFresh?: number };
  /** 公开数字：已结案案件 解决 / 未解决+曝光；响应中位（天）；failedReplied = 未解决件中运营商有答辩的件数（其余为失联） */
  arbitration?: { resolved: number; failed: number; responseDays: number; baseResolved: number; baseFailed: number; failedReplied?: number };
  /** 评价：总条数、目标加权星级、单条可信权重 */
  reviews?: { total: number; rating: number; weight: number; base: number };
};

/**
 * 公开数字来源：docs/design/fixtures/trust.json 各快照 factors[].metrics / detail。
 * base* = fixtures 已有、会被 scoring 计入的行（避免重复计数）。
 */
export const DEMO_TARGETS: Record<string, Target> = {
  // 312 份凭证 · 中位 38 分 · 拒付 0.6%（2/312）；27 件 · 解决 92.6%（25/27）；1,204 条 · 4.3 / 5
  // ±2 调整：仲裁响应中位 1.8 → 4 天（公开明细改变；三事实不变），重算 ≈ 92（原 91）
  br_jinlong: {
    withdrawal: { total: 312, refused: 2, medianMinutes: 38, baseBound: 1, baseRefused: 0 }, // wr_001
    arbitration: { resolved: 25, failed: 2, responseDays: 4, baseResolved: 1, baseFailed: 0 }, // cp_001
    reviews: { total: 1204, rating: 4.3, weight: 0.8, base: 2 }, // rv_001, rv_002
  },
  // 58 份 · 中位 3.2 天 · 拒付 14%（8/57 已有结论 = 14.0%，另 1 份 72h 内 pending）；12 件 · 解决 41.7%（5/12）· 3 件失联；评价 9 条（样本不足）
  // ⚠ ±2 无法达成：公开中位 3.2 天 > 72h，v0.3 到账时长分 = 0；未公开指标取最有利值也只能到 ≈ 30（原 41），见 to-po
  br_winner: {
    withdrawal: { total: 58, refused: 8, medianMinutes: 3.2 * 1440, baseBound: 1, baseRefused: 1, pendingFresh: 1 }, // wr_003
    arbitration: { resolved: 5, failed: 7, failedReplied: 4, responseDays: 1, baseResolved: 0, baseFailed: 1 }, // cp_002（失联）
    reviews: { total: 9, rating: 1.3, weight: 0.5, base: 1 }, // rv_003
  },
  // 140 份 · 中位 2.1 小时 · 拒付 2.1%（3/140）；20 件 · 解决 80%（16/20）；311 条 · 3.8 / 5
  br_crown: {
    withdrawal: { total: 140, refused: 3, medianMinutes: 126, baseBound: 0, baseRefused: 0 },
    arbitration: { resolved: 16, failed: 4, responseDays: DEFAULT_RESPONSE_DAYS, baseResolved: 0, baseFailed: 0 },
    reviews: { total: 311, rating: 3.8, weight: 0.8, base: 0 },
  },
  // 180 份 · 中位 55 分；16 件 · 解决 88%（14/16 = 87.5%）；420 条 · 4.0 / 5
  // ±2 调整（未公开指标）：拒付 7/180 ≈ 3.9%、响应中位 3 天 → 重算 ≈ 85（原 84）
  br_royal: {
    withdrawal: { total: 180, refused: 7, medianMinutes: 55, baseBound: 0, baseRefused: 0 },
    arbitration: { resolved: 14, failed: 2, responseDays: 3, baseResolved: 0, baseFailed: 0 },
    reviews: { total: 420, rating: 4.0, weight: 0.8, base: 0 },
  },
  // 64 份 · 中位 6 小时；10 件 · 解决 70%（7/10）；评价 18 条（样本不足）
  // ±2 调整（未公开指标）：拒付 6/64 ≈ 9.4%、未解决件均失联、响应中位 7 天 → 重算 ≈ 61（原 62）
  br_longteng: {
    withdrawal: { total: 64, refused: 6, medianMinutes: 360, baseBound: 0, baseRefused: 0 },
    arbitration: { resolved: 7, failed: 3, responseDays: 7, baseResolved: 0, baseFailed: 0 },
    reviews: { total: 18, rating: 3.5, weight: 0.5, base: 0 },
  },
  // 星辰彩票：公开数字均为「样本不足」，base fixtures 已足够表达，不生成
};

/**
 * D-007：「已领码」= 带专属码的 Click 数（field-mapping v1.6）。按公开数字补 demo 点击：
 * 金龙 1,834（of_001 / pc_001）、皇冠 212（of_002 / pc_002）；来源 docs/design/fixtures/commerce-users.json promoCodes[].claimedCount。
 * 24h 同用户去重：同一 demo 用户相邻两次领码间隔 2 天（与 tracking claimOffer 的 24h 幂等一致）。
 */
export const DEMO_CLAIMS: { offerId: string; promoCodeId: string; brandId: string; count: number }[] = [
  { offerId: 'of_001', promoCodeId: 'pc_001', brandId: 'br_jinlong', count: 1834 },
  { offerId: 'of_002', promoCodeId: 'pc_002', brandId: 'br_crown', count: 212 },
];
/** 每个品牌参与领码的 demo 用户数（复用该品牌 demo 用户池） */
const CLAIM_USERS = 300;

type Row = Record<string, unknown>;
export type DemoPlan = { tables: { table: string; rows: Row[] }[] };

/** mulberry32：确定性 PRNG */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** 到账时长：中间 30% 精确等于中位数，两侧对称展开，保证整体中位数恰为目标值 */
function durations(n: number, median: number, rand: () => number): number[] {
  const out: number[] = [];
  const band = Math.max(1, Math.round(n * 0.3));
  const side = n - band;
  const low = Math.floor(side / 2);
  for (let i = 0; i < low; i++) out.push(median * (0.35 + 0.6 * rand()));
  for (let i = 0; i < band; i++) out.push(median);
  for (let i = 0; i < side - low; i++) out.push(median * (1.05 + 1.5 * rand()));
  return out;
}

export function buildDemo(piiKey: Buffer = SEED_PII_KEY): DemoPlan {
  const users: Row[] = [];
  const bindings: Row[] = [];
  const reports: Row[] = [];
  const complaints: Row[] = [];
  const reviews: Row[] = [];
  const clicks: Row[] = [];
  const at = DEMO_AT.getTime();

  for (const [brandId, t] of Object.entries(DEMO_TARGETS)) {
    const short = brandId.replace(/^br_/, '');
    const rand = rng(seedOf(brandId));
    const userPool: string[] = [];
    const user = (i: number) => {
      while (userPool.length <= i) {
        const id = `u_demo_${short}_${String(userPool.length + 1).padStart(4, '0')}`;
        userPool.push(id);
        users.push({ id, displayName: `[demo] ${short} #${userPool.length}`, level: 1, points: 0, joinedAt: '2026-01-01', region: null, locale: 'zh-Hans' });
      }
      return userPool[i]!;
    };

    if (t.withdrawal) {
      const w = t.withdrawal;
      const n = w.total - w.baseBound;
      const refusedN = w.refused - w.baseRefused;
      const pendingN = w.pendingFresh ?? 0;
      const paidN = n - refusedN - pendingN;
      const durs = durations(paidN, w.medianMinutes, rand);
      // 每个绑定 3 条，间隔 50 天（> 30 天），全部落在 DEMO_AT 前 170 天内
      const nb = Math.ceil(n / 3);
      for (let b = 0; b < nb; b++) {
        const account = `DEMO-${short.toUpperCase()}-${String(b + 1).padStart(4, '0')}`;
        bindings.push(sealBindingRow({
          id: `ubb_demo_${short}_${String(b + 1).padStart(4, '0')}`,
          userId: user(b),
          brandId,
          operatorAccountId: account,
          operatorAccountIdHash: hashOperatorAccountId(account, SEED_BINDING_HMAC_KEY),
          source: 'promo_link',
          boundAt: new Date(at - 175 * DAY),
          verificationLevel: 'postback_confirmed',
          postbackAt: new Date(at - 175 * DAY + 3_600_000),
          compensationEligible: false,
        }, piiKey)); // A-011 T9：明文不入库
      }
      for (let i = 0; i < n; i++) {
        const binding = `ubb_demo_${short}_${String(Math.floor(i / 3) + 1).padStart(4, '0')}`;
        const requestedAt = new Date(at - (10 + (i % 3) * 50 + Math.floor(rand() * 8)) * DAY - Math.floor(rand() * DAY));
        const refused = i < refusedN;
        const pending = !refused && i < refusedN + pendingN;
        const mins = refused || pending ? null : durs[i - refusedN - pendingN]!;
        // 72h 内的 pending：申请于 DEMO_AT 前 6 小时（不计门槛、不计拒付，S3 / 自检 I2）
        const req = pending ? new Date(at - 6 * 3_600_000) : requestedAt;
        reports.push({
          id: `wr_demo_${short}_${String(i + 1).padStart(4, '0')}`,
          brandId,
          kind: 'user',
          amountUsdt: Math.round(50 + rand() * 4950),
          method: 'USDT-TRC20',
          requestedAt: req,
          receivedAt: mins == null ? null : new Date(req.getTime() + mins * 60_000),
          outcome: refused ? 'refused' : pending ? 'pending' : 'paid',
          bindingId: binding,
          complaintId: null,
        });
      }
    }

    if (t.arbitration) {
      const a = t.arbitration;
      const res = a.resolved - a.baseResolved;
      const fail = a.failed - a.baseFailed;
      const failReplied = a.failedReplied ?? 0;
      for (let i = 0; i < res + fail; i++) {
        const resolved = i < res;
        const replied = resolved || i < res + failReplied;
        const created = new Date(at - (20 + Math.floor(rand() * 140)) * DAY);
        const notified = new Date(created.getTime() + 3_600_000);
        complaints.push({
          id: `cp_demo_${short}_${String(i + 1).padStart(3, '0')}`,
          brandId,
          userId: user(i),
          bindingId: null,
          category: resolved ? 'delay' : 'refused',
          title: `[demo] ${resolved ? '提款延迟' : '提款被拒'}`,
          amountUsdt: Math.round(100 + rand() * 2900),
          eventDate: new Date(created.getTime() - DAY).toISOString().slice(0, 10),
          description: '[demo] 演示数据，不公开',
          status: resolved ? 'resolved' : replied ? 'unresolved' : 'exposed',
          publicSummary: false, // 演示案件不进公开页面
          createdAt: created,
          acceptedAt: new Date(created.getTime() + 1_800_000),
          operatorNotifiedAt: notified,
          operatorRepliedAt: replied ? new Date(notified.getTime() + a.responseDays * DAY) : null,
          resolvedAt: resolved ? new Date(notified.getTime() + (a.responseDays + 1) * DAY) : null,
          resolution: '[demo]',
        });
      }
    }

    for (const c of DEMO_CLAIMS.filter((x) => x.brandId === brandId)) {
      for (let i = 0; i < c.count; i++) {
        const round = Math.floor(i / CLAIM_USERS);
        clicks.push({
          id: `clk_demo_${short}_${String(i + 1).padStart(4, '0')}`,
          brandId,
          offerId: c.offerId,
          promoCodeId: c.promoCodeId,
          userId: user(i % CLAIM_USERS),
          slot: 'demo',
          channel: 'web',
          region: null,
          partnerId: null,
          createdAt: new Date(at - (1 + round * 2) * DAY - Math.floor(rand() * 12 * 3_600_000)),
        });
      }
    }

    if (t.reviews) {
      const r = t.reviews;
      const n = r.total - r.base;
      // 两档星级按比例混合，使加权均值 ≈ 目标（同权重下即为算术均值）
      const lo = Math.floor(r.rating);
      const hi = Math.min(5, lo + 1);
      const hiCount = Math.round(n * (r.rating - lo));
      for (let i = 0; i < n; i++) {
        reviews.push({
          id: `rv_demo_${short}_${String(i + 1).padStart(4, '0')}`,
          brandId,
          userId: user(i),
          rating: i < hiCount ? hi : lo,
          text: '[demo]',
          trustWeight: r.weight,
          verifiedBinding: false,
          helpful: 0,
          createdAt: new Date(at - (5 + Math.floor(rand() * 160)) * DAY),
        });
      }
    }
  }

  return {
    tables: [
      { table: 'app_user', rows: users },
      { table: 'user_brand_binding', rows: bindings },
      { table: 'withdrawal_report', rows: reports },
      { table: 'complaint', rows: complaints },
      { table: 'review', rows: reviews },
      { table: 'click', rows: clicks },
    ],
  };
}
