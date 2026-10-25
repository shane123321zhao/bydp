import 'server-only';
import { connect, type CoreDb } from '@bydp/core/runtime';

/** 单例连接（dev 热重载复用）；apps/web 只经 @bydp/core 访问数据（ADR-0006） */
const g = globalThis as unknown as { __bydpDb?: CoreDb };
export function db(): CoreDb {
  if (!g.__bydpDb) g.__bydpDb = connect().db;
  return g.__bydpDb;
}
