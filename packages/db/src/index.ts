import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export * as schema from './schema/index';

/** 业务连接（bydp_app / 开发期 bydp）。scoring 只能用 DATABASE_URL_SCORING_RO（ADR-0006）。 */
/** max：连接池上限（Agent 连接用 2，低于 bydp_agent 的 CONNECTION LIMIT 5） */
export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error('DATABASE_URL 未设置');
  const client = postgres(url, { max: opts.max ?? 10 });
  return { db: drizzle(client, { schema }), client };
}
export type Db = ReturnType<typeof createDb>['db'];
export { bindingHmacKeyFromEnv, hashOperatorAccountId, normalizeOperatorAccountId } from './binding-hash';
export { bindingPiiKeyFromEnv, decryptOperatorAccountId, encryptOperatorAccountId, maskOperatorAccount } from './binding-crypto';
// 查询算子统一从 @bydp/db 取，避免各包各装一份 drizzle-orm
export { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
