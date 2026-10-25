// 跨域基础类型（api-contract.yaml components/schemas）
import { z } from 'zod';

/** 契约 components.schemas.Error：4xx 统一错误体（code 机器可读；message 面向用户，可为空串）。对外 401 不带 code */
// A-019（D-024）：+ binding_required / report_limit / already_reviewed / invalid_time（评价 / 出款凭证提交）
export const ApiErrorCode = z.enum(['self_excluded', 'already_bound', 'blacklist', 'related_party', 'already_claimed', 'invalid_argument', 'not_found', 'rate_limited', 'open_complaints', 'binding_required', 'report_limit', 'already_reviewed', 'invalid_time']);
export const ApiError = z.object({ code: ApiErrorCode, message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const LocalizedName = z.object({ zhHans: z.string().optional(), zhHant: z.string().optional(), en: z.string().optional() });
export const BrandStatus = z.enum(['certified', 'watch', 'blacklist']);
export const Ownership = z.enum(['official', 'fake', 'pending']);
export const Confidence = z.enum(['none', 'low', 'medium', 'high']);
export const Verdict = z.enum(['blacklist', 'certified', 'fake', 'watch', 'unknown']);
export const Region = z.enum(['MY', 'SG', 'PH', 'TH', 'VN', 'TW', 'HK']);

export const Fact = z.object({
  v: z.string().optional(),
  k: z.string().optional(),
  tone: z.enum(['neutral', 'red', 'amber', 'green', 'purple']).optional(),
});

export const TimelineEvent = z.object({
  date: z.iso.datetime({ offset: true }).optional(),
  subject: z.string().optional(),
  rest: z.string().optional(),
  kind: z.enum(['info', 'decision', 'warning']).optional(),
});

export type LocalizedName = z.infer<typeof LocalizedName>;
export type BrandStatus = z.infer<typeof BrandStatus>;
export type Ownership = z.infer<typeof Ownership>;
export type Confidence = z.infer<typeof Confidence>;
export type Verdict = z.infer<typeof Verdict>;
export type Fact = z.infer<typeof Fact>;
export type TimelineEvent = z.infer<typeof TimelineEvent>;
