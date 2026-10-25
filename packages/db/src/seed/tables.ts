import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { PgTable as PgTableClass } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index';

/** SQL 表名 → Drizzle 表对象 */
export const TABLES: Record<string, PgTable> = Object.fromEntries(
  (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => v instanceof PgTableClass)
    .map((tbl) => [getTableName(tbl), tbl]),
);

/** 行内每个键必须是该表的列（字段名与 fixtures 一致的机器校验） */
export function assertColumns(table: string, rows: Record<string, unknown>[]) {
  const tbl = TABLES[table];
  if (!tbl) throw new Error(`schema 中无表 ${table}`);
  const cols = new Set(Object.keys(getTableColumns(tbl)));
  for (const r of rows) {
    const extra = Object.keys(r).filter((k) => !cols.has(k));
    if (extra.length) throw new Error(`${table}.${String(r.id)}：fixtures 字段不在 schema 中：${extra.join(', ')}`);
  }
}
