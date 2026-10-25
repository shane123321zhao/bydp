/**
 * /check 五态判定（架构 §5 三层口径 × §9.1）：Brand.status × Identifier.ownership → verdict。
 * 判定语固定五句（rules/i18n.md）。
 */
export type BrandStatus = 'certified' | 'watch' | 'blacklist';
export type Ownership = 'official' | 'fake' | 'pending';
export type Verdict = 'blacklist' | 'certified' | 'fake' | 'watch' | 'unknown';

export const VERDICT_TEXT: Record<Verdict, string> = {
  blacklist: '别存。',
  certified: '可以存。',
  fake: '这是假的。',
  watch: '谨慎。',
  unknown: '先别存。',
};

/**
 * - 仿冒标识 → fake（无论被冒充品牌状态）
 * - 官方标识 → 品牌状态
 * - 待查标识（pending）→ 黑名单品牌仍判 blacklist；否则最多 watch（归属未确认，不给"可以存"）
 * - 未命中 → unknown
 */
export function decideVerdict(match: { ownership: Ownership; brandStatus: BrandStatus | null } | null): Verdict {
  if (!match) return 'unknown';
  if (match.ownership === 'fake') return 'fake';
  if (!match.brandStatus) return 'unknown';
  if (match.ownership === 'pending') return match.brandStatus === 'blacklist' ? 'blacklist' : 'watch';
  return match.brandStatus;
}
