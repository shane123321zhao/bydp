/** M1 只读路由（api-contract.yaml）；全部委托 @bydp/core/usecases */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { BrandDetail, HomePayload } from '@bydp/core/api';
import { OfficialChannels, PointsConfig } from '@bydp/core/identity';
import { CasePublic, ComplaintPage } from '@bydp/core/complaint';
import { Offer, OfferFilter, OffersPage } from '@bydp/core/commerce';
import { Identifier, ListLib, ListPage, ListQuery, ScoreSnapshot, WithdrawalStats } from '@bydp/core/trust';
import * as uc from '@bydp/core/usecases';
import { ApiError } from '@bydp/core/shared';
import type { Env } from '../app';

const json = <T extends z.ZodType>(schema: T, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
/** 契约 4xx 统一 Error 体（W2#068：只读接口 404 与写接口一致） */
const NOT_FOUND: ApiError = { code: 'not_found', message: '未收录 / 不存在' };
const notFound = { description: '未收录 / 不存在', content: { 'application/json': { schema: ApiError } } };
const Slug = z.object({ slug: z.string().min(1).max(128) });
const Cursor = z.object({ cursor: z.string().max(256).optional() });

export function registerRead(app: OpenAPIHono<Env>) {
  app.openapi(createRoute({ method: 'get', path: '/home', tags: ['home'], summary: '首页聚合', responses: { 200: json(HomePayload) } }), async (c) =>
    c.json(await uc.getHome(c.get('db')), 200),
  );

  app.openapi(
    createRoute({ method: 'get', path: '/brands/{slug}', tags: ['brands'], request: { params: Slug }, responses: { 200: json(BrandDetail), 404: notFound } }),
    async (c) => {
      const r = await uc.getBrandDetail(c.get('db'), c.req.valid('param').slug);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );
  app.openapi(
    createRoute({ method: 'get', path: '/brands/{slug}/score', tags: ['brands'], request: { params: Slug }, responses: { 200: json(ScoreSnapshot), 404: notFound } }),
    async (c) => {
      const r = await uc.getBrandScore(c.get('db'), c.req.valid('param').slug);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/brands/{slug}/complaints',
      tags: ['brands'],
      summary: '公开案件（publicSummary=true）',
      request: { params: Slug, query: Cursor.extend({ q: z.string().max(100).optional() }) },
      responses: { 200: json(ComplaintPage), 404: notFound },
    }),
    async (c) => {
      const r = await uc.getBrandComplaints(c.get('db'), c.req.valid('param').slug, c.req.valid('query').cursor, c.req.valid('query').q);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );
  app.openapi(
    createRoute({ method: 'get', path: '/brands/{slug}/withdrawals', tags: ['brands'], request: { params: Slug }, responses: { 200: json(WithdrawalStats), 404: notFound } }),
    async (c) => {
      const r = await uc.getBrandWithdrawals(c.get('db'), c.req.valid('param').slug);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );
  app.openapi(
    createRoute({ method: 'get', path: '/brands/{slug}/identifiers', tags: ['brands'], request: { params: Slug }, responses: { 200: json(z.array(Identifier)), 404: notFound } }),
    async (c) => {
      const r = await uc.getBrandIdentifiers(c.get('db'), c.req.valid('param').slug);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );
  app.openapi(
    createRoute({ method: 'get', path: '/brands/{slug}/offers', tags: ['brands'], request: { params: Slug }, responses: { 200: json(z.array(Offer)), 404: notFound } }),
    async (c) => {
      const r = await uc.getBrandOffers(c.get('db'), c.req.valid('param').slug);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/lists/{lib}',
      tags: ['lists'],
      summary: '四库名单',
      // sort 不带默认值：契约默认 score_desc，但 field-mapping 04 规定黑名单默认 listed_at_desc —— 由 core 按库决定
      request: {
        params: z.object({ lib: ListLib }),
        query: z.object({ region: ListQuery.shape.region, sort: z.enum(['score_desc', 'listed_at_desc']).optional(), cursor: ListQuery.shape.cursor, q: z.string().max(100).optional() }),
      },
      responses: { 200: json(ListPage) },
    }),
    async (c) => {
      const { region, sort, cursor, q } = c.req.valid('query');
      return c.json(
        await uc.getList(c.get('db'), c.req.valid('param').lib, { ...(region ? { region } : {}), ...(sort ? { sort } : {}), ...(cursor ? { cursor } : {}), ...(q?.trim() ? { q } : {}) }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/cases/{id}',
      tags: ['complaints'],
      summary: '公开案件页（仅 publicSummary）',
      request: { params: z.object({ id: z.string().min(1).max(64) }) },
      responses: { 200: json(CasePublic), 404: { description: '不公开或不存在', content: { 'application/json': { schema: ApiError } } } },
    }),
    async (c) => {
      const r = await uc.getCase(c.get('db'), c.req.valid('param').id);
      return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/offers',
      tags: ['offers'],
      request: { query: z.object({ filter: OfferFilter.optional(), cursor: z.string().max(256).optional() }) },
      responses: { 200: json(OffersPage) },
    }),
    async (c) => {
      const { filter, cursor } = c.req.valid('query');
      return c.json(await uc.getOffers(c.get('db'), filter ?? 'all', cursor), 200);
    },
  );

  app.openapi(
    createRoute({ method: 'get', path: '/config/points', tags: ['config'], summary: '积分规则（可配置，P1）', responses: { 200: json(PointsConfig) } }),
    async (c) => c.json(await uc.getPointsConfig(c.get('db')), 200),
  );
  app.openapi(
    createRoute({ method: 'get', path: '/config/official-channels', tags: ['config'], responses: { 200: json(OfficialChannels) } }),
    async (c) => c.json(await uc.getOfficialChannels(c.get('db')), 200),
  );
}
