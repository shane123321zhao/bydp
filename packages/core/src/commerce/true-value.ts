/**
 * 优惠「真实价值」换算（architecture v1.19 §8.1 · D-029 · 审核 W2#019）。纯函数；导入 / 录入 / 重算都只经这里，**不接受手填**。
 * - 原则：玩家按条款打满流水后的期望净值（USDT），宁可低估、不可夸大。
 * - 参数表随版本走（TV_METHOD_VERSION）；参数变更须升版本并全量重算（worker offers-recompute，写 audit）。
 * - 支持四类：首存匹配 / 再存匹配 / 免死金 / 周返水；其他类型首版不支持（抛 TrueValueError「类型不支持」）。
 */
export const TV_METHOD_VERSION = 'tv-1';

/** 庄家优势 e（tv-1）。玩法按关键字归类；适用游戏多类时取最高 e（保守） */
const CATEGORIES: { key: string; name: string; edge: number; match: RegExp }[] = [
  { key: 'slot', name: '老虎机', edge: 0.04, match: /老虎机|电子|slot/i },
  { key: 'fishing', name: '捕鱼', edge: 0.04, match: /捕鱼|fish/i },
  { key: 'sports', name: '体育', edge: 0.05, match: /体育|sport/i },
  { key: 'live', name: '真人', edge: 0.012, match: /真人|百家乐|轮盘|骰宝|baccarat|live/i },
];
const EXAMPLE_DEPOSIT = 200;
const EXAMPLE_WEEKLY_TURNOVER = 1000;
const P_LOSE_FIRST_BET = 0.5;

export type OfferType = 'first_deposit_match' | 'reload_match' | 'risk_free_bet' | 'weekly_rebate';
export const OFFER_TYPES: Record<OfferType, string> = { first_deposit_match: '首存匹配', reload_match: '再存匹配', risk_free_bet: '免死金', weekly_rebate: '周返水' };
export type RolloverBase = 'deposit_plus_bonus' | 'bonus' | 'deposit' | 'none';

export type TrueValueInput = {
  type: string;
  matchPercent?: number | null;
  maxBonusUsdt?: number | null;
  minDepositUsdt?: number | null;
  terms: {
    rolloverMultiple: number;
    rolloverBase: RolloverBase | string;
    maxWithdrawalUsdt?: number | null;
    eligibleGames: string[];
    /** 流水贡献率 %，缺省 100 */
    contributionPercent?: number | null;
    /** 返水比例 %（周返水） */
    rebatePercent?: number | null;
  };
};

export type TrueValue = {
  exampleDepositUsdt: number;
  bonusUsdt: number;
  requiredTurnoverUsdt: number;
  expectedCostAtRtp96Usdt: number;
  netExpectedValueUsdt: number;
  verdict: 'positive' | 'negative';
  verdictText: string;
  methodVersion: typeof TV_METHOD_VERSION;
};

export class TrueValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrueValueError';
  }
}

/** 四舍五入到整数 USDT（负数按绝对值进位：-40.5 → -41）；避免 -0 */
const round = (n: number) => Math.sign(n) * Math.round(Math.abs(n)) || 0;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const pct = (e: number) => Number(((1 - e) * 100).toFixed(1)).toString();

/** 适用游戏 → 取最高 e 的玩法；有任何一项无法归类即报错（不猜） */
export function edgeOf(games: string[]): { edge: number; name: string } {
  if (!games.length) throw new TrueValueError('适用游戏不能为空（用于确定庄家优势）');
  let best: { edge: number; name: string } | null = null;
  for (const g of games) {
    const c = CATEGORIES.find((x) => x.match.test(g));
    if (!c) throw new TrueValueError(`适用游戏「${g}」无法归类（支持：老虎机 / 电子、捕鱼、体育、真人 / 百家乐等）`);
    if (!best || c.edge > best.edge) best = { edge: c.edge, name: c.name };
  }
  return best!;
}

function turnover(base: string, multiple: number, d: number, b: number) {
  if (multiple < 0) throw new TrueValueError('流水倍数不能为负');
  if (base === 'none' || multiple === 0) return 0;
  if (base === 'deposit_plus_bonus') return multiple * (d + b);
  if (base === 'bonus') return multiple * b;
  if (base === 'deposit') return multiple * d;
  throw new TrueValueError(`流水基数「${base}」不支持`);
}

function contribution(c: number | null | undefined) {
  const v = c ?? 100;
  if (!(v > 0 && v <= 100)) throw new TrueValueError('流水贡献率须在 1–100% 之间');
  return v / 100;
}

/** W2#021 小改 1：用到的数值须为有限数（缺省允许 null / undefined，但不能是 NaN / 字符串）；否则 NaN 会经取整静默变 0 */
function assertNumbers(o: TrueValueInput) {
  const t = o.terms;
  if (!Number.isFinite(t?.rolloverMultiple)) throw new TrueValueError('流水倍数须为数字');
  const optional: [unknown, string][] = [
    [o.matchPercent, '匹配比例'],
    [o.maxBonusUsdt, '最高奖励'],
    [o.minDepositUsdt, '最低存款'],
    [t.maxWithdrawalUsdt, '最高提款'],
    [t.contributionPercent, '流水贡献率'],
    [t.rebatePercent, '返水比例'],
  ];
  for (const [v, label] of optional) if (v != null && !Number.isFinite(v)) throw new TrueValueError(`${label}须为数字`);
}

export function computeTrueValue(o: TrueValueInput): TrueValue {
  assertNumbers(o);
  const t = o.terms;
  const c = contribution(t.contributionPercent);
  const cap = t.maxWithdrawalUsdt ?? null;
  const out = (p: { d: number; b: number; T: number; cost: number; n: number; text: string }): TrueValue => {
    const n = round(p.n);
    return {
      exampleDepositUsdt: round(p.d),
      bonusUsdt: round(p.b),
      requiredTurnoverUsdt: round(p.T),
      expectedCostAtRtp96Usdt: round(p.cost),
      netExpectedValueUsdt: n,
      verdict: n > 0 ? 'positive' : 'negative',
      verdictText: p.text.replace('{N}', signed(n)),
      methodVersion: TV_METHOD_VERSION,
    };
  };
  // capped：是否追加「上限 X USDT」——匹配类按 B + D 判断；返水只按返水额 B 判断（W2#021 小改 3：W 是周流水，不是存款）
  const matchText = (e: { edge: number; name: string }, n: number, capped: boolean) =>
    `按 ${pct(e.edge)}% RTP ${e.name}打满流水，期望净值约 {N} USDT；${round(n) > 0 ? '扣除流水成本后仍为正' : '奖励实为流水补贴，不是净收益'}${capped ? `；上限 ${cap} USDT` : ''}`;

  switch (o.type) {
    case 'first_deposit_match':
    case 'reload_match': {
      const m = o.matchPercent ?? 0;
      const maxB = o.maxBonusUsdt ?? 0;
      if (!(m > 0)) throw new TrueValueError('匹配类须填匹配比例（大于 0）');
      if (!(maxB > 0)) throw new TrueValueError('匹配类须填最高奖励（大于 0）');
      const min = o.minDepositUsdt ?? 0;
      const hi = maxB / (m / 100);
      const d = Math.min(Math.max(EXAMPLE_DEPOSIT, min), Math.max(hi, min));
      const b = Math.min((d * m) / 100, maxB);
      const T = turnover(t.rolloverBase, t.rolloverMultiple, d, b);
      const e = edgeOf(t.eligibleGames);
      const cost = (T / c) * e.edge;
      const n = b - cost;
      return out({ d, b, T, cost, n, text: matchText(e, n, cap != null && b + d > cap) });
    }
    case 'risk_free_bet': {
      const b = o.maxBonusUsdt ?? 0;
      if (!(b > 0)) throw new TrueValueError('免死金须填最高奖励（大于 0）');
      const d = b;
      const T = turnover(t.rolloverBase, t.rolloverMultiple, d, b);
      const e = edgeOf(t.eligibleGames);
      const cost = (T / c) * e.edge;
      const n = P_LOSE_FIRST_BET * (b - cost) - d * e.edge;
      return out({ d, b, T, cost, n, text: `首单输掉返还 ${round(b)} USDT 奖励金，${t.rolloverMultiple} 倍流水后期望净值约 {N} USDT${cap != null ? `；上限 ${cap} USDT` : ''}` });
    }
    case 'weekly_rebate': {
      const r = t.rebatePercent ?? null;
      if (!(r != null && r > 0 && r <= 100)) throw new TrueValueError('周返水须填返水比例（0–100%）');
      // W2#021 小改 2：返水没有「存款」，流水基数只能是「无」或「奖励」（deposit 会让 T = 0 被误当成无流水）
      if (t.rolloverBase !== 'none' && t.rolloverBase !== 'bonus') throw new TrueValueError('周返水的流水基数只能是「无」或「奖励」');
      const w = EXAMPLE_WEEKLY_TURNOVER;
      const b = (w * r) / 100;
      const T = turnover(t.rolloverBase, t.rolloverMultiple, 0, b);
      if (!T) return out({ d: w, b, T: 0, cost: 0, n: b, text: '无流水要求，按周结算，返水即净收益' });
      const e = edgeOf(t.eligibleGames);
      const cost = (T / c) * e.edge;
      const n = b - cost;
      return out({ d: w, b, T, cost, n, text: matchText(e, n, cap != null && b > cap) });
    }
    default:
      throw new TrueValueError(`优惠类型「${o.type}」不支持（首版只支持：${Object.values(OFFER_TYPES).join(' / ')}）`);
  }
}
