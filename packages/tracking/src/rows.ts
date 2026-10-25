import { sql, type Db } from '@bydp/db';

export type Exec = Pick<Db, 'execute'>;

/** 裸 SQL 查询取行（postgres-js 返回数组） */
export async function rows<T>(db: Exec, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

/** 裸 execute 的时间戳是字符串，统一成 Date */
export const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
