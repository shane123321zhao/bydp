/** 五因子纯函数（确定性：只依赖入参与 now） */
import { ARBITRATION, HARD, LABELS, REVIEWS, STABILITY, THRESHOLDS, WEIGHTS, WINDOW_DAYS, WITHDRAWAL, type FactorKey } from './params';
import type { BrandInput, Factor } from './types';

const DAY = 86_400_000;
const round = (x: number) => Math.round(x);
const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const inWindow = (d: Date | null, now: Date) => !!d && now.getTime() - d.getTime() <= WINDOW_DAYS * DAY && d.getTime() <= now.getTime();
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
export const fmtDuration = (m: number) =>
  m < 60 ? `${Math.round(m)} 分钟` : m < 1440 ? `${Math.round((m / 60) * 10) / 10} 小时` : `${Math.round((m / 1440) * 10) / 10} 天`;

function base(key: FactorKey): Pick<Factor, 'key' | 'label' | 'weight'> {
  return { key, label: LABELS[key], weight: WEIGHTS[key] };
}
function unavailable(key: FactorKey, sampleSize: number | null, detail: string, metrics: Factor['metrics'] = {}): Factor {
  return { ...base(key), score: null, available: false, sampleSize, detail, metrics };
}

/**
 * A-005 E1：每个绑定按 requestedAt 升序（同刻按 id），一条凭证仅当该绑定「此前 30 天内已计入的条数 < 3」时计入（滑动窗口）。
 * 纯函数、确定性；返回按原顺序无关的计入集合。
 */
export function capPerBinding<T extends { id: string; bindingId: string | null; requestedAt: Date }>(rows: T[]): T[] {
  const byBinding = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.bindingId ?? `__none__${r.id}`;
    (byBinding.get(k) ?? byBinding.set(k, []).get(k)!).push(r);
  }
  const windowMs = WITHDRAWAL.capWindowDays * DAY;
  const out: T[] = [];
  for (const list of byBinding.values()) {
    list.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const counted: number[] = [];
    for (const r of list) {
      const t = r.requestedAt.getTime();
      const recent = counted.filter((c) => t - c < windowMs).length;
      if (recent < WITHDRAWAL.perBindingCap) {
        counted.push(t);
        out.push(r);
      }
    }
  }
  return out;
}

/** 到账时长分：分段对数插值 */
export function timeScore(minutes: number) {
  const { fullMinutes: a, halfMinutes: b, zeroMinutes: c } = WITHDRAWAL;
  if (minutes <= a) return 100;
  if (minutes >= c) return 0;
  if (minutes <= b) return 100 - (50 * Math.log(minutes / a)) / Math.log(b / a);
  return 50 - (50 * Math.log(minutes / b)) / Math.log(c / b);
}

export function withdrawalFactor(b: BrandInput, now: Date): Factor {
  // S1：只用绑定用户的用户凭证；官方实测只做抽检，不进因子
  // 自检 I1：到账早于申请（时间倒置）的凭证无效，整条剔除；已到账但无到账时间的也无效
  const valid = (w: BrandInput['withdrawals'][number]) =>
    w.outcome !== 'paid' || (w.receivedAt != null && w.receivedAt.getTime() >= w.requestedAt.getTime());
  const rs = b.withdrawals.filter((w) => w.kind === 'user' && w.fromBinding && inWindow(w.requestedAt, now) && valid(w));
  // S3：pending 超时计入拒付；自检 I2：门槛与拒付率只计「已有结论」的凭证（到账 / 拒付 / 超时未到账）
  const overdue = (w: (typeof rs)[number]) => w.outcome === 'pending' && now.getTime() - w.requestedAt.getTime() > WITHDRAWAL.pendingAsRefusedHours * 3_600_000;
  // A-005 E1：窗口 + 有效性 + 已有结论过滤之后，按绑定做 30 天滑动限额；门槛 / 拒付率 / 中位数都只用限额后的集合
  const decidedRows = capPerBinding(rs.filter((w) => w.outcome !== 'pending' || overdue(w)));
  const bindings = new Set(decidedRows.map((w) => w.bindingId)).size;
  // A-005 E2：门槛 = 不同绑定数
  if (bindings < THRESHOLDS.withdrawalBindings)
    return unavailable('withdrawal', decidedRows.length, `样本不足（${bindings} 个绑定，需 ≥ ${THRESHOLDS.withdrawalBindings}）`, {
      sample: decidedRows.length,
      bindings,
    });
  const refused = decidedRows.filter((w) => w.outcome === 'refused' || overdue(w)).length;
  const decided = decidedRows.length;
  const paidMins = decidedRows.filter((w) => w.outcome === 'paid').map((w) => (w.receivedAt!.getTime() - w.requestedAt.getTime()) / 60_000);
  const med = median(paidMins);
  const refusalRate = refused / decided;
  const t = med == null ? 0 : timeScore(med);
  const r = clamp((1 - refusalRate * WITHDRAWAL.refusalK) * 100);
  return {
    ...base('withdrawal'),
    score: round(clamp(WITHDRAWAL.timeShare * t + WITHDRAWAL.refusalShare * r)),
    available: true,
    sampleSize: decided,
    detail: `${med == null ? '无到账样本' : `中位到账 ${fmtDuration(med)}`}；拒付率 ${pct(refusalRate)}`,
    metrics: { medianMinutes: med == null ? null : Math.round(med * 10) / 10, refusalRate: Math.round(refusalRate * 10000) / 10000, sample: decided, bindings },
  };
}

export function arbitrationFactor(b: BrandInput, now: Date): Factor {
  const cs = b.complaints.filter((c) => inWindow(c.acceptedAt, now));
  // 失联（已曝光）按未解决计；驳回（用户主张不成立）不计入运营商分母
  // 自检 I3：门槛只计已结案（解决 / 未解决 / 曝光）的案件，进行中的不计
  const resolved = cs.filter((c) => c.status === 'resolved').length;
  const failed = cs.filter((c) => c.status === 'unresolved' || c.status === 'exposed').length;
  const denom = resolved + failed;
  if (denom < THRESHOLDS.arbitrationCases)
    return unavailable('arbitration', denom, cs.length ? `样本不足（已结案 ${denom}，需 ≥ ${THRESHOLDS.arbitrationCases}）` : '暂无案件', { sample: denom });
  const resolveRate = resolved / denom;
  // 自检 I3：未答辩的案件只有答辩期届满（replyDeadline 或通知后 7 天）才按上限计入响应时长
  const windowOver = (c: (typeof cs)[number]) =>
    now.getTime() >= (c.replyDeadline?.getTime() ?? c.operatorNotifiedAt!.getTime() + ARBITRATION.noReplyDays * DAY);
  const respDays = cs
    .filter((c) => c.operatorNotifiedAt && (c.operatorRepliedAt || windowOver(c)))
    .map((c) =>
      c.operatorRepliedAt ? Math.max(0, (c.operatorRepliedAt.getTime() - c.operatorNotifiedAt!.getTime()) / DAY) : ARBITRATION.noReplyDays,
    );
  const med = median(respDays);
  const { responseFullDays: f, responseZeroDays: z } = ARBITRATION;
  const resp = med == null ? 0 : clamp(((z - med) / (z - f)) * 100);
  return {
    ...base('arbitration'),
    score: round(clamp(ARBITRATION.resolveShare * resolveRate * 100 + ARBITRATION.responseShare * resp)),
    available: true,
    sampleSize: denom,
    detail: `解决率 ${pct(resolveRate)}${med == null ? '' : `；中位响应 ${Math.round(med * 10) / 10} 天`}${failed ? `；${failed} 件未解决 / 失联` : ''}`,
    metrics: { resolveRate: Math.round(resolveRate * 10000) / 10000, medianResponseDays: med == null ? null : Math.round(med * 10) / 10, sample: denom },
  };
}

export function reviewsFactor(b: BrandInput, now: Date): Factor {
  const rs = b.reviews.filter((r) => inWindow(r.createdAt, now));
  // S4：门槛按有效样本 Σ trustWeight
  const eff = rs.reduce((s, r) => s + r.trustWeight, 0);
  if (eff < THRESHOLDS.reviewEffective)
    return unavailable('playerReviews', rs.length, `样本不足（有效 ${Math.round(eff * 10) / 10}，需 ≥ ${THRESHOLDS.reviewEffective}）`, {
      sample: rs.length,
      effectiveSample: Math.round(eff * 10) / 10,
    });
  const avg = rs.reduce((s, r) => s + r.rating * r.trustWeight, 0) / eff;
  return {
    ...base('playerReviews'),
    score: round(clamp(((avg - REVIEWS.minRating) / (REVIEWS.maxRating - REVIEWS.minRating)) * 100)),
    available: true,
    sampleSize: rs.length,
    detail: `可信加权 ${Math.round(avg * 10) / 10} / 5`,
    metrics: { weightedRating: Math.round(avg * 100) / 100, effectiveSample: Math.round(eff * 10) / 10, sample: rs.length },
  };
}

export function hardMetricsFactor(b: BrandInput): Factor {
  const DIMS = Object.keys(HARD.dims) as (keyof typeof HARD.dims)[];
  const scored = b.attributes.filter((a) => (DIMS as string[]).includes(a.dimension));
  // 自检 S-e：只有计分维度有数据才算可用；核验比例也只算计分维度
  if (!scored.length) return unavailable('hardMetrics', null, '暂无采集数据');
  const dim = (d: keyof typeof HARD.dims) => {
    const a = b.attributes.find((x) => x.dimension === d);
    if (!a) return { score: 0, count: 0, verified: false };
    const s = Math.min(a.values.length / HARD.full[d], 1) * 100 * (a.verified ? 1 : HARD.unverifiedFactor);
    return { score: s, count: a.values.length, verified: a.verified };
  };
  const p = dim('payment');
  const g = dim('gameProvider');
  const s = dim('support');
  const verifiedRatio = scored.filter((a) => a.verified).length / scored.length;
  const wsum = DIMS.reduce((x, d) => x + HARD.dims[d], 0);
  return {
    ...base('hardMetrics'),
    score: round(clamp((p.score * HARD.dims.payment + g.score * HARD.dims.gameProvider + s.score * HARD.dims.support) / wsum)),
    available: true,
    sampleSize: null,
    detail: `${p.count} 种支付、${g.count} 家游戏商、${s.count} 项客服${verifiedRatio < 1 ? '；部分数据未核验' : ''}`,
    metrics: { payments: p.count, providers: g.count, supportChannels: s.count, verifiedRatio: Math.round(verifiedRatio * 100) / 100 },
  };
}

export function stabilityFactor(b: BrandInput, now: Date): Factor {
  const listedDays = Math.floor((now.getTime() - new Date(b.listedSince).getTime()) / DAY);
  if (listedDays < THRESHOLDS.stabilityListedDays)
    return unavailable('stability', null, `收录 < ${THRESHOLDS.stabilityListedDays} 天，观察中`, { listedDays });
  const years = b.foundedYear == null ? 0 : Math.max(0, now.getUTCFullYear() - b.foundedYear);
  const yearsScore = Math.min(years / STABILITY.fullYears, 1) * 100;
  // 自检 S-e：在线状态未知（null）的域名不计入分母
  const known = b.officialDomains.filter((d) => d.online != null);
  const domains = known.length;
  const online = known.filter((d) => d.online).length;
  const domainScore = domains ? (online / domains) * 100 : STABILITY.noDomainScore;
  const riskScore = b.linkedToBlacklist ? 0 : 100;
  return {
    ...base('stability'),
    score: round(clamp(STABILITY.yearsShare * yearsScore + STABILITY.domainShare * domainScore + STABILITY.riskShare * riskScore)),
    available: true,
    sampleSize: null,
    detail: `${b.foundedYear == null ? '运营年限不明' : `运营 ${years} 年`}；官方域名在线 ${online}/${domains}${b.linkedToBlacklist ? '；与黑名单存在关联' : ''}`,
    metrics: { years: b.foundedYear == null ? null : years, domainOnlineRatio: domains ? Math.round((online / domains) * 100) / 100 : null, linkedToBlacklist: b.linkedToBlacklist ? 1 : 0 },
  };
}
