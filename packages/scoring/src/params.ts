/**
 * 评分算法参数（A-003 C1）：子分公式常量、门槛、权重全部集中于此。改公式只改本文件并升版本号。
 * 来源：A-003 草案 + 审核修正 S1–S5；PO 2026-09-27 定稿为 v0.3（A-006）。
 * v0.4 = v0.3 + A-005（W1）：出款门槛按不同绑定计，每绑定 30 天滑动窗口内最多计 3 条。
 */
export const ALGORITHM_VERSION = 'v0.4';

export const WEIGHTS = { withdrawal: 30, arbitration: 25, hardMetrics: 20, playerReviews: 15, stability: 10 } as const;
export type FactorKey = keyof typeof WEIGHTS;
export const FACTOR_ORDER: FactorKey[] = ['withdrawal', 'arbitration', 'hardMetrics', 'playerReviews', 'stability'];
export const LABELS: Record<FactorKey, string> = {
  withdrawal: '出款表现',
  arbitration: '仲裁履约',
  hardMetrics: '平台硬指标',
  playerReviews: '玩家评价',
  stability: '经营稳定性',
};

/** S5 严格口径（PO 2026-09-27 确认）：履约类因子全部不足时 score = null */
export const PERFORMANCE_FACTORS: FactorKey[] = ['withdrawal', 'arbitration', 'playerReviews'];
export const STRICT_PERFORMANCE_GATE = true;

/** S2：滚动窗口（天），适用于出款 / 仲裁 / 评价 */
export const WINDOW_DAYS = 180;

export const THRESHOLDS = {
  /** S1 + A-005 E2：已有结论的绑定用户凭证中，不同绑定数 ≥ 20 */
  withdrawalBindings: 20,
  /** 已结案案件数（解决 / 未解决 / 曝光） */
  arbitrationCases: 5,
  /** S4：有效样本量 Σ trustWeight */
  reviewEffective: 30,
  /** 收录天数 */
  stabilityListedDays: 30,
} as const;

export const WITHDRAWAL = {
  /** S3：pending 超过该小时数计入拒付 */
  pendingAsRefusedHours: 72,
  timeShare: 0.6,
  refusalShare: 0.4,
  /** 到账时长分：≤ 1h 100、24h 50、≥ 72h 0，分段对数插值 */
  fullMinutes: 60,
  halfMinutes: 1440,
  zeroMinutes: 4320,
  /** 拒付分 = max(0, 1 − 拒付率 × k) × 100 */
  refusalK: 5,
  /** A-005 E1：每个绑定在任意 30 天滑动窗口内最多计入 3 条（按 requestedAt 升序、同刻按 id） */
  perBindingCap: 3,
  capWindowDays: 30,
} as const;

export const ARBITRATION = {
  resolveShare: 0.7,
  responseShare: 0.3,
  /** 响应分：中位 ≤ 1 天 100、≥ 7 天 0，线性 */
  responseFullDays: 1,
  responseZeroDays: 7,
  /** 已通知未答辩：按答辩期上限计 */
  noReplyDays: 7,
} as const;

export const REVIEWS = {
  /** 星级 → 0–100：(avg − min) / (max − min) × 100 */
  minRating: 1,
  maxRating: 5,
} as const;

export const HARD = {
  /** 计分维度与各自权重（等权）；只要其中任一维度有数据即视为可用 */
  dims: { payment: 1, gameProvider: 1, support: 1 },
  /** 各维度计数满分所需数量 */
  full: { payment: 4, gameProvider: 4, support: 3 },
  /** 未核验维度系数 */
  unverifiedFactor: 0.7,
} as const;

export const STABILITY = {
  yearsShare: 0.5,
  domainShare: 0.3,
  riskShare: 0.2,
  fullYears: 5,
  /** 无官方域名时的域名稳定分 */
  noDomainScore: 50,
} as const;

/**
 * 「与黑名单关联」判定（稳定性风险分，自检 I4）：只认人工确认、置信度达标的关联边；
 * 仿冒边（impersonates）与仿冒标识不算（它们挂在受害品牌上）。
 */
export const BLACKLIST_LINK = {
  requireHuman: true,
  minConfidence: 0.8,
  excludeLinkTypes: ['impersonates'] as readonly string[],
} as const;

/** 置信度：可用因子数 → 等级 */
export function confidenceOf(available: number): 'none' | 'low' | 'medium' | 'high' {
  return available === 0 ? 'none' : available <= 2 ? 'low' : available <= 4 ? 'medium' : 'high';
}
