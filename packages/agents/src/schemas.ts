/**
 * review_item.proposal 结构（D-016 · 架构 §13 v1.12 ①）：Agent 只产出提议，approve 后由 core 按 kind 落地（review-apply.ts）并写 audit（applied=true）。
 * 外部抓取文本（标题、片段）只作纯文本保存与展示（审核 A-017 条件 3）；长度一律截断，防止撑爆后台页面。
 * LLM 产出的字段须带 model + promptVersion（§13 ③）；默认关闭时两项为空。
 */
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const httpUrl = z
  .string()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'only http(s) URLs');
const llm = z.object({ model: text(64), promptVersion: text(32) }).optional();

/** 去重（trim + 大小写不敏感）：页面由运营方控制，重复值会直接抬高按数量计分的因子（自检 I3） */
const dedupedValues = z
  .array(text(80))
  .min(1)
  .max(30)
  .transform((vs) => {
    const seen = new Set<string>();
    return vs.filter((v) => {
      const k = v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

/** brand_attribute：品牌官方页面采集（支付方式 / 限额 / 客服渠道 / 游戏商），approve 写 BrandAttribute（source = agent + 来源 URL）。subject = `<brandId>:<dimension>` */
export const BrandAttributeProposal = z.object({
  brandId: text(64),
  dimension: z.enum(['payment', 'withdrawalLimit', 'support', 'gameProvider']),
  values: dedupedValues,
  sourceUrl: httpUrl,
  fetchedAt: z.iso.datetime(),
  /** 页面原文片段（纯文本，供人工核对） */
  snippet: text(500).optional(),
  llm,
});

/** site_monitor：站点监控。subject = `<identifierId>#<type>`（offline / domain_changed / terms_changed 各自独立待决） */
export const SiteMonitorProposal = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('offline'),
    identifierId: text(64),
    url: httpUrl,
    /** 最近连续失败次数（≥ 3 才提议）与各次错误 */
    consecutiveFailures: z.number().int().min(3).max(100),
    lastErrors: z.array(text(200)).max(5),
  }),
  z.object({
    type: z.literal('domain_changed'),
    identifierId: text(64),
    url: httpUrl,
    /** 跳转后的新主机（小写，不含端口） */
    newHost: z.string().regex(/^[a-z0-9.-]{1,253}$/),
    hops: z.array(z.object({ url: httpUrl, status: z.number().int().min(100).max(599) })).min(1).max(4),
  }),
  z.object({
    type: z.literal('terms_changed'),
    identifierId: text(64),
    url: httpUrl,
    previousHash: z.string().regex(/^[0-9a-f]{64}$/),
    currentHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);

/** complaint_screening：投诉初筛建议（只进审核台，不改案件状态）。subject = complaintId */
export const ComplaintScreeningProposal = z.object({
  complaintId: text(64),
  suggest: z.enum(['accept', 'reject', 'needs_info']),
  /** 命中的规则（机器可读）与说明（纯文本） */
  rules: z
    .array(
      z.object({
        rule: z.enum(['duplicate_24h', 'same_device_multi_account', 'missing_amount', 'brand_blacklisted', 'brand_watch', 'brand_missing']),
        note: text(200),
      }),
    )
    .max(10),
  llm,
});

/** localization：简 → 繁（OpenCC + 术语表）/ 英（仅 LLM 开关开启）初稿。subject = `brand:<id>:<locale>` 或 `content:<id>:<locale>` */
export const LocalizationProposal = z.object({
  target: z.discriminatedUnion('type', [
    z.object({ type: z.literal('brand_name'), brandId: text(64) }),
    z.object({ type: z.literal('content'), contentId: text(64) }),
  ]),
  locale: z.enum(['zh-Hant', 'en']),
  engine: z.enum(['opencc', 'llm']),
  sourceText: text(20_000),
  /** content 类：标题与正文分别给出；brand_name 类只用 title */
  title: text(200),
  body: z.string().max(20_000).optional(),
  llm,
});

export const PROPOSAL_SCHEMAS = {
  brand_attribute: BrandAttributeProposal,
  site_monitor: SiteMonitorProposal,
  complaint_screening: ComplaintScreeningProposal,
  localization: LocalizationProposal,
} as const;
export type ReviewKind = keyof typeof PROPOSAL_SCHEMAS;
export type BrandAttributeProposal = z.infer<typeof BrandAttributeProposal>;
export type SiteMonitorProposal = z.infer<typeof SiteMonitorProposal>;
export type ComplaintScreeningProposal = z.infer<typeof ComplaintScreeningProposal>;
export type LocalizationProposal = z.infer<typeof LocalizationProposal>;

/**
 * 每类提议的 subject 由 proposal 推出（自检 I2）：审核台显示的对象 = 实际落地的对象；部分唯一索引按此去重，换 subject 绕不开。
 * Agent 写入与 core 落地都用本函数；不一致的提议不能批准。
 */
export function expectedSubject(kind: ReviewKind, proposal: unknown): string | null {
  const parsed = PROPOSAL_SCHEMAS[kind]?.safeParse(proposal);
  if (!parsed?.success) return null;
  const p = parsed.data as Record<string, unknown>;
  switch (kind) {
    case 'brand_attribute':
      return `${p.brandId}:${p.dimension}`;
    case 'site_monitor':
      return `${p.identifierId}#${p.type}`;
    case 'complaint_screening':
      return String(p.complaintId);
    case 'localization': {
      const t = p.target as { type: string; brandId?: string; contentId?: string };
      return t.type === 'brand_name' ? `brand:${t.brandId}:${p.locale}` : `content:${t.contentId}:${p.locale}`;
    }
  }
}

/** Agent 产出来源标识（review_item.source，≤ 64）：`<agent>@<version>` */
export const AGENT_SOURCES = {
  collector: 'collector@0.1',
  siteMonitor: 'site-monitor@0.1',
  screening: 'screening-rules@0.1',
  localization: 'localization-opencc@0.1',
} as const;
