// 跨域聚合载荷（首页 / 品牌详情）：组合四个领域的 schema，供 apps/api 与 apps/web 共用
import { z } from 'zod';
import { Fact, TimelineEvent } from '../shared/index';
import { BrandCard, LibCounts } from '../trust/index';
import { Offer } from '../commerce/index';
import { MeBrief } from '../identity/index';

export const BrandDetail = BrandCard.extend({
  operator: z
    .object({
      legalName: z.string().nullable().optional(),
      jurisdiction: z.string().nullable().optional(),
      foundedYear: z.number().int().nullable().optional(),
      relatedParty: z.boolean().optional(),
    })
    .optional(),
  counts: z
    .object({
      complaints: z.number().int().optional(),
      withdrawalReports: z.number().int().optional(),
      identifiers: z.number().int().optional(),
      offers: z.number().int().optional(),
    })
    .optional(),
  facts: z.array(Fact).optional(),
  featuredOffer: Offer.nullable().optional(),
  statusHistory: z.array(TimelineEvent).optional(),
});

export const HomePayload = z.object({
  stats: z
    .object({
      brandsIndexed: z.number().int().optional(),
      blacklisted: z.number().int().optional(),
      blacklistedToday: z.number().int().optional(),
      complaintsHandled: z.number().int().optional(),
      resolveRate: z.number().optional(),
      medianResolveDays: z.number().optional(),
      certifiedDepositsUsdt: z.number().optional(),
      series: z.record(z.string(), z.array(z.number())).optional(),
    })
    .optional(),
  alerts: z
    .object({
      fakeToday: z.number().int().optional(),
      latestFake: z.object({ value: z.string().optional(), impersonates: z.string().optional() }).optional(),
    })
    .optional(),
  featured: BrandCard.optional(),
  gauges: z.array(BrandCard).max(4).optional(),
  libs: LibCounts.optional(),
  hotCandidates: z
    .array(z.object({ value: z.string().optional(), type: z.string().optional(), queryCount7d: z.number().int().optional() }))
    .optional(),
  feed: z
    .array(
      z.object({
        date: z.iso.date().optional(),
        subject: z.string().optional(),
        rest: z.string().optional(),
        kind: z.enum(['fake', 'exposed', 'blacklist', 'resolved', 'watch']).optional(),
        ref: z.string().optional(),
      }),
    )
    .optional(),
  featuredOffer: Offer.optional(),
  content: z
    .array(z.object({ type: z.enum(['lab', 'guide']).optional(), title: z.string().optional(), meta: z.string().optional(), slug: z.string().optional() }))
    .optional(),
  me: MeBrief.nullable().optional(),
});

export type BrandDetail = z.infer<typeof BrandDetail>;
export type HomePayload = z.infer<typeof HomePayload>;
