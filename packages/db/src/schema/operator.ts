// 运营商域（架构 v1.3 §7）：Operator · Brand · Identifier · EntityLink · License · BrandAttribute · Candidate
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { brandStatus, createdAt, identifierType, ownership, pk, tsz, updatedAt, usdt } from './_shared';

export type LocalizedName = { zhHans: string; zhHant?: string; en?: string };

export const operators = pgTable('operator', {
  id: pk('op'),
  legalName: text('legalName'),
  jurisdiction: text('jurisdiction'),
  foundedYear: integer('foundedYear'),
  /** ADR-0003：关联方可收录披露，永不认证、永不结佣；scoring 与 tracking 均须读取 */
  relatedParty: boolean('relatedParty').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const brands = pgTable(
  'brand',
  {
    id: pk('br'),
    operatorId: text('operatorId')
      .notNull()
      .references(() => operators.id),
    slug: text('slug').notNull().unique(),
    name: jsonb('name').$type<LocalizedName>().notNull(),
    /** 信任状态（互斥）；"曝光"是案件状态，不是品牌状态（§5 三层口径） */
    status: brandStatus('status').notNull(),
    statusSince: date('statusSince').notNull(),
    certifiedDepositUsdt: usdt('certifiedDepositUsdt'),
    /** 品牌 Logo（R2 对象键）；缺素材为 null，前端回退首字字标（§7 v1.3） */
    logoUrl: text('logoUrl'),
    /** G1（§7 v1.5）：品牌级联盟跳转模板（Offer 未配置时兜底）；主机须属本品牌官方标识，只允许 {clickId} */
    redirectTemplate: text('redirectTemplate'),
    markets: text('markets').array().notNull().default(sql`'{}'::text[]`),
    hasActiveExposure: boolean('hasActiveExposure').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('brand_status_idx').on(t.status),
    index('brand_markets_gin').using('gin', t.markets),
    check('brand_redirect_template_shape', sql`${t.redirectTemplate} is null or ${t.redirectTemplate} ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/([^{}[:space:]@\\\\]|\\{clickId\\})*)?$'`),
  ],
);

export const identifiers = pgTable(
  'identifier',
  {
    id: pk('idf'),
    /** 仿冒标识挂在被冒充品牌上（ownership=fake），与 EntityLink(impersonates) 并存 */
    brandId: text('brandId').references(() => brands.id),
    type: identifierType('type').notNull(),
    value: text('value').notNull(),
    ownership: ownership('ownership').notNull(),
    chain: text('chain'),
    firstSeen: date('firstSeen'),
    lastChecked: date('lastChecked'),
    online: boolean('online'),
    note: text('note'),
    /** 官方主域：官网入口按钮来源，每品牌 ≤ 1 条（§7 v1.3） */
    primary: boolean('primary').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('identifier_primary_per_brand_uq').on(t.brandId).where(sql`${t.primary}`),
    check('identifier_primary_is_official_domain', sql`not ${t.primary} or (${t.type} = 'domain' and ${t.ownership} = 'official' and ${t.brandId} is not null)`),
    index('identifier_type_value_idx').on(t.type, t.value),
    index('identifier_brand_idx').on(t.brandId),
    // 仿冒/模糊匹配（ADR-0005）：需要 pg_trgm 扩展（sql/00_extensions.sql）
    index('identifier_value_trgm').using('gin', sql`${t.value} gin_trgm_ops`),
  ],
);

export const entityKind = pgEnum('entity_kind', ['brand', 'identifier']);
export const linkType = pgEnum('link_type', [
  'shared_wallet',
  'same_template',
  'impersonates',
  'same_operator',
  'shared_support',
]);
export const confirmedBy = pgEnum('confirmed_by', ['agent', 'human']);

/** 关联图谱边：端点可跨类型（品牌 / 标识），故为多态引用 + kind 列，无外键 */
export const entityLinks = pgTable(
  'entity_link',
  {
    id: pk('el'),
    fromKind: entityKind('fromKind').notNull(),
    fromId: text('fromId').notNull(),
    toKind: entityKind('toKind').notNull(),
    toId: text('toId').notNull(),
    linkType: linkType('linkType').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2, mode: 'number' }).notNull(),
    evidence: text('evidence'),
    confirmedBy: confirmedBy('confirmedBy').notNull(),
    confirmedAt: tsz('confirmedAt'),
    createdAt: createdAt(),
  },
  (t) => [
    index('entity_link_from_idx').on(t.fromKind, t.fromId),
    index('entity_link_to_idx').on(t.toKind, t.toId),
    check('entity_link_confidence_range', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

export const licenses = pgTable('license', {
  id: pk('lic'),
  brandId: text('brandId')
    .notNull()
    .references(() => brands.id),
  regulator: text('regulator').notNull(),
  licenseNo: text('licenseNo').notNull(),
  verifiedAt: date('verifiedAt'),
  verifiedAgainst: text('verifiedAgainst'),
  valid: boolean('valid').notNull(),
  note: text('note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const attributeSource = pgEnum('attribute_source', ['agent', 'human']);

/** 维度字典（payment / gameProvider / withdrawalLimit / support / market / language …）；驱动组合页与硬指标因子 */
export const brandAttributes = pgTable(
  'brand_attribute',
  {
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    dimension: text('dimension').notNull(),
    values: text('values').array().notNull(),
    source: attributeSource('source').notNull(),
    verified: boolean('verified').notNull().default(false),
    /** A-017 / §13 v1.12：采集来源（Agent 抓取页面 URL 与抓取时刻；人工录入为空），approve 落地时由 core 写入 */
    sourceUrl: text('sourceUrl'),
    sourceFetchedAt: tsz('sourceFetchedAt'),
    /** A-017：落地自哪条 review_item（追溯；不设外键以免 operator ↔ user 模块循环引用，由 core 写入） */
    reviewItemId: text('reviewItemId'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.dimension] })],
);

export type RiskSignal = {
  signal: string;
  detail?: string;
  severity?: 'low' | 'medium' | 'high';
  source?: string;
};

export const candidateStatus = pgEnum('candidate_status', ['pending_review', 'promoted', 'dismissed']);

/** 未收录的查询对象；riskSignals 为 Agent 输出，待人工确认 */
export const candidates = pgTable(
  'candidate',
  {
    id: pk('cand'),
    identifierType: identifierType('identifierType').notNull(),
    value: text('value').notNull(),
    queryCount7d: integer('queryCount7d').notNull().default(0),
    /** A-017 / §13 ⑤：加权 = 近 7 日 distinct 查询者（同 IP / 同设备 24h 只计 1）；原精度 (5,4) 上限 9.9999 容不下计数，放宽 */
    weightedPriority: numeric('weightedPriority', { precision: 10, scale: 4, mode: 'number' }).notNull().default(0),
    firstQueried: date('firstQueried').notNull(),
    riskSignals: jsonb('riskSignals').$type<RiskSignal[]>().notNull().default(sql`'[]'::jsonb`),
    status: candidateStatus('status').notNull().default('pending_review'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('candidate_type_value_idx').on(t.identifierType, t.value), index('candidate_priority_idx').on(t.weightedPriority)],
);

/**
 * A-017 / §13 ⑤：未收录标识的查询去刷记录。viewerHash = HMAC(服务端密钥, IP 或设备号)，不可逆、不存原值；
 * 同一查询者同一天对同一 Candidate 只记 1 行（唯一约束），queryCount7d / weightedPriority 由此重算。保留 30 天（worker 清理）。
 */
export const candidateQueries = pgTable(
  'candidate_query',
  {
    id: pk('cq'),
    candidateId: text('candidateId')
      .notNull()
      .references(() => candidates.id),
    viewerHash: text('viewerHash').notNull(),
    day: date('day').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('candidate_query_viewer_day_uq').on(t.candidateId, t.viewerHash, t.day),
    index('candidate_query_day_idx').on(t.day),
    check('candidate_query_viewer_hex', sql`${t.viewerHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A-017 / D-016 site_monitor：站点监控抓取记录（Agent 写入）。kind = home（首页可达 / 跳转）| terms（条款页内容哈希）。
 * 连续 3 次不可达 → offline 提议；跳转到新主机 → domain_changed；条款哈希变化 → terms_changed。只存哈希与状态，不存页面内容；保留 90 天。
 */
export const siteChecks = pgTable(
  'site_check',
  {
    id: pk('sc'),
    identifierId: text('identifierId')
      .notNull()
      .references(() => identifiers.id),
    kind: text('kind').notNull(),
    url: text('url').notNull(),
    checkedAt: tsz('checkedAt').notNull().defaultNow(),
    httpStatus: integer('httpStatus'),
    finalHost: text('finalHost'),
    contentHash: text('contentHash'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('site_check_identifier_idx').on(t.identifierId, t.kind, t.checkedAt),
    check('site_check_kind', sql`${t.kind} in ('home', 'terms')`),
    check('site_check_hash_hex', sql`${t.contentHash} is null or ${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('site_check_status_range', sql`${t.httpStatus} is null or ${t.httpStatus} between 100 and 599`),
    check('site_check_error_len', sql`${t.error} is null or char_length(${t.error}) <= 200`),
    check('site_check_outcome', sql`(${t.httpStatus} is null) <> (${t.error} is null)`),
  ],
);
