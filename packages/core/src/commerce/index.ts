// 商业域（优惠 / 领码）。ADR-0006：packages/scoring 禁止依赖本模块。
import { z } from 'zod';
import { BrandCard } from '../trust/index';

export const OfferTerms = z.object({
  rolloverMultiple: z.number().optional(),
  rolloverBase: z.string().optional(),
  maxWithdrawalUsdt: z.number().nullable().optional(),
  validDays: z.number().int().optional(),
  restrictedGames: z.array(z.string()).optional(),
  eligibleGames: z.array(z.string()).optional(),
});

export const OfferTrueValue = z.object({
  exampleDepositUsdt: z.number().optional(),
  bonusUsdt: z.number().optional(),
  requiredTurnoverUsdt: z.number().optional(),
  expectedCostAtRtp96Usdt: z.number().optional(),
  netExpectedValueUsdt: z.number().optional(),
  verdict: z.enum(['positive', 'negative']).optional(),
  verdictText: z.string().optional(),
});

export const Offer = z.object({
  id: z.string().optional(),
  brand: BrandCard.optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  terms: OfferTerms.optional(),
  trueValue: OfferTrueValue.optional(),
  exclusive: z.boolean().optional(),
  sponsored: z.boolean().optional(),
  riskLabel: z.string().nullable().optional(),
  compensationEligible: z.boolean().optional(),
  claimedCount: z.number().int().optional(),
  validUntil: z.iso.date().optional(),
});

/** POST /offers/{id}/claim 返回（契约 v1.6：code / trackingUrl 可空） */
export const ClaimResponse = z.object({
  clickId: z.string(),
  code: z.string().nullable(),
  trackingUrl: z.url().nullable(),
  riskLabel: z.string().nullable(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const OfferStats = z.object({
  positive: z.number().int().optional(),
  subsidy: z.number().int().optional(),
  claimed: z.number().int().optional(),
});

export const OfferFilter = z.enum(['all', 'cert', 'pos', 'sports', 'live', 'slots']);
export const OffersQuery = z.object({ filter: OfferFilter.default('all'), cursor: z.string().optional() });
export const OffersPage = z.object({
  stats: OfferStats.optional(),
  items: z.array(Offer).optional(),
  next: z.string().nullable().optional(),
});

export const ClaimResult = z.object({
  code: z.string(),
  trackingUrl: z.url(),
  riskLabel: z.string().nullable().optional(),
});

export type Offer = z.infer<typeof Offer>;
export type OffersPage = z.infer<typeof OffersPage>;
export type ClaimResult = z.infer<typeof ClaimResult>;
