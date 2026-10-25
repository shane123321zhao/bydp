import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { numeric, pgEnum, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * 命名约定（.claude/rules/db-migration.md）：表名 snake_case；字段 camelCase（与架构 §7、fixtures 字段名一致）。
 * 主键为带域前缀的 text（br_ / idf_ / cp_ …），与 fixtures 的 id 形态一致，便于 seed 直接入库。
 */
export const pk = (prefix: string) =>
  text('id')
    .primaryKey()
    .$defaultFn(() => `${prefix}_${randomUUID().replaceAll('-', '')}`);

/** 服务端时间戳：由 DB 生成，应用层不传值。 */
export const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => tsz('createdAt').notNull().defaultNow();
export const updatedAt = () =>
  tsz('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`);

/** 金额统一 USDT，numeric(18,2)。 */
export const usdt = (name: string) => numeric(name, { precision: 18, scale: 2, mode: 'number' });

// ---- 跨域共用枚举（值与 docs/design/api-contract.yaml 一致） ----
export const brandStatus = pgEnum('brand_status', ['certified', 'watch', 'blacklist']);
export const ownership = pgEnum('ownership', ['official', 'fake', 'pending']);
export const identifierType = pgEnum('identifier_type', ['domain', 'mirror', 'app', 'tg', 'wallet', 'phone']);
export const confidenceLevel = pgEnum('confidence_level', ['none', 'low', 'medium', 'high']);
export const verificationLevel = pgEnum('verification_level', [
  'self_reported',
  'postback_confirmed',
  'operator_confirmed',
]);
export const complaintCategory = pgEnum('complaint_category', ['refused', 'delay', 'frozen', 'bonus', 'closed']);
export const complaintStatus = pgEnum('complaint_status', [
  'screening',
  'accepted',
  'awaiting_reply',
  'arbitrating',
  'resolved',
  'rejected',
  'unresolved',
  'exposed',
]);
