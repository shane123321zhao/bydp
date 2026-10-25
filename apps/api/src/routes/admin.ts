/**
 * 后台接口（docs/design/api-contract-admin.yaml v0.2）：挂 `/admin/v1/*`，不进公开 OpenAPI 文档。
 * 鉴权：与公开 API 同一 Bearer 会话；角色每次请求从 user_role 读取并按权限矩阵校验（core admin/rbac）。
 * 未登录 401 `{error:'unauthorized'}`；无角色 / 越权 403 `Error{code:'forbidden'}`。写操作的 audit_log 在 core 同事务写入。
 * 第 1 轮：会话 · 仲裁台（队列 / 详情 / 流转 / 两次通知 / 曝光 / 公开确认）· 证据下载 · 角色读写。其余见 W3#046。
 */
import { adminExpose, adminOperatorNotice, adminOperatorReply, adminTransition, ConflictOfInterestError, getAdminComplaint, listAdminComplaints, publishComplaint } from '@bydp/core/admin/complaints';
import { downloadEvidence, EvidenceNotFoundError, GoneError, PREVIEW_PAGES, previewKey, readEvidenceForPreview } from '@bydp/core/admin/evidence';
import { decideSubmission, listAdminReviews, listAdminWithdrawals, readSubmissionEvidence, SubmissionStateError } from '@bydp/core/admin/submissions';
import { PreviewPageNotFoundError, PreviewUnavailableError, renderPreview } from '../admin-preview';
import {
  ADMIN_REAUTH,
  AdminReauthRequiredError,
  assertRecentAuth,
  authorize,
  ForbiddenError,
  getUserRoles,
  RoleChangeError,
  ROLES,
  setUserRoles,
  type Actor,
  type Permission,
  type Role,
} from '@bydp/core/admin/rbac';
import { AnonymizeBlockedError, confirmContact, DataRequestStateError, getAdminDataRequest, listAdminDataRequests, redactEvidenceForRequest, resolveDataRequest } from '@bydp/core/admin/data-requests';
import { decideReviewItem, getDashboard, listDeviceFlags, listReviewQueue, ReviewStateError } from '@bydp/core/admin/ops';
import { BrandNotFoundError, BrandStatusError, changeBrandStatus, listAdminBrands } from '@bydp/core/admin/brands';
import { listBrandOffers, OfferNotFoundError, OfferStatusError, setOfferStatus } from '@bydp/core/admin/offers';
import { listCandidatesByWeight } from '@bydp/core/trust/candidate-queries';
import { TransitionError } from '@bydp/core/complaint/state';
import { ComplaintInputError, type EvidenceStore } from '@bydp/core/complaint/write';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Env } from '../app';
import type { Notify, SearchSync } from '../notify';
import { searchJobsForReviewItem } from '@bydp/core/search';
import type { ResolveUser } from '../session';
import { EVIDENCE_MAX_BYTES } from './me';

type AdminEnv = Env & { Variables: Env['Variables'] & { uid: string; roles: Role[] } };
const IP = /^[0-9A-Fa-f:.]{2,45}$/;

const err = (c: Context, status: 400 | 403 | 404 | 409 | 410, code: string, message: string) => c.json({ code, message }, status);

function mapError(c: Context, e: unknown) {
  if (e instanceof ForbiddenError) return err(c, 403, 'forbidden', e.message);
  if (e instanceof AdminReauthRequiredError) return c.json({ error: 'reauth_required', message: e.message }, 401);
  if (e instanceof ConflictOfInterestError) return err(c, 409, 'conflict_of_interest', e.message);
  if (e instanceof AnonymizeBlockedError) return err(c, 409, e.code, e.message);
  if (e instanceof BrandNotFoundError || e instanceof OfferNotFoundError) return err(c, 404, 'not_found', e.message);
  if (e instanceof OfferStatusError) return err(c, 409, 'invalid_transition', e.message);
  // A-018：DB 触发器的命名约束精确映射（其他 check_violation 不在此处理）
  const constraint = pgConstraint(e);
  if (constraint === 'brand_related_party_never_certified') return err(c, 409, 'related_party', '关联方品牌不能认证');
  if (constraint === 'offer_blacklisted_brand_inactive') return err(c, 409, 'invalid_transition', '品牌在黑名单中，优惠不能上线');
  if (e instanceof SubmissionStateError) return err(c, 409, 'invalid_transition', e.message);
  if (e instanceof BrandStatusError) return err(c, 409, e.code, e.message);
  if (e instanceof TransitionError || e instanceof DataRequestStateError || e instanceof ReviewStateError) return err(c, 409, 'invalid_transition', e.message);
  if (e instanceof ComplaintInputError || e instanceof RoleChangeError) return err(c, 409, 'invalid_argument', e.message);
  if (e instanceof EvidenceNotFoundError) return err(c, 404, 'not_found', e.message);
  if (e instanceof GoneError) return err(c, 410, 'gone', e.message);
  if (e instanceof PreviewPageNotFoundError) return err(c, 404, 'not_found', e.message);
  if (e instanceof PreviewUnavailableError) {
    console.error(JSON.stringify({ evt: 'evidence_preview_unavailable', reason: e.message }));
    return c.json({ error: 'preview_unavailable', message: e.message }, 503);
  }
  if (e instanceof z.ZodError || e instanceof SyntaxError) return err(c, 400, 'invalid_argument', '参数错误');
  // 死锁（审核 A-016 风险记录）：仲裁结案（锁 complaint → 发分改 app_user）与注销（锁 app_user → 改 complaint）并发时 PG 中止其一；不改锁序，提示重试
  if (pgCode(e) === '40P01') {
    console.warn(JSON.stringify({ evt: 'admin_deadlock_retry', path: c.req.path }));
    return err(c, 409, 'invalid_argument', '操作冲突，请重试');
  }
  throw e;
}

/** postgres 约束名（触发器 RAISE … CONSTRAINT 同样带出；drizzle 包在 cause 里） */
export function pgConstraint(e: unknown): string | undefined {
  for (let x: unknown = e, i = 0; x && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const n = (x as { constraint_name?: unknown; constraint?: unknown }).constraint_name ?? (x as { constraint?: unknown }).constraint;
    if (typeof n === 'string' && n) return n;
  }
  return undefined;
}

/** postgres 错误码（drizzle 会把驱动错误包在 cause 里） */
export function pgCode(e: unknown): string | undefined {
  for (let x: unknown = e, i = 0; x && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

const ComplaintStatusQ = z.enum(['screening', 'accepted', 'awaiting_reply', 'arbitrating', 'resolved', 'rejected', 'unresolved', 'exposed']);
const TransitionBody = z.object({ to: z.enum(['accepted', 'rejected', 'resolved', 'unresolved']), reason: z.string().max(500).nullish() });
const NoticeBody = z.object({ which: z.enum(['first', 'second']), channel: z.string().min(1).max(120) });
const ReplyBody = z.object({ summary: z.string().max(1000).nullish() });
const ExposeBody = z.object({ reason: z.string().min(1).max(500) });
const PublishBody = z.object({
  title: z.string().min(1).max(80).optional(),
  publicDescription: z.string().min(1).max(500),
  checklist: z.object({ noPersonalNames: z.boolean(), noContactInfo: z.boolean(), noAccountIds: z.boolean(), noImagesWithFaces: z.boolean() }),
});
const BrandStatusBody = z.object({
  to: z.enum(['certified', 'watch', 'blacklist']),
  reason: z.string().trim().min(1).max(500),
  evidenceCaseIds: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).max(20).nullish(),
});
const RolesBody = z.object({ roles: z.array(z.enum(ROLES as [Role, ...Role[]])) });

export function registerAdmin(app: Hono<Env>, resolveUser: ResolveUser, opts: { notify: Notify; evidenceStore?: EvidenceStore; trustProxy?: boolean; siteUrl?: string | null; searchSync?: SearchSync }) {
  const admin = new Hono<AdminEnv>();

  const ip = (c: Context): string | null => {
    const v = opts.trustProxy ? (c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()) : undefined;
    return v && IP.test(v) ? v : null;
  };
  // 会话 → 角色：每次请求从 user_role 读取（不缓存，撤销角色立即生效）
  admin.use('*', async (c, next) => {
    const uid = await resolveUser(c);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    // 重新验证基线：后台请求须 24 小时内登录过（高风险操作在路由内另要求 10 分钟）
    try {
      assertRecentAuth(c.get('authTime'), ADMIN_REAUTH.baselineSec);
    } catch (e) {
      return mapError(c, e);
    }
    const roles = await getUserRoles(c.get('db'), uid);
    if (!roles.length) return err(c, 403, 'forbidden', '无后台角色');
    c.set('uid', uid);
    c.set('roles', roles);
    await next();
  });
  const actor = (c: Context<AdminEnv>, perm: Permission): Actor => ({ id: c.get('uid'), role: authorize(c.get('roles'), perm), ip: ip(c) });
  /** 高风险操作：确认曝光 / 公开与修订 / 角色变更 / 数据请求执行——10 分钟内登录过 */
  const highRisk = (c: Context<AdminEnv>) => assertRecentAuth(c.get('authTime'), ADMIN_REAUTH.highRiskSec);
  const enqueue = (ids: string[]) => opts.notify(ids).catch((e: Error) => console.error(JSON.stringify({ evt: 'notify_enqueue_failed', count: ids.length, error: e.message })));
  // 搜索索引同步入队失败只记日志（每日全量重建兜底）
  const reindex = (jobs: Parameters<SearchSync>[0]) =>
    (opts.searchSync ?? (async () => {}))(jobs).catch((e: Error) => console.error(JSON.stringify({ evt: 'search_enqueue_failed', error: e.message })));
  const run = async (c: Context<AdminEnv>, fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (e) {
      return mapError(c, e);
    }
  };
  const detail = async (c: Context<AdminEnv>, id: string) => {
    const d = await getAdminComplaint(c.get('db'), id);
    return d ? c.json(d, 200) : err(c, 404, 'not_found', '不存在');
  };

  admin.get('/session', (c) => run(c, async () => {
    actor(c, 'admin.session');
    return c.json({ userId: c.get('uid'), roles: c.get('roles') }, 200);
  }));

  // ---------------- 仲裁台 ----------------
  admin.get('/complaints', (c) => run(c, async () => {
    actor(c, 'arbitration.read');
    const status = c.req.query('status');
    const flag = c.req.query('flag');
    const page = await listAdminComplaints(c.get('db'), {
      status: status ? ComplaintStatusQ.parse(status) : undefined,
      flag: flag ? z.enum(['second_notice_due', 'pending_exposure_decision', 'awaiting_publish']).parse(flag) : undefined,
      // cursor = `<ISO 时间>|<id>`（上一页返回的 next）；格式不对 → 400，不进 SQL 类型转换
      cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[A-Za-z0-9_]{1,64}$/).nullish().parse(c.req.query('cursor')),
    });
    return c.json(page, 200);
  }));
  admin.get('/complaints/:id', (c) => run(c, async () => {
    actor(c, 'arbitration.read');
    return detail(c, c.req.param('id'));
  }));
  admin.post('/complaints/:id/transition', (c) => run(c, async () => {
    const a = actor(c, 'arbitration.write');
    const b = TransitionBody.parse(await c.req.json());
    const r = await adminTransition(c.get('db'), a, c.req.param('id'), b.to, b.reason ?? null);
    await enqueue(r.notificationIds);
    return detail(c, c.req.param('id'));
  }));
  admin.post('/complaints/:id/operator-notice', (c) => run(c, async () => {
    const a = actor(c, 'arbitration.write');
    const b = NoticeBody.parse(await c.req.json());
    const r = await adminOperatorNotice(c.get('db'), a, c.req.param('id'), b.which, b.channel);
    await enqueue(r.notificationIds);
    return detail(c, c.req.param('id'));
  }));
  // D-025（F4）：记录运营商答辩 → 进入仲裁
  admin.post('/complaints/:id/operator-reply', (c) => run(c, async () => {
    const a = actor(c, 'arbitration.write');
    const b = ReplyBody.parse(await c.req.json());
    const r = await adminOperatorReply(c.get('db'), a, c.req.param('id'), b.summary ?? null);
    await enqueue(r.notificationIds);
    return detail(c, c.req.param('id'));
  }));
  admin.post('/complaints/:id/expose', (c) => run(c, async () => {
    const a = actor(c, 'arbitration.write');
    highRisk(c);
    const b = ExposeBody.parse(await c.req.json());
    const r = await adminExpose(c.get('db'), a, c.req.param('id'), b.reason);
    await enqueue(r.notificationIds);
    return detail(c, c.req.param('id'));
  }));
  admin.post('/complaints/:id/publish', (c) => run(c, async () => {
    const a = actor(c, 'arbitration.write');
    highRisk(c);
    const b = PublishBody.parse(await c.req.json());
    await publishComplaint(c.get('db'), a, c.req.param('id'), b);
    await reindex([{ kind: 'case', ids: [c.req.param('id')] }]);
    return detail(c, c.req.param('id'));
  }));

  // ---------------- 证据 ----------------
  // 沙箱预览：不写 audit（契约 v0.2）；PNG 缓存到证据桶 preview/<id>/<page>.png
  admin.get('/evidence/:id/preview', (c) => run(c, async () => {
    actor(c, 'evidence.preview');
    const store = opts.evidenceStore;
    if (!store?.get) return err(c, 410, 'gone', '证据存储未配置');
    const page = z.coerce.number().int().min(1).max(PREVIEW_PAGES).parse(c.req.query('page') ?? '1');
    const id = c.req.param('id');
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" };
    const ev = await readEvidenceForPreview(c.get('db'), store, id); // 存在性 / 已删除校验先于缓存
    const cached = await store.get(previewKey(ev.id, page));
    if (cached) return new Response(Buffer.from(cached), { status: 200, headers: { ...headers, 'Content-Type': 'image/png' } });
    const r = await renderPreview(ev.content, page);
    if (r.cacheable) await store.put(previewKey(ev.id, page), r.body, 'image/png').catch(() => {});
    return new Response(Buffer.from(r.body), { status: 200, headers: { ...headers, 'Content-Type': r.contentType } });
  }));
  admin.get('/evidence/:id/download', (c) => run(c, async () => {
    const a = actor(c, 'evidence.download');
    if (!opts.evidenceStore?.get) return err(c, 410, 'gone', '证据存储未配置');
    const r = await downloadEvidence(c.get('db'), opts.evidenceStore, a, c.req.param('id'));
    return new Response(Buffer.from(r.body), { status: 200, headers: r.headers });
  }));

  // ---------------- D-024 提交审核：出款凭证（arbitrator / admin）· 评价（editor / admin） ----------------
  const SubQuery = z.object({ type: z.enum(['withdrawal', 'review']), status: z.enum(['pending', 'accepted', 'rejected']).default('pending'), amended: z.enum(['1']).optional() });
  admin.get('/submissions', (c) => run(c, async () => {
    const p = SubQuery.parse({ type: c.req.query('type'), status: c.req.query('status') ?? undefined, amended: c.req.query('amended') ?? undefined });
    actor(c, p.type === 'withdrawal' ? 'arbitration.read' : 'review.read');
    const items = p.type === 'withdrawal' ? await listAdminWithdrawals(c.get('db'), { status: p.status, amended: p.amended === '1' }) : await listAdminReviews(c.get('db'), { status: p.status });
    return c.json({ items }, 200);
  }));
  const DecisionBody = z.object({ decision: z.enum(['accept', 'reject']), reason: z.string().max(500).nullish() });
  admin.post('/submissions/:type/:id/decision', (c) => run(c, async () => {
    const type = z.enum(['withdrawal', 'review']).parse(c.req.param('type'));
    const a = actor(c, type === 'withdrawal' ? 'arbitration.write' : 'review.write');
    const b = DecisionBody.parse(await c.req.json());
    const r = await decideSubmission(c.get('db'), a, type, c.req.param('id'), b.decision, b.reason ?? null);
    await enqueue(r.notificationIds);
    return c.json({ ok: true }, 200);
  }));
  // 凭证截图沙箱预览（同投诉证据预览口径：不写 audit；PNG 缓存 preview/<se_id>/<page>.png）
  admin.get('/submission-evidence/:id/preview', (c) => run(c, async () => {
    actor(c, 'evidence.preview');
    const store = opts.evidenceStore;
    if (!store?.get) return err(c, 410, 'gone', '证据存储未配置');
    const page = z.coerce.number().int().min(1).max(PREVIEW_PAGES).parse(c.req.query('page') ?? '1');
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" };
    const ev = await readSubmissionEvidence(c.get('db'), store, c.req.param('id'));
    const cached = await store.get(previewKey(ev.id, page));
    if (cached) return new Response(Buffer.from(cached), { status: 200, headers: { ...headers, 'Content-Type': 'image/png' } });
    const r = await renderPreview(ev.content, page);
    if (r.cacheable) await store.put(previewKey(ev.id, page), r.body, 'image/png').catch(() => {});
    return new Response(Buffer.from(r.body), { status: 200, headers: { ...headers, 'Content-Type': r.contentType } });
  }));

  // ---------------- 隐私数据请求（§9.2 v1.9 / v1.10） ----------------
  const drDetail = async (c: Context<AdminEnv>, id: string) => {
    const d = await getAdminDataRequest(c.get('db'), id);
    return d ? c.json(d, 200) : err(c, 404, 'not_found', '不存在');
  };
  admin.get('/data-requests', (c) => run(c, async () => {
    actor(c, 'privacy.read');
    const status = z.enum(['pending', 'done', 'rejected']).default('pending').parse(c.req.query('status') ?? undefined);
    const cursor = z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[A-Za-z0-9_]{1,64}$/).nullish().parse(c.req.query('cursor'));
    return c.json(await listAdminDataRequests(c.get('db'), { status, cursor }), 200);
  }));
  admin.post('/data-requests/:id/contact-confirmed', (c) => run(c, async () => {
    const a = actor(c, 'privacy.write');
    highRisk(c);
    const b = z.object({ channel: z.enum(['telegram', 'email']) }).parse(await c.req.json());
    await confirmContact(c.get('db'), a, c.req.param('id'), b.channel);
    return drDetail(c, c.req.param('id'));
  }));
  // 上传先限流量再解析（与公开证据上传同口径），超限 413，不把整个大请求读进内存
  admin.post('/data-requests/:id/redact', bodyLimit({ maxSize: EVIDENCE_MAX_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }), (c) => run(c, async () => {
    const a = actor(c, 'privacy.write');
    highRisk(c);
    if (!opts.evidenceStore) return err(c, 410, 'gone', '证据存储未配置');
    const form = await c.req.parseBody();
    const evidenceId = z.string().min(1).max(64).parse(form.evidenceId);
    const file = form.file;
    if (!(file instanceof File)) return err(c, 400, 'invalid_argument', '缺少脱敏件');
    await redactEvidenceForRequest(c.get('db'), opts.evidenceStore, a, c.req.param('id'), evidenceId, new Uint8Array(await file.arrayBuffer()));
    return drDetail(c, c.req.param('id'));
  }));
  admin.post('/data-requests/:id/resolve', (c) => run(c, async () => {
    const a = actor(c, 'privacy.write');
    highRisk(c);
    const b = z.object({ result: z.enum(['done', 'rejected']), note: z.string().max(500).nullish() }).parse(await c.req.json());
    const r = await resolveDataRequest(c.get('db'), opts.evidenceStore ?? { put: async () => {} }, a, c.req.param('id'), b.result, b.note ?? null);
    await enqueue(r.notificationIds);
    return drDetail(c, c.req.param('id'));
  }));

  // ---------------- 风控 / 看板 / 审核台 ----------------
  const CURSOR = z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[A-Za-z0-9_]{1,64}$/).nullish();
  admin.get('/risk/device-flags', (c) => run(c, async () => {
    actor(c, 'risk.read');
    const cursor = z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f]{16}$/).nullish().parse(c.req.query('cursor'));
    return c.json(await listDeviceFlags(c.get('db'), cursor ?? null), 200);
  }));
  admin.get('/dashboard', (c) => run(c, async () => {
    actor(c, 'dashboard.read');
    return c.json(await getDashboard(c.get('db')), 200);
  }));
  admin.get('/review-queue', (c) => run(c, async () => {
    actor(c, 'review.read');
    const kind = z.enum(['brand_attribute', 'site_monitor', 'complaint_screening', 'localization']).optional().parse(c.req.query('kind') ?? undefined);
    return c.json(await listReviewQueue(c.get('db'), { kind, cursor: CURSOR.parse(c.req.query('cursor')) }), 200);
  }));
  // D-016 第 6 项：Candidate 视图（按去刷加权排序；编辑 / 管理员只读）
  admin.get('/candidates', (c) => run(c, async () => {
    actor(c, 'review.read');
    return c.json({ items: await listCandidatesByWeight(c.get('db')) }, 200);
  }));
  admin.post('/review-queue/:id/decision', (c) => run(c, async () => {
    const a = actor(c, 'review.write');
    const b = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).nullish() }).parse(await c.req.json());
    const r = await decideReviewItem(c.get('db'), a, c.req.param('id'), b.decision, b.note ?? null);
    if (b.decision === 'approve') await reindex(await searchJobsForReviewItem(c.get('db'), c.req.param('id')));
    return c.json(r, 200);
  }));

  // ---------------- 品牌状态（D-018 · 契约 v0.4.0） ----------------
  admin.get('/brands', (c) => run(c, async () => {
    actor(c, 'brand.read');
    const query = z.string().max(80).nullish().parse(c.req.query('q'));
    return c.json({ items: await listAdminBrands(c.get('db'), query ?? null) }, 200);
  }));
  admin.post('/brands/:id/status', (c) => run(c, async () => {
    const a = actor(c, 'brand.status.write');
    highRisk(c);
    const b = BrandStatusBody.parse(await c.req.json());
    const r = await changeBrandStatus(c.get('db'), a, c.req.param('id'), b, { siteUrl: opts.siteUrl });
    await enqueue(r.notificationIds);
    await reindex([{ kind: 'brand', ids: [c.req.param('id')] }]);
    return c.json(r.brand, 200);
  }));

  // ---------------- Offer 上线 / 下线（A-018 · 契约 v0.5.0） ----------------
  admin.get('/brands/:id/offers', (c) => run(c, async () => {
    actor(c, 'brand.read');
    return c.json({ items: await listBrandOffers(c.get('db'), c.req.param('id')) }, 200);
  }));
  admin.post('/offers/:id/status', (c) => run(c, async () => {
    const a = actor(c, 'offer.status.write');
    const b = z.object({ to: z.enum(['active', 'offline']), reason: z.string().trim().min(1).max(500) }).parse(await c.req.json());
    return c.json(await setOfferStatus(c.get('db'), a, c.req.param('id'), b), 200);
  }));

  // ---------------- 角色 ----------------
  admin.get('/users/:id/roles', (c) => run(c, async () => {
    actor(c, 'roles.read');
    return c.json(await getUserRoles(c.get('db'), c.req.param('id')), 200);
  }));
  admin.put('/users/:id/roles', (c) => run(c, async () => {
    const a = actor(c, 'roles.write');
    highRisk(c);
    const b = RolesBody.parse(await c.req.json());
    return c.json(await setUserRoles(c.get('db'), a, c.req.param('id'), b.roles), 200);
  }));

  app.route('/admin/v1', admin as unknown as Hono<Env>);
}
