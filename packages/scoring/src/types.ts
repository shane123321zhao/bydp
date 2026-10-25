/** scoring 自有类型：不依赖 @bydp/core / @bydp/db / @bydp/tracking（ADR-0006） */
import type { FactorKey } from './params';

export type BrandStatus = 'certified' | 'watch' | 'blacklist';

export type BrandInput = {
  id: string;
  slug: string;
  status: BrandStatus;
  statusSince: string; // YYYY-MM-DD
  foundedYear: number | null;
  /** 首次收录日（status_history 最早记录与 statusSince 取早） */
  listedSince: string;
  withdrawals: {
    id: string;
    bindingId: string | null;
    kind: 'user' | 'official';
    fromBinding: boolean;
    outcome: 'paid' | 'refused' | 'pending';
    requestedAt: Date;
    receivedAt: Date | null;
  }[];
  complaints: {
    status: string;
    acceptedAt: Date | null;
    operatorNotifiedAt: Date | null;
    operatorRepliedAt: Date | null;
    replyDeadline: Date | null;
  }[];
  reviews: { rating: number; trustWeight: number; createdAt: Date }[];
  attributes: { dimension: string; values: string[]; verified: boolean }[];
  officialDomains: { online: boolean | null }[];
  /** 与黑名单品牌存在关联边或共用标识 */
  linkedToBlacklist: boolean;
};

export type FactorMetrics = Record<string, number | null>;

export type Factor = {
  key: FactorKey;
  label: string;
  weight: number;
  score: number | null;
  available: boolean;
  sampleSize: number | null;
  detail: string;
  /** A-003 C3：结构化指标（core 直接读，不再解析 detail 文本） */
  metrics: FactorMetrics;
};

export type Snapshot = {
  brandId: string;
  algorithmVersion: string;
  computedAt: Date;
  score: number | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  factorsAvailable: number;
  factorsTotal: number;
  factors: Factor[];
};
