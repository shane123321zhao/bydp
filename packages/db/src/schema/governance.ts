// 后台与治理域（架构 v1.3 §7）：Role · AuditLog · AbuseFlag · RateLimitRule · OfficialChannel
import { bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_shared';
import { users } from './user';

/** RBAC：仲裁与商务物理隔离（§6 / §7） */
export const roleKey = pgEnum('role_key', ['arbitrator', 'commerce', 'editor', 'admin']);

export const roles = pgTable('role', {
  key: roleKey('key').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/** 用户↔角色（RBAC，§7 v1.3）：仲裁与商务物理隔离由应用层 + 本表约束 */
export const userRoles = pgTable(
  'user_role',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    roleKey: roleKey('roleKey')
      .notNull()
      .references(() => roles.key),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleKey] })],
);

/** 所有后台写操作入 AuditLog（只追加） */
export const auditLogs = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: text('actorId').notNull(),
    actorRole: roleKey('actorRole'),
    action: text('action').notNull(),
    targetType: text('targetType').notNull(),
    targetId: text('targetId'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    at: tsz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_target_idx').on(t.targetType, t.targetId), index('audit_log_actor_idx').on(t.actorId, t.at)],
);

export const abuseSeverity = pgEnum('abuse_severity', ['low', 'medium', 'high']);

export const abuseFlags = pgTable(
  'abuse_flag',
  {
    id: pk('ab'),
    subjectType: text('subjectType').notNull(),
    subjectId: text('subjectId').notNull(),
    reason: text('reason').notNull(),
    severity: abuseSeverity('severity').notNull(),
    createdAt: createdAt(),
    resolvedAt: tsz('resolvedAt'),
  },
  (t) => [index('abuse_flag_subject_idx').on(t.subjectType, t.subjectId)],
);

/** 限流规则（查询 / 评论 / 投诉），可配 */
export const rateLimitRules = pgTable('rate_limit_rule', {
  id: pk('rl'),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  windowSeconds: integer('windowSeconds').notNull(),
  maxRequests: integer('maxRequests').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const officialChannelType = pgEnum('official_channel_type', ['domain', 'telegram', 'bot']);

/** 官方渠道：供 /official 验证页与仿冒比对，`GET /config/official-channels` */
export const officialChannels = pgTable(
  'official_channel',
  {
    id: pk('oc'),
    type: officialChannelType('type').notNull(),
    value: text('value').notNull(),
    active: boolean('active').notNull().default(true),
    verifiedAt: tsz('verifiedAt'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('official_channel_type_value_uq').on(t.type, t.value)],
);
