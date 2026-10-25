// 投诉 / 仲裁（架构 §9.2）
import { z } from 'zod';
import { Fact, TimelineEvent } from '../shared/index';
import { BrandCard, EntityLinkRow } from '../trust/index';

export const ComplaintCategory = z.enum(['refused', 'delay', 'frozen', 'bonus', 'closed']);
export const ComplaintStatus = z.enum([
  'screening',
  'accepted',
  'awaiting_reply',
  'arbitrating',
  'resolved',
  'rejected',
  'unresolved',
  'exposed',
]);
export const BindingLevel = z.enum(['none', 'self_reported', 'postback_confirmed', 'operator_confirmed']);

export const Evidence = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  label: z.string().optional(),
  sha256: z.string().optional(),
  uploadedAt: z.iso.datetime({ offset: true }).optional(),
  redacted: z.boolean().optional(),
});
export const EvidenceType = z.enum(['screenshot', 'chat_log', 'tx_hash', 'other']);

export const ComplaintPublic = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  category: ComplaintCategory.optional(),
  status: ComplaintStatus.optional(),
  amountUsdt: z.number().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  resolvedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  exposedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const ComplaintPage = z.object({
  stats: z
    .object({ total: z.number().int().optional(), resolveRate: z.number().optional(), medianResponseDays: z.number().optional() })
    .optional(),
  items: z.array(ComplaintPublic).optional(),
  next: z.string().nullable().optional(),
});

export const CasePublic = ComplaintPublic.extend({
  brand: BrandCard.optional(),
  facts: z.array(Fact).optional(),
  userStatement: z.string().optional(),
  userBindingLevel: BindingLevel.optional(),
  operatorReply: z
    .object({ repliedAt: z.iso.datetime({ offset: true }).optional(), summary: z.string().optional(), attachments: z.number().int().optional() })
    .nullable()
    .optional(),
  replyWindow: z
    .object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), notices: z.number().int().optional() })
    .optional(),
  evidenceHashes: z.array(z.object({ type: z.string().optional(), sha256: z.string().optional(), redacted: z.boolean().optional() })).optional(),
  timeline: z.array(TimelineEvent).optional(),
  related: z.array(EntityLinkRow).optional(),
});

export const ComplaintCreate = z.object({
  brandId: z.string(),
  category: ComplaintCategory,
  amountUsdt: z.number().min(0),
  eventDate: z.iso.date(),
  description: z.string().max(500),
  bindingId: z.string().nullable().optional(),
  /** 可选覆盖；缺省由服务端按「类型 + 金额」生成（契约 v1.6 / §9.2） */
  title: z.string().max(60).nullable().optional(),
});

export const ComplaintMine = ComplaintPublic.extend({
  replyDeadline: z.iso.datetime({ offset: true }).nullable().optional(),
  notices: z.number().int().optional(),
  compensationEligible: z.boolean().optional(),
  evidence: z.array(Evidence).optional(),
  timeline: z.array(TimelineEvent).optional(),
});

export type ComplaintCreate = z.infer<typeof ComplaintCreate>;
export type ComplaintPublic = z.infer<typeof ComplaintPublic>;
export type ComplaintMine = z.infer<typeof ComplaintMine>;
export type CasePublic = z.infer<typeof CasePublic>;
export type Evidence = z.infer<typeof Evidence>;
export type ComplaintPage = z.infer<typeof ComplaintPage>;
