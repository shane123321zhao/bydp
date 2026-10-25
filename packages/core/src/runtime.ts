/** apps 的唯一 DB 入口（ADR-0006：apps 不直连 @bydp/db）。以 bydp_app 连接。 */
import { createDb, type Db } from '@bydp/db';

export type CoreDb = Db;
export function connect(url = process.env.DATABASE_URL) {
  return createDb(url);
}
