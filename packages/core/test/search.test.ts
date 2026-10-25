/**
 * D-019 中文搜索：OpenCC 归一 / 港澳同义词 / 公开案件索引不含原文 / Meili 不可用降级 Postgres / 三个接入点（/check 候选、名单 q、品牌案件 q）。
 * 需 DATABASE_URL（已迁移 + seed）；Meili 用假 fetch 或不可达地址（CI 无 Meilisearch 服务）。
 */
import { createDb } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { brandDocs, caseDocs, searchBrandIds, searchCaseIds } from '../src/search/index';
import { syncSearchDocs } from '../src/search/indexer';
import { Meili } from '../src/search/meili';
import { normalizeSearch, synonymsFromGlossary } from '../src/search/normalize';
import { searchJobs } from '../src/search/queue';
import { checkIdentifier } from '../src/trust/check';
import { CheckResult } from '../src/trust/index';
import { getBrandComplaints, getList } from '../src/trust/brands';
import { submitComplaint } from '../src/complaint/write';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
const DOWN = new Meili({ url: 'http://127.0.0.1:9', key: 'test', timeoutMs: 300 });

async function inTx<T>(fn: (tx: typeof conn extends undefined ? never : NonNullable<typeof conn>['db']) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      out = await fn(tx as never);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

describe('归一与同义词（纯函数）', () => {
  it('台繁 / 港繁 / 全角 → 简体小写', () => {
    expect(normalizeSearch('金龍娛樂城')).toBe('金龙娱乐城');
    expect(normalizeSearch('  ＪｉｎＬｏｎｇ  網上 軟體 ')).toBe('jinlong 网上 软件');
  });
  it('术语表 hk 列 → 双向同义词（归一后）；无 hk 的条目不产生同义词', () => {
    const s = synonymsFromGlossary([
      { hans: '提款', hant: '提款', hk: ['出糧', '攞錢'] },
      { hans: '优惠', hant: '優惠' },
    ]);
    expect(s['提款']?.sort()).toEqual(['出粮', '攞钱'].sort());
    expect(s['出粮']).toEqual(expect.arrayContaining(['提款', '攞钱']));
    expect(s['优惠']).toBeUndefined();
  });
  it('队列不设自定义 jobId（同对象短时间内两次修订都会处理），空对象不入队', () => {
    const jobs = searchJobs([{ kind: 'brand', ids: ['br_a'] }, { kind: 'case', ids: [] }]);
    expect(jobs).toHaveLength(1);
    expect('jobId' in jobs[0]!.opts).toBe(false);
  });
});

describe('Meili 客户端', () => {
  it('search 只取 id、带过滤；Bearer 鉴权', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, init });
      return new Response(JSON.stringify({ hits: [{ id: 'br_jinlong' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = new Meili({ url: 'http://meili:7700/', key: 'k', fetchImpl: fake });
    expect(await m.searchIds('cases', '提款', { filter: 'brandId = "br_jinlong"', limit: 5 })).toEqual(['br_jinlong']);
    expect(calls[0]!.url).toBe('http://meili:7700/indexes/cases/search');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ q: '提款', limit: 5, attributesToRetrieve: ['id'], filter: 'brandId = "br_jinlong"' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });
  it('不可达 → MeiliError（不回显密钥）', async () => {
    await expect(DOWN.searchIds('brands', 'x')).rejects.toThrow(/Meilisearch 不可达/);
    await expect(DOWN.searchIds('brands', 'x')).rejects.not.toThrow(/test/);
  });
});

describe.skipIf(!url)('索引文档与降级查询（DB）', () => {
  it('公开案件文档只含公开标题 / 公开描述 / 品牌名，绝不含 description 原文；未公开案件不入索引', async () => {
    const r = await inTx(async (tx) => {
      const MARK = '原文标记-ZXQ-13800001111';
      const c = await submitComplaint(tx as never, 'u_233', { brandId: 'br_jinlong', category: 'refused', amountUsdt: 900, eventDate: '2026-09-20', description: `客服拒付 ${MARK}` });
      const before = await caseDocs(tx as never, [c.id]);
      await tx.execute(`update "complaint" set "status" = 'resolved', "title" = '提款被拒后协商解决', "publicDescription" = '用户提款被拒，经仲裁后运营商补发。', "publicSummary" = true where "id" = '${c.id}'` as never);
      const docs = await caseDocs(tx as never);
      return { before, mine: docs.find((d) => d.id === c.id), all: JSON.stringify(docs), MARK, descs: (await tx.execute(`select "description", "publicDescription" from "complaint" where "publicSummary"` as never)) as unknown as { description: string; publicDescription: string }[] };
    });
    expect(r.before).toEqual([]);
    expect(r.mine).toMatchObject({ brandId: 'br_jinlong', title: '提款被拒后协商解决', body: normalizeSearch('用户提款被拒，经仲裁后运营商补发。'), brandName: '金龙娱乐城' });
    expect(r.all).not.toContain(r.MARK);
    // 所有公开案件：原文都不出现在索引文档里（原文与公开描述恰好相同的除外）
    for (const d of r.descs) if (d.description && d.description !== d.publicDescription) expect(r.all).not.toContain(normalizeSearch(d.description));
    expect(Object.keys(r.mine!).sort()).toEqual(['body', 'brandId', 'brandName', 'id', 'title']);
  });

  it('品牌文档：三语名归一 + 标识值', async () => {
    const [d] = await brandDocs(conn!.db, ['br_jinlong']);
    expect(d!.names).toContain('金龙娱乐城');
    expect(d!.identifiers).toContain('jinlong88.com');
    expect(d!.status).toBe('certified');
  });

  it('Meili 不可达 → 降级 Postgres，不报错；繁体 / 港澳写法经归一命中简体名', async () => {
    expect(await searchBrandIds(conn!.db, '金龍', { meili: DOWN })).toContain('br_jinlong');
    expect(await searchBrandIds(conn!.db, 'jinlong88', { meili: null })).toContain('br_jinlong');
    expect(await searchBrandIds(conn!.db, '%', { meili: null })).toEqual([]);
    expect(await searchBrandIds(conn!.db, '金龍', { meili: null, status: 'blacklist' })).toEqual([]);
  });

  it('增量同步：索引不存在 → 全量重建（不建残缺索引）', async () => {
    const calls: string[] = [];
    const fake = (async (u: string, init: RequestInit) => {
      const path = new URL(u).pathname;
      calls.push(`${init.method} ${path}`);
      if (init.method === 'GET' && path.startsWith('/indexes/')) return new Response('{"code":"index_not_found"}', { status: 404 });
      if (init.method === 'GET' && path.startsWith('/keys/')) return new Response('{}', { status: 200 });
      if (init.method === 'GET' && path.startsWith('/tasks/')) return new Response('{"status":"succeeded"}', { status: 200 });
      return new Response('{"taskUid":1}', { status: 202 });
    }) as unknown as typeof fetch;
    const r = await syncSearchDocs(conn!.db, new Meili({ url: 'http://m', key: 'k', fetchImpl: fake }), { kind: 'brand', ids: ['br_jinlong'] });
    expect(r.rebuilt).toBe(true);
    expect(calls).toContain('POST /swap-indexes');
  });

  it('增量同步：Meili 写失败时抛错（交由队列重试），不吞掉', async () => {
    await expect(syncSearchDocs(conn!.db, DOWN, { kind: 'brand', ids: ['br_jinlong'] })).rejects.toThrow(/Meilisearch/);
    expect(await syncSearchDocs(conn!.db, DOWN, { kind: 'case', ids: ['bad id!'] })).toEqual({ upserted: 0, removed: 0 });
  });
});

describe.skipIf(!url)('接入点（Meili 未配置，走 Postgres）', () => {
  it('/check 未精确命中 → suggestions 给候选，判定仍是 unknown；精确命中不带 suggestions', async () => {
    const r = await checkIdentifier(conn!.db, '金龍娛樂');
    expect(CheckResult.parse(r)).toBeTruthy();
    expect(r.verdict).toBe('unknown');
    expect(r.suggestions?.map((b) => b.slug)).toContain('jinlong');
    const hit = await checkIdentifier(conn!.db, 'jinlong88.com');
    expect(hit.verdict).toBe('certified');
    expect(hit.suggestions).toBeUndefined();
  });

  it('名单 q：只在本库内过滤；无匹配返回空页', async () => {
    const cert = await getList(conn!.db, 'certified', { q: '金龍' });
    expect(cert.items?.map((b) => b.slug)).toEqual(['jinlong']);
    expect((await getList(conn!.db, 'blacklist', { q: '金龍' })).items).toEqual([]);
    expect((await getList(conn!.db, 'certified', { q: '不存在的品牌名xyz' })).items).toEqual([]);
  });

  it('品牌案件 q：只搜该品牌已公开案件的公开标题 / 描述', async () => {
    const all = (await getBrandComplaints(conn!.db, 'jinlong'))!;
    const first = all.items?.[0];
    expect(first).toBeTruthy();
    const kw = first!.title!.slice(0, 2);
    const hit = (await getBrandComplaints(conn!.db, 'jinlong', undefined, kw))!;
    expect(hit.items?.map((c) => c.id)).toContain(first!.id);
    expect((await getBrandComplaints(conn!.db, 'jinlong', undefined, '不存在的关键词xyz'))!.items).toEqual([]);
    expect(await searchCaseIds(conn!.db, kw, { brandId: 'br_nope', meili: null })).toEqual([]);
  });
});
