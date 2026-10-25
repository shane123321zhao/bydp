// 信任域（架构 v1.3 §7）：StatusHistory · ScoreSnapshot · WithdrawalReport · Complaint · Evidence · OperatorReply · Exposure
// 只追加：status_history、evidence（哈希字段）——触发器见 sql/10_append_only.sql；GRANT 见 sql/20_roles.sql
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import {
  brandStatus,
  complaintCategory,
  complaintStatus,
  confidenceLevel,
  createdAt,
  pk,
  tsz,
  updatedAt,
  usdt,
} from './_shared';
import { brands } from './operator';
import { userBrandBindings, users } from './user';

const STATUS_DOMAIN = sql.raw(
  [...brandStatus.enumValues, ...complaintStatus.enumValues].map((v) => `'${v}'`).join(', '),
);

/** 品牌状态与案件状态的变更日志（只追加）。brandId / complaintId 二选一。 */
export const statusHistory = pgTable(
  'status_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: text('brandId').references(() => brands.id),
    complaintId: text('complaintId').references(() => complaints.id),
    from: text('from'),
    to: text('to').notNull(),
    reason: text('reason'),
    actor: text('actor').notNull(),
    at: tsz('at').notNull().defaultNow(),
  },
  (t) => [
    index('status_history_brand_idx').on(t.brandId, t.at),
    index('status_history_complaint_idx').on(t.complaintId, t.at),
    check('status_history_one_subject', sql`num_nonnulls(${t.brandId}, ${t.complaintId}) = 1`),
    // R5（A-001）：from / to 限定为品牌状态 ∪ 案件状态值域
    check('status_history_status_domain', sql`${t.to} in (${STATUS_DOMAIN}) and (${t.from} is null or ${t.from} in (${STATUS_DOMAIN}))`),
  ],
);

export type ScoreFactor = {
  key: 'withdrawal' | 'arbitration' | 'hardMetrics' | 'playerReviews' | 'stability';
  label: string;
  weight: number;
  score: number | null;
  available: boolean;
  sampleSize: number | null;
  detail: string;
  /** A-003 C3：scoring 输出的结构化指标（对外契约不含此字段，core 读取后剥离） */
  metrics?: Record<string, number | null>;
};

/** 评分快照（每日 02:00 重算；算法版本化；黑名单 score = null） */
export const scoreSnapshots = pgTable(
  'score_snapshot',
  {
    id: pk('ss'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    algorithmVersion: text('algorithmVersion').notNull(),
    computedAt: tsz('computedAt').notNull().defaultNow(),
    score: integer('score'),
    confidence: confidenceLevel('confidence').notNull(),
    factorsAvailable: integer('factorsAvailable').notNull(),
    factorsTotal: integer('factorsTotal').notNull(),
    factors: jsonb('factors').$type<ScoreFactor[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    index('score_snapshot_brand_idx').on(t.brandId, t.computedAt),
    check('score_snapshot_score_range', sql`${t.score} is null or (${t.score} between 0 and 100)`),
    check('score_snapshot_factors_range', sql`${t.factorsAvailable} between 0 and ${t.factorsTotal}`),
  ],
);

export const withdrawalKind = pgEnum('withdrawal_kind', ['user', 'official']);
export const withdrawalOutcome = pgEnum('withdrawal_outcome', ['paid', 'refused', 'pending']);
/** D-024 / A-019：用户提交物的审核状态（出款凭证）。存量与官方实测默认 accepted；用户提交由触发器强制 pending */
export const submissionStatus = pgEnum('submission_status', ['pending', 'accepted', 'rejected']);

/** 出款报告：用户凭证为主、官方实测为抽检（HANDOVER 决策 11） */
export const withdrawalReports = pgTable(
  'withdrawal_report',
  {
    id: pk('wr'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    kind: withdrawalKind('kind').notNull(),
    amountUsdt: usdt('amountUsdt').notNull(),
    method: text('method').notNull(),
    requestedAt: tsz('requestedAt').notNull(),
    receivedAt: tsz('receivedAt'),
    outcome: withdrawalOutcome('outcome').notNull(),
    bindingId: text('bindingId').references(() => userBrandBindings.id),
    /** A-002 / A-003 S1：是否来自绑定用户（scoring_ro 只能读此列，读不到 bindingId） */
    fromBinding: boolean('fromBinding').generatedAlwaysAs(sql`"bindingId" IS NOT NULL`),
    complaintId: text('complaintId').references(() => complaints.id),
    createdAt: createdAt(),
    // ---- D-024 / A-019：用户提交与审核（scoring 只计 accepted） ----
    userId: text('userId').references(() => users.id),
    status: submissionStatus('status').notNull().default('accepted'),
    decidedAt: tsz('decidedAt'),
    decidedBy: text('decidedBy'),
    rejectReason: text('rejectReason'),
    /** 本人把 outcome 由 pending 补为 paid / refused 的时间（只允许一次） */
    outcomeAmendedAt: tsz('outcomeAmendedAt'),
  },
  (t) => [
    index('withdrawal_report_brand_idx').on(t.brandId, t.kind),
    index('withdrawal_report_binding_idx').on(t.bindingId, t.requestedAt),
    index('withdrawal_report_status_idx').on(t.status, t.createdAt),
    check('withdrawal_report_received_after_requested', sql`${t.receivedAt} is null or ${t.receivedAt} >= ${t.requestedAt}`),
    check('withdrawal_report_amount_positive', sql`${t.amountUsdt} > 0`),
  ],
);

/**
 * D-024 / A-019：出款凭证的截图证据（同 evidence 口径：哈希行只追加，原文对象可脱敏 / 删除且不可逆）。
 * 不复用 evidence——其 complaintId 为 NOT NULL。
 */
export const submissionEvidence = pgTable(
  'submission_evidence',
  {
    id: pk('se'),
    withdrawalReportId: text('withdrawalReportId')
      .notNull()
      .references(() => withdrawalReports.id),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    uploadedAt: tsz('uploadedAt').notNull().defaultNow(),
    storageKey: text('storageKey'),
    redacted: boolean('redacted').notNull().default(false),
    redactedAt: tsz('redactedAt'),
    redactedSha256: text('redactedSha256'),
    deletedAt: tsz('deletedAt'),
  },
  (t) => [
    index('submission_evidence_report_idx').on(t.withdrawalReportId),
    check('submission_evidence_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('submission_evidence_redacted_sha256_hex', sql`${t.redactedSha256} is null or ${t.redactedSha256} ~ '^[0-9a-f]{64}$'`),
    check('submission_evidence_bytes_range', sql`${t.bytes} between 1 and 20971520`),
  ],
);

/** 案件；状态机见架构 §9.2 */
export const complaints = pgTable(
  'complaint',
  {
    id: pk('cp'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    bindingId: text('bindingId').references(() => userBrandBindings.id),
    category: complaintCategory('category').notNull(),
    title: text('title').notNull(),
    amountUsdt: usdt('amountUsdt').notNull(),
    /** 事件日期：P3 "纠纷前绑定" 判定依据（§9.4） */
    eventDate: date('eventDate').notNull(),
    description: text('description').notNull(),
    status: complaintStatus('status').notNull().default('screening'),
    publicSummary: boolean('publicSummary').notNull().default(false),
    /**
     * A-014（§9.2 · admin 契约 v0.2 Q1）：公开陈述——仲裁员人工脱敏后的文本，公开页 / 公开 API **只读本列**、任何公开路径不得读 description。
     * 公开（publicSummary = true）必须有本列；公开后可修订（audit_log 记 before / after）。
     */
    publicDescription: text('publicDescription'),
    acceptedAt: tsz('acceptedAt'),
    operatorNotifiedAt: tsz('operatorNotifiedAt'),
    secondNoticeAt: tsz('secondNoticeAt'),
    replyDeadline: tsz('replyDeadline'),
    operatorRepliedAt: tsz('operatorRepliedAt'),
    resolvedAt: tsz('resolvedAt'),
    exposedAt: tsz('exposedAt'),
    resolution: text('resolution'),
    relatedComplaintCount: integer('relatedComplaintCount'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('complaint_brand_idx').on(t.brandId, t.status),
    index('complaint_user_idx').on(t.userId),
    check('complaint_amount_nonneg', sql`${t.amountUsdt} >= 0`),
    check('complaint_public_description_len', sql`${t.publicDescription} is null or char_length(${t.publicDescription}) between 1 and 500`),
    check('complaint_public_needs_text', sql`not ${t.publicSummary} or ${t.publicDescription} is not null`),
    // A-002（审核定稿）：事件日期不晚于提交时刻在全球最晚时区（UTC+14，固定偏移）的日期；与部署时区无关、IMMUTABLE
    check('complaint_event_date_not_future', sql`${t.eventDate} <= (${t.createdAt} AT TIME ZONE 'Etc/GMT-14')::date`),
  ],
);

export const evidenceType = pgEnum('evidence_type', ['screenshot', 'chat_log', 'tx_hash', 'other']);

/**
 * 证据：sha256 = SHA-256（文件 + 规范化元数据），服务端计算，P3 上链锚定。
 * 只追加：不可 DELETE；UPDATE 仅允许 redacted / redactedAt / storageKey / deletedAt（原文脱敏或按隐私请求删除），
 * 其余列（尤其 sha256）由触发器锁死。
 */
export const evidence = pgTable(
  'evidence',
  {
    id: pk('ev'),
    complaintId: text('complaintId')
      .notNull()
      .references(() => complaints.id),
    type: evidenceType('type').notNull(),
    label: text('label'),
    sha256: text('sha256').notNull(),
    txHash: text('txHash'),
    uploadedAt: tsz('uploadedAt').notNull().defaultNow(),
    // ---- 可变部分：原文对象与脱敏状态 ----
    storageKey: text('storageKey'),
    redacted: boolean('redacted').notNull().default(false),
    redactedAt: tsz('redactedAt'),
    deletedAt: tsz('deletedAt'),
    /** A-014：脱敏替换件的 SHA-256（原文哈希 sha256 不变、仍是证据依据）；随 redacted = true 一次写入，之后不可改 */
    redactedSha256: text('redactedSha256'),
  },
  (t) => [
    index('evidence_complaint_idx').on(t.complaintId),
    check('evidence_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('evidence_redacted_sha256_hex', sql`${t.redactedSha256} is null or ${t.redactedSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const operatorReplies = pgTable(
  'operator_reply',
  {
    id: pk('or'),
    complaintId: text('complaintId')
      .notNull()
      .references(() => complaints.id),
    repliedAt: tsz('repliedAt').notNull().defaultNow(),
    summary: text('summary').notNull(),
    attachments: integer('attachments').notNull().default(0),
  },
  (t) => [index('operator_reply_complaint_idx').on(t.complaintId)],
);

/** 曝光（品牌级）。关联案件见 exposure_complaint；关联品牌由 entity_link 推出（§7 v1.3） */
export const exposures = pgTable(
  'exposure',
  {
    id: pk('ex'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    publishedAt: tsz('publishedAt').notNull().defaultNow(),
    totalClaimedUsdt: usdt('totalClaimedUsdt').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('exposure_brand_idx').on(t.brandId)],
);

/** 曝光-案件关联（替代 exposure.complaintIds 数组，§7 v1.3 / R4）；只追加，不可删 */
export const exposureComplaints = pgTable(
  'exposure_complaint',
  {
    exposureId: text('exposureId')
      .notNull()
      .references(() => exposures.id),
    complaintId: text('complaintId')
      .notNull()
      .references(() => complaints.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.exposureId, t.complaintId] }), index('exposure_complaint_complaint_idx').on(t.complaintId)],
);
