// 信任域 + 运营商域（品牌 / 标识 / 关联 / 评分 / 查验 / 名单）
import { z } from 'zod';
import { BrandStatus, Confidence, Fact, LocalizedName, Ownership, TimelineEvent, Verdict } from '../shared/index';

export const License = z.object({
  regulator: z.string().optional(),
  licenseNo: z.string().optional(),
  valid: z.boolean().optional(),
  verifiedAt: z.iso.date().optional(),
});

export const ScoreBrief = z.object({
  score: z.number().int().min(0).max(100).nullable().optional(),
  confidence: Confidence.optional(),
  factorsAvailable: z.number().int().optional(),
  factorsTotal: z.number().int().optional(),
  algorithmVersion: z.string().optional(),
  computedAt: z.iso.datetime({ offset: true }).optional(),
});

export const ScoreFactor = z.object({
  key: z.string().optional(),
  label: z.string().optional(),
  weight: z.number().int().optional(),
  score: z.number().int().nullable().optional(),
  available: z.boolean().optional(),
  sampleSize: z.number().int().nullable().optional(),
  detail: z.string().optional(),
});

export const ScoreSnapshot = ScoreBrief.extend({ factors: z.array(ScoreFactor).optional() });

export const BrandCard = z.object({
  id: z.string(),
  slug: z.string(),
  name: LocalizedName,
  status: BrandStatus,
  hasActiveExposure: z.boolean().optional(),
  markets: z.array(z.string()).optional(),
  license: License.nullable().optional(),
  score: ScoreBrief.nullable().optional(),
  certifiedDepositUsdt: z.number().nullable().optional(),
  summaryLine: z.string().optional(),
  /** 契约 v1.4（D-004）：官方主域 Identifier(domain, official, primary)；无则 null */
  primaryDomain: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  /** count(review)，无则 0 */
  reviewCount: z.number().int().optional(),
});

export const Identifier = z.object({
  id: z.string().optional(),
  type: z.enum(['domain', 'mirror', 'app', 'tg', 'wallet', 'phone']).optional(),
  value: z.string().optional(),
  ownership: Ownership.optional(),
  chain: z.string().nullable().optional(),
  firstSeen: z.iso.date().optional(),
  lastChecked: z.iso.date().optional(),
  online: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

export const EntityLinkRow = z.object({
  subject: z.string().optional(),
  subjectType: z.enum(['identifier', 'brand']).optional(),
  subjectRef: z.string().optional(),
  linkType: z.enum(['shared_wallet', 'same_template', 'impersonates', 'same_operator', 'shared_support']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  confirmedBy: z.enum(['agent', 'human']).optional(),
  evidence: z.string().optional(),
  tag: z.string().optional(),
});

export const RiskSignal = z.object({
  signal: z.string().optional(),
  detail: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  source: z.string().optional(),
});

export const CheckQuery = z.object({ q: z.string().max(256) });

export const CheckResult = z.object({
  query: z.string(),
  normalized: z.object({ type: z.string().optional(), value: z.string().optional() }).optional(),
  verdict: Verdict,
  matchNote: z.string().optional(),
  checkedAt: z.iso.datetime({ offset: true }).optional(),
  brand: BrandCard.nullable().optional(),
  operatorName: z.string().nullable().optional(),
  facts: z.array(Fact).max(3).optional(),
  related: z.array(EntityLinkRow).optional(),
  factors: z.array(z.object({}).passthrough()).optional(),
  officialIdentifiers: z.array(Identifier).optional(),
  riskSignals: z.array(RiskSignal).optional(),
  timeline: z.array(TimelineEvent).optional(),
  candidate: z
    .object({ id: z.string().optional(), queryCount7d: z.number().int().optional(), weightedPriority: z.number().optional() })
    .nullable()
    .optional(),
  alternative: BrandCard.nullable().optional(),
  /** D-019：未收录态的模糊候选（≤ 5，仅提示，不改变判定） */
  suggestions: z.array(BrandCard).max(5).optional(),
});

export const WithdrawalStats = z.object({
  medianMinutes: z.number().optional(),
  refusalRate: z.number().optional(),
  sampleSize: z.number().int().optional(),
  buckets: z
    .array(z.object({ label: z.string().optional(), share: z.number().optional(), count: z.number().int().optional(), note: z.string().optional() }))
    .optional(),
  officialChecks: z
    .array(
      z.object({
        id: z.string().optional(),
        method: z.string().optional(),
        amountUsdt: z.number().optional(),
        minutes: z.number().optional(),
        at: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .optional(),
});

export const ListLib = z.enum(['certified', 'watch', 'licensed', 'blacklist']);
export const ListQuery = z.object({
  region: z.enum(['MY', 'SG', 'PH', 'TH', 'VN', 'TW', 'HK']).optional(),
  sort: z.enum(['score_desc', 'listed_at_desc']).default('score_desc'),
  cursor: z.string().optional(),
});
export const LibCounts = z.object({
  certified: z.number().int().optional(),
  watch: z.number().int().optional(),
  licensed: z.number().int().optional(),
  blacklist: z.number().int().optional(),
});
export const ListPage = z.object({
  lib: z.string().optional(),
  counts: LibCounts.optional(),
  kpi: z.array(Fact).optional(),
  note: z.string().optional(),
  items: z.array(BrandCard).optional(),
  next: z.string().nullable().optional(),
});

export type License = z.infer<typeof License>;
export type ScoreBrief = z.infer<typeof ScoreBrief>;
export type ScoreSnapshot = z.infer<typeof ScoreSnapshot>;
export type BrandCard = z.infer<typeof BrandCard>;
export type Identifier = z.infer<typeof Identifier>;
export type EntityLinkRow = z.infer<typeof EntityLinkRow>;
export type CheckResult = z.infer<typeof CheckResult>;
export type WithdrawalStats = z.infer<typeof WithdrawalStats>;
export type ListPage = z.infer<typeof ListPage>;

/** 判定用语固定五句（rules/i18n.md），真源在 entity-graph */
export { VERDICT_TEXT } from '@bydp/entity-graph';
