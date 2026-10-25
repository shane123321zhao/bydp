/**
 * 中文搜索（D-019 · 架构 §16 · ADR-0005）：Meilisearch 只给候选 id，排序 / 判定 / 过滤仍在 Postgres 与 entity-graph（五态判定不变）。
 * - 索引 brands：名称三语 + slug + 标识值 + status；cases：**仅已公开案件**（publicSummary）的公开标题 + publicDescription + 品牌名。
 *   **绝不索引 description 原文**（文档只从公开列构建，测试断言索引文档不含原文）。
 * - 索引与查询都经 normalizeSearch（OpenCC 归一到简体）；港澳同义词来自术语表 hk 列。
 * - Meili 未配置 / 不可达 / 超时：降级为 Postgres（ilike + pg_trgm），不报错，只记一条告警日志。
 */
import { schema, sql, type Db } from '@bydp/db';
import { meiliFromEnv, type Meili } from './meili';
import { normalizeSearch } from './normalize';

export { normalizeSearch } from './normalize';
type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export const BRANDS_INDEX = 'brands';
export const CASES_INDEX = 'cases';
export const ID = /^[A-Za-z0-9_]{1,64}$/;

export type BrandDoc = { id: string; names: string[]; slug: string; identifiers: string[]; status: string };
export type CaseDoc = { id: string; brandId: string; brandName: string; title: string; body: string };

/** 品牌文档（ids 为空 = 全部） */
export async function brandDocs(db: Reader, ids?: string[]): Promise<BrandDoc[]> {
  const rows = await q<{ id: string; slug: string; status: string; hans: string | null; hant: string | null; en: string | null; idents: string[] | null }>(
    db,
    sql`select b."id", b."slug", b."status", b."name"->>'zhHans' as "hans", b."name"->>'zhHant' as "hant", b."name"->>'en' as "en",
               (select array_agg(i."value" order by i."value") from ${schema.identifiers} i
                 where i."brandId" = b."id" and i."ownership" = 'official') as "idents"
        from ${schema.brands} b ${ids ? sql`where b."id" in ${ids.length ? ids : ['']}` : sql``} order by b."id"`,
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    status: r.status,
    names: [...new Set([r.hans, r.hant, r.en].filter((x): x is string => !!x).map(normalizeSearch))],
    identifiers: (r.idents ?? []).map((v) => v.toLowerCase()),
  }));
}

/** 公开案件文档：只读公开列（title / publicDescription），从不 select description */
export async function caseDocs(db: Reader, ids?: string[]): Promise<CaseDoc[]> {
  const rows = await q<{ id: string; brandId: string; title: string | null; publicDescription: string | null; brandName: string | null }>(
    db,
    sql`select c."id", c."brandId", c."title", c."publicDescription", b."name"->>'zhHans' as "brandName"
        from ${schema.complaints} c join ${schema.brands} b on b."id" = c."brandId"
        where c."publicSummary" ${ids ? sql`and c."id" in ${ids.length ? ids : ['']}` : sql``} order by c."id"`,
  );
  return rows.map((r) => ({
    id: r.id,
    brandId: r.brandId,
    brandName: normalizeSearch(r.brandName ?? ''),
    title: normalizeSearch(r.title ?? ''),
    body: normalizeSearch(r.publicDescription ?? ''),
  }));
}

// ---------------- 查询（Meili 优先，失败降级 Postgres） ----------------

let defaultMeili: Meili | null | undefined;
const meiliOf = (m?: Meili | null) => (m === undefined ? (defaultMeili === undefined ? (defaultMeili = meiliFromEnv()) : defaultMeili) : m);
let lastWarn = 0;
// 熔断：Meili 失败后 30 秒内直接走 pg（网络黑洞时不让每个请求都等超时）
let openUntil = 0;
const breakerOpen = () => Date.now() < openUntil;
function warnFallback(what: string, e: unknown) {
  openUntil = Date.now() + 30_000;
  if (Date.now() - lastWarn < 60_000) return;
  lastWarn = Date.now();
  console.warn(JSON.stringify({ evt: 'search_fallback_pg', what, error: (e as Error).message }));
}
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export type SearchOpts = { limit?: number; meili?: Meili | null };

/** 品牌候选 id（按相关度）；status 可选过滤 */
export async function searchBrandIds(db: Reader, query: string, opts: SearchOpts & { status?: 'certified' | 'watch' | 'blacklist' } = {}): Promise<string[]> {
  const n = normalizeSearch(query).slice(0, 100);
  if (!n) return [];
  const limit = opts.limit ?? 20;
  const m = meiliOf(opts.meili);
  if (m && (opts.meili !== undefined || !breakerOpen())) {
    try {
      return await m.searchIds(BRANDS_INDEX, n, { limit, filter: opts.status ? `status = ${opts.status}` : undefined });
    } catch (e) {
      warnFallback('brands', e);
    }
  }
  const raw = query.trim().slice(0, 100);
  const rows = await q<{ id: string }>(
    db,
    sql`select b."id" from ${schema.brands} b
        where (b."name"->>'zhHans' ilike ${likeOf(n)} or b."name"->>'zhHant' ilike ${likeOf(raw)} or b."name"->>'en' ilike ${likeOf(raw)}
               or b."slug" ilike ${likeOf(n)}
               or similarity(b."name"->>'zhHans', ${n}) > 0.3
               or exists (select 1 from ${schema.identifiers} i where i."brandId" = b."id" and i."ownership" = 'official' and i."value" ilike ${likeOf(n)}))
          ${opts.status ? sql`and b."status" = ${opts.status}` : sql``}
        order by greatest(similarity(b."name"->>'zhHans', ${n}), similarity(b."slug", ${n})) desc, b."id" limit ${limit}`,
  );
  return rows.map((r) => r.id);
}

/** 公开案件 id（按相关度）；brandId 可选过滤 */
export async function searchCaseIds(db: Reader, query: string, opts: SearchOpts & { brandId?: string } = {}): Promise<string[]> {
  const n = normalizeSearch(query).slice(0, 100);
  if (!n || (opts.brandId && !ID.test(opts.brandId))) return [];
  const limit = opts.limit ?? 50;
  const m = meiliOf(opts.meili);
  if (m && (opts.meili !== undefined || !breakerOpen())) {
    try {
      return await m.searchIds(CASES_INDEX, n, { limit, filter: opts.brandId ? `brandId = "${opts.brandId}"` : undefined });
    } catch (e) {
      warnFallback('cases', e);
    }
  }
  const raw = query.trim().slice(0, 100);
  const rows = await q<{ id: string }>(
    db,
    sql`select "id" from ${schema.complaints}
        where "publicSummary" ${opts.brandId ? sql`and "brandId" = ${opts.brandId}` : sql``}
          and ("title" ilike ${likeOf(n)} or "title" ilike ${likeOf(raw)} or "publicDescription" ilike ${likeOf(n)} or "publicDescription" ilike ${likeOf(raw)})
        order by "createdAt" desc, "id" desc limit ${limit}`,
  );
  return rows.map((r) => r.id);
}

/** 审核台落地后需重建索引的品牌（品牌名本地化 / 站点监控改标识）；其他类型不影响索引 */
export async function searchJobsForReviewItem(db: Reader, reviewItemId: string): Promise<{ kind: 'brand'; ids: string[] }[]> {
  const [r] = await q<{ kind: string; status: string; brandId: string | null; identifierId: string | null }>(
    db,
    sql`select "kind", "status", "proposal"->'target'->>'brandId' as "brandId", "proposal"->>'identifierId' as "identifierId"
        from ${schema.reviewItems} where "id" = ${reviewItemId}`,
  );
  if (!r || r.status !== 'approved') return [];
  if (r.kind === 'localization' && r.brandId) return [{ kind: 'brand', ids: [r.brandId] }];
  if (r.kind === 'site_monitor' && r.identifierId) {
    const [i] = await q<{ brandId: string | null }>(db, sql`select "brandId" from ${schema.identifiers} where "id" = ${r.identifierId}`);
    return i?.brandId ? [{ kind: 'brand', ids: [i.brandId] }] : [];
  }
  return [];
}
