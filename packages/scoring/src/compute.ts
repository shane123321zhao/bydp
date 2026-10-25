/** 单品牌评分：纯函数、确定性（A-003 C5） */
import { ALGORITHM_VERSION, FACTOR_ORDER, PERFORMANCE_FACTORS, STRICT_PERFORMANCE_GATE, confidenceOf } from './params';
import { arbitrationFactor, hardMetricsFactor, reviewsFactor, stabilityFactor, withdrawalFactor } from './factors';
import type { BrandInput, Factor, Snapshot } from './types';

export function computeBrand(b: BrandInput, computedAt: Date): Snapshot {
  const now = computedAt;
  const byKey: Record<string, Factor> = {
    withdrawal: withdrawalFactor(b, now),
    arbitration: arbitrationFactor(b, now),
    hardMetrics: hardMetricsFactor(b),
    playerReviews: reviewsFactor(b, now),
    stability: stabilityFactor(b, now),
  };
  let factors = FACTOR_ORDER.map((k) => byKey[k]!);
  const available = factors.filter((f) => f.available);
  const perfAvailable = available.some((f) => PERFORMANCE_FACTORS.includes(f.key));
  let score: number | null = null;
  if (b.status !== 'blacklist' && available.length && (!STRICT_PERFORMANCE_GATE || perfAvailable)) {
    const w = available.reduce((s, f) => s + f.weight, 0);
    score = Math.round(available.reduce((s, f) => s + f.weight * f.score!, 0) / w);
  }
  // 黑名单不计分：因子明细保留供展示，分数一律置空（§5 / 审查 #1）
  if (b.status === 'blacklist') factors = factors.map((f) => ({ ...f, score: null }));
  return {
    brandId: b.id,
    algorithmVersion: ALGORITHM_VERSION,
    computedAt,
    score,
    confidence: score == null ? 'none' : confidenceOf(available.length),
    factorsAvailable: available.length,
    factorsTotal: FACTOR_ORDER.length,
    factors,
  };
}
