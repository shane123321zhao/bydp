// 身份 / 我的（绑定、订阅、自我排除、隐私请求、配置）
import { z } from 'zod';
import { BrandCard } from '../trust/index';

export const VerificationLevel = z.enum(['self_reported', 'postback_confirmed', 'operator_confirmed']);

export const Binding = z.object({
  id: z.string().optional(),
  brand: BrandCard.optional(),
  operatorAccountIdMasked: z.string().optional(),
  source: z.enum(['promo_link', 'manual']).optional(),
  promoCode: z.string().nullable().optional(),
  boundAt: z.iso.datetime({ offset: true }).optional(),
  verificationLevel: VerificationLevel.optional(),
  compensationEligible: z.boolean().optional(),
});

export const BindingCreate = z.object({
  brandId: z.string(),
  operatorAccountId: z.string(),
  promoCodeId: z.string().nullable().optional(),
});

export const MeBrief = z.object({
  displayName: z.string().optional(),
  bindings: z.number().int().optional(),
  compensationEligible: z.boolean().optional(),
  activeComplaints: z.number().int().optional(),
});

export const MePayload = z.object({
  user: z
    .object({
      displayName: z.string().optional(),
      provider: z.string().optional(),
      handleMasked: z.string().optional(),
      joinedAt: z.iso.date().optional(),
      region: z.string().optional(),
      locale: z.string().optional(),
      level: z.number().int().optional(),
      points: z.number().int().optional(),
      nextLevelAt: z.number().int().optional(),
    })
    .optional(),
  counts: z
    .object({
      bindings: z.number().int().optional(),
      complaintsActive: z.number().int().optional(),
      complaintsTotal: z.number().int().optional(),
      codes: z.number().int().optional(),
      subscriptions: z.number().int().optional(),
    })
    .optional(),
  bindings: z.array(Binding).optional(),
  activity: z
    .array(z.object({ date: z.iso.date().optional(), subject: z.string().optional(), rest: z.string().optional(), tag: z.string().optional(), ref: z.string().optional() }))
    .optional(),
  settings: z
    .object({
      locale: z.string().optional(),
      notifications: z.boolean().optional(),
      /** A-011 · D-013 #2：当前生效的自我排除（任一未到期取最晚结束）；endsAt 为 null = 永久；无排除为 null */
      selfExclusion: z.object({ period: z.enum(['30', '90', '180', '365', 'permanent']), endsAt: z.iso.datetime({ offset: true }).nullable() }).nullable().optional(),
    })
    .optional(),
});

export const SubscriptionCreate = z.object({
  targetType: z.enum(['brand', 'complaint', 'candidate']),
  targetId: z.string(),
  channel: z.enum(['telegram', 'email']).default('telegram'),
});

/** POST /me/self-exclusion（D-012 #3：period 字符串枚举，permanent 不可撤销且不可再注册） */
export const SelfExclusion = z.object({ period: z.enum(['30', '90', '180', '365', 'permanent']) });

/** GET / PUT /me/preferences（D-013 #2）：限额提醒偏好，仅提醒不代扣；null = 关闭该项 */
export const Preferences = z.object({
  dailyDepositAlertUsdt: z.number().int().min(10).max(100000).nullable(),
  sessionAlertMinutes: z.number().int().min(30).max(720).nullable(),
  nightAlert: z.boolean(),
});

export const DataRequest = z.object({
  kind: z.enum(['redact_evidence', 'delete_evidence', 'export', 'anonymize']),
  evidenceIds: z.array(z.string()).optional(),
  note: z.string().max(200).nullable().optional(),
});

export const PointsConfig = z.record(z.string(), z.number().int());
export const OfficialChannels = z.object({
  domains: z.array(z.string()).optional(),
  telegram: z.array(z.string()).optional(),
  bots: z.array(z.string()).optional(),
});

export type Binding = z.infer<typeof Binding>;
export type MePayload = z.infer<typeof MePayload>;
