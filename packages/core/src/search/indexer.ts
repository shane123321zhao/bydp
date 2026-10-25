/**
 * 搜索索引写入（D-019，仅 worker 使用）：索引设置（含术语表港澳同义词）、增量同步、每日全量重建。
 * 与查询（./index）分开：术语表按文件目录加载，web 构建不引入。
 */
import { schema, sql, type Db } from '@bydp/db';
import { brandDocs, BRANDS_INDEX, caseDocs, CASES_INDEX, ID } from './index';
import { SEARCH_KEY_UID, type IndexSettings, type Meili } from './meili';
import { loadGlossary } from '@bydp/i18n/glossary';
import { synonymsFromGlossary } from './normalize';

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export function brandSettings(): IndexSettings {
  return { searchableAttributes: ['names', 'slug', 'identifiers'], filterableAttributes: ['status'], displayedAttributes: ['id'], synonyms: synonymsFromGlossary(loadGlossary()) };
}
export function caseSettings(): IndexSettings {
  // brandName 只存不搜：与 pg 降级口径一致（品牌投诉 Tab 内搜品牌名不应命中全部案件）
  return { searchableAttributes: ['title', 'body'], filterableAttributes: ['brandId'], displayedAttributes: ['id'], synonyms: synonymsFromGlossary(loadGlossary()) };
}

/**
 * 增量同步（worker 消费 search 队列）：存在则覆盖，不存在 / 已不公开则删除。
 * 索引尚不存在（首次部署 / 卷丢失 / 启动重建失败）→ 改做一次全量重建，绝不建只含几条文档的残缺索引（残缺索引查询不报错，不会触发降级）。
 * settings 只在全量重建时写（每个增量不再 PATCH）。
 */
export async function syncSearchDocs(db: Reader, meili: Meili, job: { kind: 'brand' | 'case'; ids: string[] }): Promise<{ upserted: number; removed: number; rebuilt?: boolean }> {
  const ids = job.ids.filter((x) => ID.test(x));
  if (!ids.length) return { upserted: 0, removed: 0 };
  if (!(await meili.exists(BRANDS_INDEX)) || !(await meili.exists(CASES_INDEX))) {
    const r = await rebuildSearchIndexes(db, meili);
    return { upserted: r.brands + r.cases, removed: 0, rebuilt: true };
  }
  if (job.kind === 'brand') {
    const docs = await brandDocs(db, ids);
    await meili.upsert(BRANDS_INDEX, docs);
    const gone = ids.filter((x) => !docs.some((d) => d.id === x));
    await meili.remove(BRANDS_INDEX, gone);
    // 品牌名变更影响该品牌公开案件的 brandName
    const cases = await q<{ id: string }>(db, sql`select "id" from ${schema.complaints} where "brandId" in ${ids} and "publicSummary"`);
    if (cases.length) await meili.upsert(CASES_INDEX, await caseDocs(db, cases.map((c) => c.id)));
    return { upserted: docs.length, removed: gone.length };
  }
  const docs = await caseDocs(db, ids);
  await meili.upsert(CASES_INDEX, docs);
  const gone = ids.filter((x) => !docs.some((d) => d.id === x));
  await meili.remove(CASES_INDEX, gone);
  return { upserted: docs.length, removed: gone.length };
}

/**
 * 全量重建（每日 + 启动；兜底漏同步，同时刷新同义词与只读搜索 key）。
 * 调用方须在重建期间暂停增量消费者（否则重建期间写入正式索引的增量会被 swap 换掉）；暂停期间入队的任务在恢复后按最新数据重放。
 */
export async function rebuildSearchIndexes(db: Reader, meili: Meili): Promise<{ brands: number; cases: number }> {
  const b = await brandDocs(db);
  const c = await caseDocs(db);
  await meili.rebuild(BRANDS_INDEX, brandSettings(), b);
  await meili.rebuild(CASES_INDEX, caseSettings(), c);
  await meili.ensureSearchKey(SEARCH_KEY_UID, [BRANDS_INDEX, CASES_INDEX]);
  return { brands: b.length, cases: c.length };
}

