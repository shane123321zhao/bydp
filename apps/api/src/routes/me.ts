/**
 * 登录后的写 / 读接口（api-contract /me* · /complaints）。userId 一律取自会话（resolveUser），不接受请求体里的 userId。
 * 业务在 @bydp/core；本文件只做鉴权、校验与错误映射。
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { ComplaintCreate, ComplaintMine, Evidence, EvidenceType } from '@bydp/core/complaint';
import { getMyComplaint } from '@bydp/core/complaint/mine';
import { addEvidence, ComplaintInputError, submitComplaint, type EvidenceStore } from '@bydp/core/complaint/write';
import { Binding, BindingCreate, DataRequest, MePayload, Preferences, SelfExclusion, SubscriptionCreate } from '@bydp/core/identity';
import { createDataRequest, getPreferences, putPreferences, ReauthRequiredError } from '@bydp/core/identity/privacy';
import { getExportDownload } from '@bydp/core/admin/data-requests';
import { BindingConflictError } from '@bydp/core/identity/bindings';
import { SelfExcludedError, startSelfExclusion } from '@bydp/core/identity/self-exclusion';
import { SELF_EXCLUDED_ERROR } from '@bydp/core/commerce/tracking';
import { RateLimitedError } from '@bydp/core/abuse/limits';
import type { RateCounter } from '@bydp/core/identity/auth';
import { ApiError } from '@bydp/core/shared';
import { BrandNotBindableError, createMyBinding, getMe, listMyBindings, MeInputError, subscribe } from '@bydp/core/identity/me';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../app';
import type { Notify } from '../notify';
import type { ResolveUser } from '../session';
import { submissionError } from '../submission-errors';
import { addWithdrawalEvidence, amendWithdrawalOutcome, createReview, createWithdrawalReport, ReviewCreate, SubmissionInputError, WithdrawalOutcomeAmend, WithdrawalReportCreate } from '@bydp/core/trust/submissions';
import { pgConstraint } from './admin';

const ErrorBody = z.object({ error: z.string() });
const err = (description: string) => ({ description, content: { 'application/json': { schema: ErrorBody } } });
const ok = <T extends z.ZodType>(schema: T, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const sec = [{ bearer: [] }];
const Id = z.object({ id: z.string().min(1).max(64) });
/** 证据单文件上限 20MB（core 同口径），multipart 头部余量 1MB */
export const EVIDENCE_MAX_BYTES = 21 * 1024 * 1024;

/** 业务拒绝 → 4xx；其余抛出由框架 500 */
function mapError(c: Context, e: unknown) {
  // 409 按契约 Error 体（W2#066）：同品牌已绑定 → already_bound；自我排除期 → self_excluded
  if (e instanceof BindingConflictError) return c.json({ code: 'already_bound', message: '该运营商账号已被绑定（同一账号只能被一个 BYDP 用户绑定）' } satisfies ApiError, 409);
  if (e instanceof BrandNotBindableError) return c.json({ error: 'brand_not_bindable' }, 400);
  if (e instanceof SelfExcludedError) return c.json(SELF_EXCLUDED_ERROR, 409);
  // D-015 #2：按用户限流超额 → 429（契约 Error code = rate_limited）
  if (e instanceof RateLimitedError) return c.json({ code: 'rate_limited', message: e.message } satisfies ApiError, 429);
  // 注销二次验证（D-014）：同 401 语义「请重新登录」，不带契约 code
  if (e instanceof ReauthRequiredError) return c.json({ error: 'reauth_required' }, 401);
  if (e instanceof MeInputError || e instanceof ComplaintInputError) return c.json({ error: e.message }, 400);
  if (e instanceof SubmissionInputError) return c.json({ code: 'invalid_argument', message: e.message } satisfies ApiError, 400);
  if (e instanceof z.ZodError) return c.json({ error: 'bad_request' }, 400);
  // A-019：评价 / 出款凭证的数据库命名约束（触发器 / CHECK）
  const sub = submissionError(pgConstraint(e));
  if (sub) return c.json(sub.body, sub.status);
  throw e;
}

export function registerMe(app: OpenAPIHono<Env>, resolveUser: ResolveUser, evidenceStore: EvidenceStore | undefined, notify: Notify, counter?: RateCounter) {
  const who = async (c: Context) => resolveUser(c);

  app.openapi(createRoute({ method: 'get', path: '/me', tags: ['me'], security: sec, responses: { 200: ok(MePayload), 401: err('未登录') } }), async (c) => {
    const uid = await who(c);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    const me = await getMe(c.get('db'), uid);
    return me ? c.json(me, 200) : c.json({ error: 'unauthorized' }, 401);
  });

  app.openapi(createRoute({ method: 'get', path: '/me/bindings', tags: ['me'], security: sec, responses: { 200: ok(z.array(Binding)), 401: err('未登录') } }), async (c) => {
    const uid = await who(c);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await listMyBindings(c.get('db'), uid), 200);
  });

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/bindings',
      tags: ['me'],
      summary: '新增绑定（自报级；回传确认后升级）',
      security: sec,
      request: { body: { content: { 'application/json': { schema: BindingCreate.extend({ operatorAccountId: z.string().min(1).max(128) }) } } } },
      responses: { 201: ok(Binding, 'created'), 400: err('参数错误；黑名单品牌 → brand_not_bindable'), 401: err('未登录'), 409: { description: '不可绑定：同品牌已绑定（already_bound）/ 自我排除期（self_excluded）', content: { 'application/json': { schema: ApiError } } } },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        return c.json(await createMyBinding(c.get('db'), uid, c.req.valid('json')), 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );

  app.openapi(
    createRoute({ method: 'get', path: '/me/complaints/{id}', tags: ['me'], security: sec, request: { params: Id }, responses: { 200: ok(ComplaintMine), 401: err('未登录'), 404: err('不存在') } }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      const r = await getMyComplaint(c.get('db'), uid, c.req.valid('param').id);
      return r ? c.json(r, 200) : c.json({ error: 'not_found' }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/subscriptions',
      tags: ['me'],
      security: sec,
      request: { body: { content: { 'application/json': { schema: SubscriptionCreate } } } },
      responses: { 201: { description: 'created' }, 400: err('订阅对象不存在'), 401: err('未登录') },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        const r = await subscribe(c.get('db'), uid, c.req.valid('json'));
        return c.json({ id: r.id }, 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );

  // ---- 导出包下载（契约 v0.2 协调官补：GET /me/data-requests/{id}/download，7 天预签名链接） ----
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/data-requests/{id}/download',
      tags: ['me'],
      summary: '本人「导出我的数据」请求已完成时，取导出包下载链接（预签名，7 天有效）',
      security: sec,
      request: { params: Id },
      responses: {
        200: ok(z.object({ url: z.string().url(), expiresAt: z.iso.datetime({ offset: true }) })),
        401: err('未登录'),
        404: err('不存在 / 非导出请求 / 未完成'),
      },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      const r = evidenceStore ? await getExportDownload(c.get('db'), evidenceStore, uid, c.req.valid('param').id) : null;
      return r ? c.json(r, 200) : c.json({ error: 'not_found' }, 404);
    },
  );

  // ---- 负责任博彩 / 隐私（A-011 · 契约 /me/preferences · /me/self-exclusion · /me/data-requests） ----
  app.openapi(
    createRoute({ method: 'get', path: '/me/preferences', tags: ['me'], security: sec, responses: { 200: ok(Preferences), 401: err('未登录') } }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      return c.json(await getPreferences(c.get('db'), uid), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/me/preferences',
      tags: ['me'],
      summary: '限额提醒偏好（仅提醒不代扣；null = 关闭）',
      security: sec,
      request: { body: { content: { 'application/json': { schema: Preferences } } } },
      responses: { 200: ok(Preferences), 400: err('参数错误'), 401: err('未登录') },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      return c.json(await putPreferences(c.get('db'), uid, c.req.valid('json')), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/self-exclusion',
      tags: ['me'],
      summary: '自我排除（立即生效，期内不可撤销；permanent 不可撤销且不可再注册）',
      security: sec,
      request: { body: { content: { 'application/json': { schema: SelfExclusion } } } },
      responses: { 204: { description: 'ok' }, 400: err('参数错误'), 401: err('未登录') },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      await startSelfExclusion(c.get('db'), uid, c.req.valid('json').period);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/data-requests',
      tags: ['me'],
      summary: '隐私请求（证据原文脱敏 / 删除；导出；注销 = 匿名化）。M2 落库 + 站内确认通知，处理属 M3',
      security: sec,
      request: { body: { content: { 'application/json': { schema: DataRequest } } } },
      responses: { 202: { description: 'accepted' }, 400: err('参数错误'), 401: err('未登录；注销须 10 分钟内重新登录（reauth_required）') },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        await createDataRequest(c.get('db'), uid, c.req.valid('json'), { authTime: c.get('authTime') });
        return c.body(null, 202);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/complaints',
      tags: ['complaints'],
      summary: '提交投诉（登录）',
      security: sec,
      request: { body: { required: true, content: { 'application/json': { schema: ComplaintCreate } } } },
      responses: { 201: ok(ComplaintMine, 'created'), 400: err('参数错误'), 401: err('未登录'), 429: { description: '24 小时投诉数超限（rate_limited）', content: { 'application/json': { schema: ApiError } } } },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        const created = await submitComplaint(c.get('db'), uid, c.req.valid('json'), { counter });
        // 事务已提交：入队推送；失败只记日志（站内通知已写入）
        await notify(created.notificationIds).catch((e: Error) => console.error(JSON.stringify({ evt: 'notify_enqueue_failed', count: created.notificationIds.length, error: e.message })));
        return c.json((await getMyComplaint(c.get('db'), uid, created.id))!, 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );

  app.use('/complaints/:id/evidence', bodyLimit({ maxSize: EVIDENCE_MAX_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/complaints/{id}/evidence',
      tags: ['complaints'],
      summary: '上传证据（服务端计算 SHA-256 并存档哈希）',
      security: sec,
      request: {
        params: Id,
        body: {
          content: {
            'multipart/form-data': {
              schema: z.object({ type: EvidenceType, file: z.any().optional(), txHash: z.string().max(200).optional(), label: z.string().max(60).optional() }),
            },
          },
        },
      },
      responses: {
        201: ok(Evidence, 'created'),
        400: err('参数错误 / 文件类型不在白名单（图片、PDF、纯文本，按文件头判定）'),
        401: err('未登录'),
        413: err('超过 20MB'),
        429: { description: '24 小时证据份数或累计大小超限（rate_limited）', content: { 'application/json': { schema: ApiError } } },
        503: err('证据存储未配置'),
      },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      const form = c.req.valid('form');
      const file = form.file instanceof File ? form.file : null;
      if (file && !evidenceStore) return c.json({ error: 'evidence_storage_unavailable' }, 503);
      try {
        const row = await addEvidence(c.get('db'), evidenceStore ?? { put: async () => {} }, uid, c.req.valid('param').id, {
          type: form.type,
          label: form.label,
          content: file ? new Uint8Array(await file.arrayBuffer()) : undefined,
          contentType: file?.type || null,
          txHash: form.txHash ?? null,
        }, { counter });
        return c.json({ id: row.id, type: form.type, ...(form.label ? { label: form.label } : {}), sha256: row.sha256, uploadedAt: new Date(row.uploadedAt).toISOString(), redacted: false }, 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );

  // ---------------- D-024 出款凭证 / 评价（登录；迁移 0016 触发器兜底，命名约束经 submissionError 映射） ----------------
  const Created = z.object({ id: z.string(), status: z.literal('pending') });
  const apiErr = (description: string) => ({ description, content: { 'application/json': { schema: ApiError } } });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/withdrawal-reports',
      tags: ['me'],
      summary: '提交出款凭证（须本人绑定且绑定早于申请提款；提交后待审，须再上传截图才可采纳）',
      security: sec,
      request: { body: { required: true, content: { 'application/json': { schema: WithdrawalReportCreate } } } },
      responses: {
        201: ok(Created, 'created'),
        400: apiErr('参数错误'),
        401: err('未登录'),
        409: apiErr('binding_required：无本人绑定 / 绑定晚于申请提款'),
        422: apiErr('invalid_time：时间在未来或到账早于申请；invalid_argument：金额须 > 0'),
        429: apiErr('report_limit：同一绑定 30 天内最多 3 份'),
      },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        return c.json(await createWithdrawalReport(c.get('db'), uid, c.req.valid('json')), 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );
  app.use('/me/withdrawal-reports/:id/evidence', bodyLimit({ maxSize: EVIDENCE_MAX_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/withdrawal-reports/{id}/evidence',
      tags: ['me'],
      summary: '上传凭证截图（图片 / PDF，按文件头判定；服务端 SHA-256；只能挂在本人待审凭证上）',
      security: sec,
      request: { params: Id, body: { content: { 'multipart/form-data': { schema: z.object({ file: z.any() }) } } } },
      responses: {
        201: ok(z.object({ id: z.string(), sha256: z.string() }), 'created'),
        400: apiErr('参数错误 / 文件类型不在白名单'),
        401: err('未登录'),
        409: apiErr('凭证已审核'),
        413: err('超过 20MB'),
        429: apiErr('24 小时证据份数或累计大小超限（rate_limited）'),
        503: err('证据存储未配置'),
      },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      const file = c.req.valid('form').file;
      if (!(file instanceof File)) return c.json({ code: 'invalid_argument', message: '请选择截图文件' } satisfies ApiError, 400);
      if (!evidenceStore) return c.json({ error: 'evidence_storage_unavailable' }, 503);
      try {
        return c.json(await addWithdrawalEvidence(c.get('db'), evidenceStore, uid, c.req.valid('param').id, new Uint8Array(await file.arrayBuffer()), { counter }), 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/me/withdrawal-reports/{id}',
      tags: ['me'],
      summary: '补录出款结果：只能由「未到账」补为已到账（带到账时间）或被拒付，只能一次；判定后补录会提醒仲裁组复看',
      security: sec,
      request: { params: Id, body: { required: true, content: { 'application/json': { schema: WithdrawalOutcomeAmend } } } },
      responses: { 204: { description: 'OK' }, 400: apiErr('参数错误 / 已补录过'), 401: err('未登录'), 422: apiErr('invalid_time：到账时间在未来') },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        const r = await amendWithdrawalOutcome(c.get('db'), uid, c.req.valid('param').id, c.req.valid('json'));
        await notify(r.notificationIds).catch((e: Error) => console.error(JSON.stringify({ evt: 'notify_enqueue_failed', count: r.notificationIds.length, error: e.message })));
        return c.body(null, 204);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/reviews',
      tags: ['me'],
      summary: '提交评价（须本人绑定该品牌；每人每品牌一条有效评价；文字不公开，只用于计分；可信权重按绑定等级由服务端写入）',
      security: sec,
      request: { body: { required: true, content: { 'application/json': { schema: ReviewCreate } } } },
      responses: {
        201: ok(Created, 'created'),
        400: apiErr('参数错误'),
        401: err('未登录'),
        409: apiErr('binding_required / already_reviewed'),
        422: apiErr('invalid_argument：评价超过 500 字'),
      },
    }),
    async (c) => {
      const uid = await who(c);
      if (!uid) return c.json({ error: 'unauthorized' }, 401);
      try {
        return c.json(await createReview(c.get('db'), uid, c.req.valid('json')), 201);
      } catch (e) {
        return mapError(c, e) as never;
      }
    },
  );
}
