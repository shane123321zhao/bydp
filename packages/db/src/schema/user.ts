// 用户域（架构 v1.3 §7）：User · PointsRule · Identity · Device · UserBrandBinding · Review · Subscription · Notification
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
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt, verificationLevel } from './_shared';
import { brands } from './operator';
import { promoCodes } from './commerce';

/** 实体 User；物理表名 app_user（避开 PG 保留字 user，§7 v1.3） */
export const users = pgTable('app_user', {
  id: pk('u'),
  displayName: text('displayName').notNull(),
  level: integer('level').notNull().default(1),
  points: integer('points').notNull().default(0),
  joinedAt: date('joinedAt').notNull().defaultNow(),
  region: text('region'),
  locale: text('locale').notNull().default('zh-Hans'),
  /** A-009 签核增补：JWT 会话纪元。token 带 epoch，每次请求比对，不一致即失效；盗号 / 封禁 / 退出所有设备 = epoch + 1 */
  sessionEpoch: integer('sessionEpoch').notNull().default(0),
  /** A-015 / §9.2 v1.10：注销匿名化时刻（只经 bydp_anonymize_user 写一次）；前台凡展示用户处按此隐藏 */
  anonymizedAt: tsz('anonymizedAt'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 积分规则（可配）：event → points，`GET /config/points` */
export const pointsRules = pgTable('points_rule', {
  event: text('event').primaryKey(),
  points: integer('points').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const identityProvider = pgEnum('identity_provider', ['telegram', 'email']);

/** 登录身份（多身份合并到同一 User） */
export const identities = pgTable(
  'identity',
  {
    id: pk('idn'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    provider: identityProvider('provider').notNull(),
    /**
     * A-009：盲索引 HMAC-SHA256(IDENTITY_HMAC_KEY, `${provider}:${规范化 TG id / 邮箱}`)，64 位 hex，只用于查找、不存明文；
     * 写入后不可改（触发器，迁移 0006）。
     */
    providerAccountId: text('providerAccountId'),
    /** 展示用掩码句柄 */
    handle: text('handle'),
    /** A-009：联系方式密文 AES-256-GCM(AUTH_PII_KEY)，`v1:iv:ct:tag`；只在发通知时解密 */
    contactEnc: text('contactEnc'),
    createdAt: createdAt(),
  },
  (t) => [
    index('identity_user_idx').on(t.userId),
    uniqueIndex('identity_provider_account_uq').on(t.provider, t.providerAccountId),
    check('identity_account_hash_hex', sql`${t.providerAccountId} is null or ${t.providerAccountId} ~ '^[0-9a-f]{64}$'`),
    check('identity_contact_enc_shape', sql`${t.contactEnc} is null or ${t.contactEnc} ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'`),
  ],
);

/**
 * A-009：邮箱 magic link 一次性令牌（Auth.js adapter createVerificationToken / useVerificationToken）。
 * identifierHash = 邮箱盲索引（不存邮箱明文）；tokenHash = Auth.js 已做的 sha256(token + secret)。取出即删；过期由 worker 清理。
 */
export const verificationTokens = pgTable(
  'verification_token',
  {
    identifierHash: text('identifierHash').notNull(),
    tokenHash: text('tokenHash').notNull(),
    expires: tsz('expires').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.identifierHash, t.tokenHash] }),
    check('verification_token_identifier_hex', sql`${t.identifierHash} ~ '^[0-9a-f]{64}$'`),
    check('verification_token_token_hex', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    index('verification_token_expires_idx').on(t.expires),
  ],
);

export const devices = pgTable(
  'device',
  {
    id: pk('dev'),
    userId: text('userId').references(() => users.id),
    fingerprint: text('fingerprint').notNull(),
    firstSeenAt: tsz('firstSeenAt').notNull().defaultNow(),
    lastSeenAt: tsz('lastSeenAt').notNull().defaultNow(),
  },
  (t) => [index('device_fingerprint_idx').on(t.fingerprint), index('device_user_idx').on(t.userId)],
);

export const bindingSource = pgEnum('binding_source', ['promo_link', 'manual']);

/**
 * 用户-品牌绑定：P3 赔付资格依据。
 * boundAt 为服务端时间戳且不可改（触发器 sql/10_append_only.sql）；赔付资格只认 postback_confirmed / operator_confirmed。
 */
export const userBrandBindings = pgTable(
  'user_brand_binding',
  {
    id: pk('ubb'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    /** A-011：账号密文 AES-256-GCM(AUTH_PII_KEY)，AAD = binding.id，`v1:iv:ct:tag`；只在仲裁 / 赔付核对时解密。A-012 起无明文列 */
    operatorAccountIdEnc: text('operatorAccountIdEnc').notNull(),
    /** A-011：写入时由明文计算的掩码（对外唯一展示形态），避免列表页解密；口径见 maskOperatorAccount（#18） */
    operatorAccountIdMasked: text('operatorAccountIdMasked').notNull(),
    /** HMAC-SHA256(BINDING_HMAC_KEY, operatorAccountId) 盲索引：同品牌同账号只能绑一次；写入后不可改（§7 v1.3 / R3） */
    operatorAccountIdHash: text('operatorAccountIdHash').notNull(),
    source: bindingSource('source').notNull(),
    promoCodeId: text('promoCodeId').references(() => promoCodes.id),
    boundAt: tsz('boundAt').notNull().defaultNow(),
    verificationLevel: verificationLevel('verificationLevel').notNull().default('self_reported'),
    postbackAt: tsz('postbackAt'),
    compensationEligible: boolean('compensationEligible').notNull().default(false),
    /** A-015 / §9.2 v1.10：失效时刻（注销匿名化，写一次）；失效绑定不计赔付资格与归因，同一账号可由新用户重新绑定 */
    revokedAt: tsz('revokedAt'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('binding_brand_account_hash_uq').on(t.brandId, t.operatorAccountIdHash).where(sql`${t.revokedAt} is null`),
    check('binding_account_hash_hex', sql`${t.operatorAccountIdHash} ~ '^[0-9a-f]{64}$'`),
    check('binding_account_enc_shape', sql`${t.operatorAccountIdEnc} is null or ${t.operatorAccountIdEnc} ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'`),
    index('binding_user_idx').on(t.userId),
    index('binding_brand_idx').on(t.brandId),
    check(
      'binding_eligibility_level',
      sql`not ${t.compensationEligible} or ${t.verificationLevel} in ('postback_confirmed', 'operator_confirmed')`,
    ),
  ],
);

/** D-024 / A-019：评价审核状态。存量默认 published；用户提交由触发器强制 pending；v1 文字不公开（W3#073 裁定 ④） */
export const reviewStatus = pgEnum('review_status', ['pending', 'published', 'rejected']);

export const reviews = pgTable(
  'review',
  {
    id: pk('rv'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    rating: smallint('rating').notNull(),
    text: text('text'),
    trustWeight: numeric('trustWeight', { precision: 3, scale: 2, mode: 'number' }).notNull().default(0),
    verifiedBinding: boolean('verifiedBinding').notNull().default(false),
    helpful: integer('helpful').notNull().default(0),
    createdAt: createdAt(),
    // ---- D-024 / A-019：提交与审核（scoring 只计 published；trustWeight 由触发器按绑定等级写入，architecture §5 S4 v1.18） ----
    status: reviewStatus('status').notNull().default('published'),
    bindingId: text('bindingId').references(() => userBrandBindings.id),
    decidedAt: tsz('decidedAt'),
    decidedBy: text('decidedBy'),
    rejectReason: text('rejectReason'),
  },
  (t) => [
    index('review_brand_idx').on(t.brandId),
    uniqueIndex('review_user_brand_active_uq').on(t.userId, t.brandId).where(sql`${t.status} <> 'rejected'`),
    index('review_status_idx').on(t.status, t.createdAt),
    check('review_rating_range', sql`${t.rating} between 1 and 5`),
    check('review_trust_weight_range', sql`${t.trustWeight} between 0 and 1`),
    check('review_text_len', sql`${t.text} is null or char_length(${t.text}) <= 500`),
  ],
);

export const subscriptionTarget = pgEnum('subscription_target', ['brand', 'complaint', 'candidate']);
export const notifyChannel = pgEnum('notify_channel', ['telegram', 'email']);

export const subscriptions = pgTable(
  'subscription',
  {
    id: pk('sub'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    targetType: subscriptionTarget('targetType').notNull(),
    targetId: text('targetId').notNull(),
    channel: notifyChannel('channel').notNull().default('telegram'),
    events: text('events').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [index('subscription_target_idx').on(t.targetType, t.targetId), index('subscription_user_idx').on(t.userId)],
);

export const notifications = pgTable(
  'notification',
  {
    id: pk('nt'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    sentAt: tsz('sentAt').notNull().defaultNow(),
    read: boolean('read').notNull().default(false),
    /** A-010：推送成功时刻（至少一次语义；null = 尚未推送成功 / 无可推送渠道），M3 漏推补扫依据 */
    deliveredAt: tsz('deliveredAt'),
    /** A-010：成功推送所用渠道 */
    channel: notifyChannel('channel'),
    /** A-012（#19）：推送被跳过的时刻与原因（TG 已屏蔽 Bot / 无联系方式）；补推扫描排除已跳过的通知 */
    skippedAt: tsz('skippedAt'),
    skipReason: text('skipReason'),
  },
  (t) => [
    index('notification_user_idx').on(t.userId, t.sentAt),
    check('notification_delivery_pair', sql`(${t.deliveredAt} is null) = (${t.channel} is null)`),
    check('notification_skip_pair', sql`(${t.skippedAt} is null) = (${t.skipReason} is null)`),
    check('notification_skip_reason', sql`${t.skipReason} is null or ${t.skipReason} in ('tg_blocked', 'no_contact')`),
    check('notification_delivered_xor_skipped', sql`${t.deliveredAt} is null or ${t.skippedAt} is null`),
  ],
);

/**
 * A-010：积分事件（只追加；§9.2 v1.7）。积分只从事件派生：插入即由触发器把 points 加到 app_user.points 并重算 level
 * （门槛 0 / 500 / 1500 / 3000 / 6000）；bydp_app 不能直接改 app_user.points / level。
 * dedupeKey 保证同一事由只发一次（如 `binding_confirmed:<userId>:<brandId>` 每品牌一次）。
 */
export const pointsEvents = pgTable(
  'points_event',
  {
    id: pk('pe'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    event: text('event')
      .notNull()
      .references(() => pointsRules.event),
    /** 发放时的分值（规则日后调整不影响已发放） */
    points: integer('points').notNull(),
    /** 事由对象（binding / withdrawal_report / review / complaint）与其 id，供「+N 分」展示 */
    refType: text('refType').notNull(),
    refId: text('refId').notNull(),
    dedupeKey: text('dedupeKey').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('points_event_dedupe_uq').on(t.dedupeKey),
    index('points_event_user_idx').on(t.userId, t.createdAt),
    index('points_event_ref_idx').on(t.refType, t.refId),
    // A-015：发放事件为正分；唯一的负分是注销冲销（anonymize_reversal，仅 bydp_anonymize_user 内放行）
    check('points_event_sign', sql`${t.points} > 0 or (${t.event} = 'anonymize_reversal' and ${t.points} < 0)`),
  ],
);

export const selfExclusionPeriod = pgEnum('self_exclusion_period', ['30', '90', '180', '365', 'permanent']);

/**
 * A-011 · §7 v1.8：自我排除（只追加）。生效 = 该用户任一条未到期即生效、取最晚结束（endsAt 为空 = 永久；D-013 #3，较短档位不会缩短既有排除）；期内不可撤销，到期后需手动恢复。
 * startsAt / createdAt 为服务端时间；endsAt 由触发器按 period 从 startsAt 推出（应用层传值被覆盖）。
 * permanent：identityHashes 快照该用户当时全部登录身份盲索引（64 位 hex），注销匿名化后仍据此拒绝同一 TG / 邮箱再注册。
 */
export const selfExclusions = pgTable(
  'self_exclusion',
  {
    id: pk('se'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    period: selfExclusionPeriod('period').notNull(),
    startsAt: tsz('startsAt').notNull().defaultNow(),
    endsAt: tsz('endsAt'),
    identityHashes: text('identityHashes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    index('self_exclusion_user_idx').on(t.userId, t.startsAt),
    index('self_exclusion_identity_hashes_gin').using('gin', t.identityHashes),
    check('self_exclusion_ends_matches_period', sql`(${t.period} = 'permanent') = (${t.endsAt} is null)`),
    check('self_exclusion_hashes_only_permanent', sql`${t.period} = 'permanent' or cardinality(${t.identityHashes}) = 0`),
  ],
);

/** A-011 · §7 v1.8：限额提醒偏好（仅提醒，不代扣）。null = 关闭该项提醒。 */
export const userPreferences = pgTable(
  'user_preference',
  {
    userId: text('userId')
      .primaryKey()
      .references(() => users.id),
    dailyDepositAlertUsdt: integer('dailyDepositAlertUsdt'),
    sessionAlertMinutes: integer('sessionAlertMinutes'),
    nightAlert: boolean('nightAlert').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('user_preference_deposit_range', sql`${t.dailyDepositAlertUsdt} is null or ${t.dailyDepositAlertUsdt} between 1 and 1000000`),
    check('user_preference_session_range', sql`${t.sessionAlertMinutes} is null or ${t.sessionAlertMinutes} between 15 and 1440`),
  ],
);

export const dataRequestKind = pgEnum('data_request_kind', ['redact_evidence', 'delete_evidence', 'export', 'anonymize']);
export const dataRequestStatus = pgEnum('data_request_status', ['pending', 'done', 'rejected']);

/**
 * A-011 · §7 v1.8：数据请求。M2 只做提交落库 + 站内确认通知；处理动作（脱敏 / 删原文 / 导出 / 匿名化执行）属 M3 后台。
 * 除 status / resolvedAt / updatedAt 外不可改；status 只能 pending → done | rejected 一次；状态变更由 core 写 audit_log。
 */
export const dataRequests = pgTable(
  'data_request',
  {
    id: pk('dr'),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    kind: dataRequestKind('kind').notNull(),
    /** 证据类请求的证据 id 列表（契约 evidenceIds）；其余类型为空数组 */
    targetIds: jsonb('targetIds').notNull().default(sql`'[]'::jsonb`),
    status: dataRequestStatus('status').notNull().default('pending'),
    note: text('note'),
    createdAt: createdAt(),
    resolvedAt: tsz('resolvedAt'),
    /** A-014（§9.2 v1.9）：注销执行前经登记联系方式向本人确认的时刻与渠道；/resolve done 前必须已确认（仅 anonymize） */
    contactConfirmedAt: tsz('contactConfirmedAt'),
    contactChannel: notifyChannel('contactChannel'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('data_request_user_idx').on(t.userId, t.createdAt),
    index('data_request_status_idx').on(t.status, t.createdAt),
    // A-012（#20）：同一用户同类请求处理中只能有一条（并发提交兜底；core 先查后插，冲突时返回原请求）
    uniqueIndex('data_request_pending_uq').on(t.userId, t.kind).where(sql`${t.status} = 'pending'`),
    check('data_request_target_ids_array', sql`jsonb_typeof(${t.targetIds}) = 'array' and jsonb_array_length(${t.targetIds}) <= 50`),
    check('data_request_targets_only_evidence', sql`${t.kind} in ('redact_evidence', 'delete_evidence') or jsonb_array_length(${t.targetIds}) = 0`),
    check('data_request_note_len', sql`${t.note} is null or char_length(${t.note}) <= 200`),
    check('data_request_resolved_pair', sql`(${t.status} = 'pending') = (${t.resolvedAt} is null)`),
    check('data_request_contact_pair', sql`(${t.contactConfirmedAt} is null) = (${t.contactChannel} is null)`),
    check('data_request_contact_only_anonymize', sql`${t.contactConfirmedAt} is null or ${t.kind} = 'anonymize'`),
    // 审核 A-014 E1：注销未经联系确认不得 done（rejected 不受限）
    check('data_request_anonymize_needs_contact', sql`${t.kind} <> 'anonymize' or ${t.status} <> 'done' or ${t.contactConfirmedAt} is not null`),
  ],
);

/**
 * A-016 / §9.2 v1.11：注销后的身份封禁（只追加）。注销函数在删除 identity 前写入本人身份盲索引：
 * 有 permanent 排除 → blockedUntil = null（永久）；有生效中的临时排除 → 最晚 endsAt。identity_permanent_block 同时查本表，
 * 临时排除期内注销后同一 TG / 邮箱重新注册被拦到 blockedUntil。
 */
export const identityBlocks = pgTable(
  'identity_block',
  {
    id: pk('ib'),
    identityHash: text('identityHash').notNull(),
    blockedUntil: tsz('blockedUntil'),
    requestId: text('requestId')
      .notNull()
      .references(() => dataRequests.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('identity_block_hash_idx').on(t.identityHash),
    check('identity_block_hash_hex', sql`${t.identityHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const reviewItemKind = pgEnum('review_item_kind', ['brand_attribute', 'site_monitor', 'complaint_screening', 'localization']);
export const reviewItemStatus = pgEnum('review_item_status', ['pending', 'approved', 'rejected']);

/**
 * A-014（D-015 #3 / #4 · admin 契约 v0.2）：Agent 输出待人工确认队列。所有 Agent 输出只进本表，不直接改公开数据；
 * approve 的落地动作按 kind 由 core 执行并写 audit_log。proposal 写入后不可改；status 只能 pending → approved | rejected 一次；不可删。
 */
export const reviewItems = pgTable(
  'review_item',
  {
    id: pk('ri'),
    kind: reviewItemKind('kind').notNull(),
    /** 关联对象 id（brandId / identifierId / complaintId / contentId） */
    subject: text('subject').notNull(),
    /** Agent 提议（结构随 kind，M3 第 4 项定义） */
    proposal: jsonb('proposal').notNull(),
    /** 产出来源（agent 名 + 版本），便于追溯 */
    source: text('source').notNull(),
    status: reviewItemStatus('status').notNull().default('pending'),
    /** 审核 A-014 E2：决定人必须是真实用户（外键），审批可追溯 */
    decidedBy: text('decidedBy').references(() => users.id),
    decidedAt: tsz('decidedAt'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('review_item_queue_idx').on(t.status, t.kind, t.createdAt),
    index('review_item_subject_idx').on(t.kind, t.subject),
    // A-015：同一对象同一类提议只能有一条待决（Agent 重跑不堆积）
    uniqueIndex('review_item_pending_subject_uq').on(t.kind, t.subject).where(sql`${t.status} = 'pending'`),
    check('review_item_proposal_object', sql`jsonb_typeof(${t.proposal}) = 'object'`),
    check('review_item_subject_len', sql`char_length(${t.subject}) between 1 and 128`),
    check('review_item_source_len', sql`char_length(${t.source}) between 1 and 64`),
    check('review_item_note_len', sql`${t.note} is null or char_length(${t.note}) <= 500`),
    check('review_item_decided_pair', sql`(${t.status} = 'pending') = (${t.decidedAt} is null) and (${t.decidedAt} is null) = (${t.decidedBy} is null)`),
  ],
);
