// 商业域（架构 v1.2 §7）：Offer · PromoCode · Click · Conversion · Commission · Partner · AffiliateComplaint
// 隔离（ADR-0006）：本文件所有表对 bydp_scoring_ro 不授权。Click/Conversion/Commission 业务实现归 packages/tracking（双签，M2）。
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt, usdt } from './_shared';
import { brands } from './operator';
import { users } from './user';

export type OfferTerms = {
  rolloverMultiple: number;
  rolloverBase: string;
  maxWithdrawalUsdt: number | null;
  validDays: number;
  restrictedGames: string[];
  eligibleGames: string[];
  /** D-029（architecture §8.1）：流水贡献率 %，缺省 100 */
  contributionPercent?: number | null;
  /** D-029：返水比例 %（周返水） */
  rebatePercent?: number | null;
};

/** 真实价值换算（§3 杀手锏 2；口径见 architecture §8.1，core commerce/true-value.ts 计算，不接受手填） */
export type OfferTrueValue = {
  exampleDepositUsdt: number;
  bonusUsdt: number;
  requiredTurnoverUsdt: number;
  expectedCostAtRtp96Usdt: number;
  netExpectedValueUsdt: number;
  verdict: 'positive' | 'negative';
  verdictText: string;
  /** 参数表版本（首版 tv-1）；参数变更即升版本并全量重算 */
  methodVersion?: string;
};

/** A-018（§9.2 v1.15 口径更新）：Offer 独立上下线状态。品牌转黑名单时 DB 触发器置 offline；解除黑名单不自动恢复（人工逐个上线） */
export const offerStatus = pgEnum('offer_status', ['active', 'offline']);
export const offers = pgTable(
  'offer',
  {
    id: pk('of'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    title: text('title').notNull(),
    type: text('type').notNull(),
    matchPercent: integer('matchPercent'),
    maxBonusUsdt: usdt('maxBonusUsdt'),
    minDepositUsdt: usdt('minDepositUsdt'),
    terms: jsonb('terms').$type<OfferTerms>().notNull(),
    trueValue: jsonb('trueValue').$type<OfferTrueValue>().notNull(),
    exclusive: boolean('exclusive').notNull().default(false),
    /** 赞助位：物理独立、明确标注、不参与排序（ADR-0006） */
    sponsored: boolean('sponsored').notNull().default(false),
    riskLabel: text('riskLabel'),
    compensationEligible: boolean('compensationEligible').notNull().default(false),
    validUntil: date('validUntil'),
    /** A-020（D-029）：条款原文（运营商原文，≤ 5000 字）；只存不出——对外是否展示待设计定 */
    termsText: text('termsText'),
    status: offerStatus('status').notNull().default('active'),
    /**
     * G1（§7 v1.5）：联盟跳转模板。形状 = https + 主机 + 可选端口 + 以 / 开头的路径，禁止 @ 与 \（防 userinfo 绕过，A-007 F1）；
     * 占位符只允许 {clickId}。目标主机必须属于该品牌 ownership=official 的标识（触发器校验，见迁移 0005）。为空时用 Brand.redirectTemplate 兜底。
     */
    redirectTemplate: text('redirectTemplate'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('offer_brand_idx').on(t.brandId), check('offer_terms_text_length', sql`${t.termsText} is null or char_length(${t.termsText}) <= 5000`), check('offer_redirect_template_shape', sql`${t.redirectTemplate} is null or ${t.redirectTemplate} ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/([^{}[:space:]@\\\\]|\\{clickId\\})*)?$'`)],
);

export const promoCodes = pgTable(
  'promo_code',
  {
    id: pk('pc'),
    offerId: text('offerId')
      .notNull()
      .references(() => offers.id),
    /** 自动发放类优惠无码（null） */
    code: text('code'),
    channel: text('channel').notNull(),
    claimedCount: integer('claimedCount').notNull().default(0),
    activeUntil: date('activeUntil'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('promo_code_offer_idx').on(t.offerId)],
);

export const partnerKind = pgEnum('partner_kind', ['kol', 'agent']);

/** KOL / 代理；只能推广观察库及以上品牌（§8 商业护栏） */
export const partners = pgTable('partner', {
  id: pk('pt'),
  kind: partnerKind('kind').notNull(),
  name: text('name').notNull(),
  shareRate: numeric('shareRate', { precision: 5, scale: 4, mode: 'number' }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 点击：带坑位、渠道、地区、KOL（§7） */
export const clicks = pgTable(
  'click',
  {
    id: pk('clk'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    offerId: text('offerId').references(() => offers.id),
    promoCodeId: text('promoCodeId').references(() => promoCodes.id),
    userId: text('userId').references(() => users.id),
    partnerId: text('partnerId').references(() => partners.id),
    slot: text('slot'),
    channel: text('channel'),
    region: text('region'),
    createdAt: createdAt(),
  },
  (t) => [index('click_brand_idx').on(t.brandId, t.createdAt)],
);

export const conversionEvent = pgEnum('conversion_event', ['register', 'first_deposit', 'deposit', 'reversal']);

/**
 * 转化回传：须含运营商侧账号 ID（§6 运营商接入最小包）。
 * G2（§7 v1.5）：**只追加**——更正只写冲正事件（event=reversal，reversesId 指向原行，每行至多被冲正一次）；
 * (brandId, externalEventId) 唯一防重复处理。G4：匹配绑定用 operatorAccountIdHash（与 createBinding 同一函数），不用明文。
 */
export const conversions = pgTable(
  'conversion',
  {
    id: pk('cv'),
    clickId: text('clickId').references(() => clicks.id),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    /** 运营商侧事件 id（幂等键） */
    externalEventId: text('externalEventId').notNull(),
    /** A-013（#17）：归因只用盲索引 HMAC(BINDING_HMAC_KEY, 规范化账号)，不存明文；raw 回传原文同样剔除账号字段（CHECK） */
    operatorAccountIdHash: text('operatorAccountIdHash').notNull(),
    event: conversionEvent('event').notNull(),
    /** 冲正行指向被冲正的原行 */
    reversesId: text('reversesId').references((): AnyPgColumn => conversions.id),
    amountUsdt: usdt('amountUsdt'),
    occurredAt: tsz('occurredAt'),
    receivedAt: tsz('receivedAt').notNull().defaultNow(),
    raw: jsonb('raw'),
  },
  (t) => [
    index('conversion_brand_hash_idx').on(t.brandId, t.operatorAccountIdHash),
    uniqueIndex('conversion_brand_external_event_uq').on(t.brandId, t.externalEventId),
    // 审核坑 3：同一原行只能被冲正一次
    uniqueIndex('conversion_reverses_once_uq').on(t.reversesId).where(sql`${t.reversesId} is not null`),
    // ::text：新枚举值与 ADD VALUE 同一事务内不可直接作为枚举字面量使用（PG "unsafe use of new value"）
    check('conversion_reversal_shape', sql`(${t.event}::text = 'reversal') = (${t.reversesId} is not null)`),
    check('conversion_account_hash_hex', sql`${t.operatorAccountIdHash} ~ '^[0-9a-f]{64}$'`),
    check('conversion_raw_no_account', sql`${t.raw} is null or not (${t.raw} ? 'operatorAccountId')`),
  ],
);

export const commissionModel = pgEnum('commission_model', ['cpa', 'revshare', 'hybrid']);
export const commissionStatus = pgEnum('commission_status', ['pending', 'approved', 'paid', 'void']);
export const commissionTermMode = pgEnum('commission_term_mode', ['cpa', 'revshare']);

/**
 * G3（§7 v1.5）：佣金条款。同品牌 + 同合作方（含「不限合作方」= partnerId 为空）生效区间不得重叠——
 * 排除约束在迁移 0005 以 coalesce("partnerId", '') + daterange(validFrom, validTo, '[)') 实现（审核坑 1）。
 */
export const commissionTerms = pgTable(
  'commission_term',
  {
    id: pk('ctm'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    partnerId: text('partnerId').references(() => partners.id),
    mode: commissionTermMode('mode').notNull(),
    cpaUsdt: usdt('cpaUsdt'),
    sharePct: numeric('sharePct', { precision: 5, scale: 4, mode: 'number' }),
    validFrom: date('validFrom').notNull(),
    /** 为空 = 长期有效 */
    validTo: date('validTo'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('commission_term_brand_idx').on(t.brandId, t.validFrom),
    check(
      'commission_term_mode_fields',
      sql`(${t.mode} = 'cpa' and ${t.cpaUsdt} is not null and ${t.cpaUsdt} >= 0 and ${t.sharePct} is null)
       or (${t.mode} = 'revshare' and ${t.sharePct} is not null and ${t.sharePct} > 0 and ${t.sharePct} <= 1 and ${t.cpaUsdt} is null)`,
    ),
    check('commission_term_range', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);

/**
 * 佣金：**只追加账本**（G3），记 termId；状态不在本表——改由 commission_event 只追加记录，当前状态取最新一条（审核坑 2，方案 a）。
 * 黑名单与关联方永不结算（ADR-0003，由 tracking 硬拦截）。
 */
export const commissions = pgTable(
  'commission',
  {
    id: pk('cm'),
    conversionId: text('conversionId').references(() => conversions.id),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    partnerId: text('partnerId').references(() => partners.id),
    termId: text('termId').references(() => commissionTerms.id),
    model: commissionModel('model').notNull(),
    amountUsdt: usdt('amountUsdt').notNull(),
    period: text('period'),
    createdAt: createdAt(),
  },
  (t) => [
    index('commission_brand_idx').on(t.brandId),
    check('commission_amount_nonneg', sql`${t.amountUsdt} >= 0`),
  ],
);

/** 佣金状态事件（只追加）：pending → approved / void；paid 为月结（M3 后台） */
export const commissionEvents = pgTable(
  'commission_event',
  {
    id: pk('cme'),
    commissionId: text('commissionId')
      .notNull()
      .references(() => commissions.id),
    status: commissionStatus('status').notNull(),
    actor: text('actor').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('commission_event_commission_idx').on(t.commissionId, t.createdAt)],
);

export const integrationStatus = pgEnum('integration_status', ['active', 'disabled']);

/** G2（§7 v1.5）：运营商对接。postback 密钥本体只在环境变量 / KMS，库里只存引用名 */
export const operatorIntegrations = pgTable(
  'operator_integration',
  {
    id: pk('oi'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    /** 环境变量 / KMS 键名，例如 POSTBACK_SECRET_JINLONG */
    postbackSecretRef: text('postbackSecretRef').notNull(),
    /** HMAC 时间戳容差（秒），默认 300 = 5 分钟 */
    timeWindowSec: integer('timeWindowSec').notNull().default(300),
    status: integrationStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('operator_integration_brand_uq').on(t.brandId),
    check('operator_integration_secret_ref', sql`${t.postbackSecretRef} ~ '^[A-Z][A-Z0-9_]{2,63}$'`),
    check('operator_integration_window', sql`${t.timeWindowSec} between 30 and 300`),
  ],
);

export const affiliateComplaintStatus = pgEnum('affiliate_complaint_status', ['open', 'resolved', 'unresolved']);

/** 联盟投诉：记录运营商对 BYDP 的履约（赖佣、砍量） */
export const affiliateComplaints = pgTable('affiliate_complaint', {
  id: pk('ac'),
  brandId: text('brandId')
    .notNull()
    .references(() => brands.id),
  title: text('title').notNull(),
  description: text('description'),
  amountUsdt: usdt('amountUsdt'),
  status: affiliateComplaintStatus('status').notNull().default('open'),
  createdAt: createdAt(),
  resolvedAt: tsz('resolvedAt'),
});
