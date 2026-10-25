/** apps/api 端到端（app.request，无网络）；需 DATABASE_URL（已迁移 + seed） */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrandDetail, HomePayload } from '@bydp/core/api';
import { CasePublic, ComplaintPage } from '@bydp/core/complaint';
import { Offer, OffersPage } from '@bydp/core/commerce';
import { OfficialChannels, PointsConfig } from '@bydp/core/identity';
import { CheckResult, Identifier, ListPage, ScoreSnapshot, WithdrawalStats } from '@bydp/core/trust';
import { z } from 'zod';
import { parse } from 'yaml';
import { connect } from '@bydp/core/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());
const app = conn ? createApp(conn.db) : undefined;
const get = (path: string, headers: Record<string, string> = {}) => app!.request(path, { headers });

describe.skipIf(!url)('apps/api', () => {
  it('GET /v1/check 返回契约形状', async () => {
    const res = await get('/v1/check?q=jinlong88.com');
    expect(res.status).toBe(200);
    const body = CheckResult.parse(await res.json());
    expect(body.verdict).toBe('certified');
  });

  it('缺 q / 超长 q → 400', async () => {
    expect((await get('/v1/check')).status).toBe(400);
    expect((await get(`/v1/check?q=${'a'.repeat(257)}`)).status).toBe(400);
  });

  it('大陆 IP（CF-IPCountry: CN）→ 451 + /regions', async () => {
    const res = await get('/v1/check?q=jinlong88.com', { 'CF-IPCountry': 'CN' });
    expect(res.status).toBe(451);
    expect(await res.json()).toMatchObject({ regions: '/regions' });
    expect((await get('/v1/check?q=jinlong88.com', { 'CF-IPCountry': 'MY' })).status).toBe(200);
  });

  it('OpenAPI 3.1 文档自动生成，包含已实现路径', async () => {
    const doc = (await (await get('/v1/openapi.json')).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/check');
  });

  it('生成的每条路由都在 api-contract.yaml 中（同方法）', async () => {
    const doc = (await (await get('/v1/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>> };
    const contract = parse(readFileSync(join(import.meta.dirname, '../../../docs/design/api-contract.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const [p, ops] of Object.entries(doc.paths)) {
      const cp = p.replace(/\{(\w+)\}/g, '{$1}');
      expect(contract.paths[cp], p).toBeDefined();
      for (const m of Object.keys(ops)) expect(contract.paths[cp]![m], `${m} ${p}`).toBeDefined();
    }
  });

  const ok = async <T extends z.ZodType>(path: string, schema: T) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    return schema.parse(await res.json()) as z.infer<T>;
  };

  it('M1 全部只读端点返回契约形状', async () => {
    const home = await ok('/v1/home', HomePayload);
    expect(home.featured?.slug).toBe('jinlong');
    expect(home.libs).toEqual({ certified: 2, watch: 4, blacklist: 2, licensed: 4 });
    const d = await ok('/v1/brands/jinlong', BrandDetail);
    expect(d.featuredOffer?.id).toBe('of_001');
    expect(d.facts?.map((f) => f.v)).toEqual(['38 分', '92.6%', '20 万 U']);
    await ok('/v1/brands/jinlong/score', ScoreSnapshot);
    await ok('/v1/brands/winner-sports/complaints', ComplaintPage);
    await ok('/v1/brands/jinlong/withdrawals', WithdrawalStats);
    await ok('/v1/brands/jinlong/identifiers', z.array(Identifier));
    await ok('/v1/brands/jinlong/offers', z.array(Offer));
    for (const lib of ['certified', 'watch', 'licensed', 'blacklist']) await ok(`/v1/lists/${lib}`, ListPage);
    await ok('/v1/cases/cp_002', CasePublic);
    await ok('/v1/offers?filter=pos', OffersPage);
    await ok('/v1/config/points', PointsConfig);
    await ok('/v1/config/official-channels', OfficialChannels);
  });

  it('404：未收录品牌 / 非公开案件', async () => {
    expect((await get('/v1/brands/nope')).status).toBe(404);
    expect(await (await get('/v1/brands/nope')).json()).toEqual({ code: 'not_found', message: '未收录 / 不存在' }); // 契约 Error 体（W2#068）
    expect((await get('/v1/cases/cp_004')).status).toBe(404); // publicSummary=false
  });

  it('黑名单品牌评分为 null（品牌页 / 名单 / 评分子资源）', async () => {
    expect((await ok('/v1/brands/caishen-poker', BrandDetail)).score?.score ?? null).toBeNull();
    expect((await ok('/v1/brands/caishen-poker/score', ScoreSnapshot)).score).toBeNull();
    const list = await ok('/v1/lists/blacklist', ListPage);
    expect(list.items?.every((b) => (b.score?.score ?? null) === null)).toBe(true);
    expect(list.items?.map((b) => b.slug)).toEqual(['caishen-poker', 'haoyun-poker']); // 黑名单默认 listed_at 降序
  });

  it('名单排序与筛选：认证库 score 降序、地区过滤、KPI', async () => {
    const cert = await ok('/v1/lists/certified', ListPage);
    expect(cert.items?.map((b) => b.slug)).toEqual(['jinlong', 'royal-asia']);
    expect(cert.kpi?.map((k) => k.k)).toEqual(['本筛选', '平均分', '保证金 U']);
    const tw = await ok('/v1/lists/watch?region=TW', ListPage);
    expect(tw.items?.map((b) => b.slug)).toEqual(['crown-pacific']);
    expect((await get('/v1/lists/nope')).status).toBe(400);
  });

  it('优惠：黑名单品牌不出现；非认证强制风险标签、不享赔付', async () => {
    const all = await ok('/v1/offers', OffersPage);
    for (const o of all.items ?? []) {
      expect(o.brand?.status).not.toBe('blacklist');
      if (o.brand?.status !== 'certified') {
        expect(o.riskLabel).toBeTruthy();
        expect(o.compensationEligible).toBe(false);
      }
    }
    expect(all.items?.map((o) => o.trueValue?.netExpectedValueUsdt)).toEqual([33, 8, -40]); // ev 降序（D-029：of_002 按 tv-1 更正为 +33）
  });

  it('案件页：陈述脱敏、通知次数、证据哈希', async () => {
    const c = await ok('/v1/cases/cp_002', CasePublic);
    expect(c.replyWindow?.notices).toBe(2);
    expect(c.evidenceHashes).toHaveLength(3);
    expect(c.userBindingLevel).toBe('self_reported');
  });

  it('A-014：公开案件只读 publicDescription——投诉原文 description 的内容不出现在公开接口返回里', async () => {
    const ORIGINAL = 'ORIGINAL-ONLY-在原文里的私密内容';
    const PUBLIC = '公开脱敏陈述：提款被拒';
    let body = '';
    await conn!.db
      .transaction(async (tx) => {
        // 0013 起 description 写入后不可改（A-016）：新建一件已公开案件，原文为标记串
        await tx.execute(
          `insert into "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","status","publicSummary","publicDescription")
           values ('cp_a014','br_winner','u_233','delay','t',1,'2026-09-20','${ORIGINAL}','resolved',true,'${PUBLIC}')`,
        );
        const res = await createApp(tx as never).request('/v1/cases/cp_a014');
        body = await res.text();
        tx.rollback();
      })
      .catch((e: Error) => {
        if (!/rollback/i.test(e.message)) throw e;
      });
    expect(body).toContain(PUBLIC);
    expect(body).not.toContain('ORIGINAL-ONLY');
    expect(body).not.toContain('私密内容');
  });

  it('OpenAPI 覆盖契约中全部 M1 只读路径（/me 与写接口属 M2）', async () => {
    const doc = (await (await get('/v1/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>> };
    const contract = parse(readFileSync(join(import.meta.dirname, '../../../docs/design/api-contract.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const m1 = Object.entries(contract.paths)
      .filter(([p, ops]) => !p.startsWith('/me') && 'get' in ops)
      .map(([p]) => p)
      .sort();
    const got = Object.entries(doc.paths)
      .filter(([p, ops]) => !p.startsWith('/me') && 'get' in ops)
      .map(([p]) => p)
      .sort();
    expect(got).toEqual(m1);
  });
});

