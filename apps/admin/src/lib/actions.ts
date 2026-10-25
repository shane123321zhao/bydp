'use server';
/**
 * 后台写操作（server actions）：一律转发 api `/admin/v1/*`，结果经短时 cookie 回到原页面显示。
 * 不在本层做权限判断（api 按 user_role 校验，回避 / 重新验证同理）。
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { call, raw, type ApiResult } from './api';
import { BRAND_STATUS_TEXT, STATUS_TEXT } from './labels';
import { FLASH_COOKIE, type Flash } from './flash';

const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
/** 回跳路径只接受站内相对路径（basePath 内，不含 ..） */
const backOf = (f: FormData) => {
  const b = s(f, 'back');
  return /^\/(?!\/)[^\s\\]*$/.test(b) && !b.includes('..') ? b : '/';
};
const enc = encodeURIComponent;

/**
 * 结果提示放在短时 httpOnly cookie（15 秒，path=/admin），不放 URL 参数——外站无法伪造后台提示。
 * 回跳用同源绝对 URL：Next 16 对 server action 的相对 redirect 会再叠一次 basePath（/admin/admin/…），绝对 URL 原样使用。
 */
async function done(f: FormData, r: ApiResult<unknown>, okText: string): Promise<never> {
  const back = backOf(f);
  const flash: Flash = r.ok ? { tone: 'ok', text: okText, path: back } : { tone: 'bad', text: r.err.message, code: r.err.code, path: back };
  (await cookies()).set(FLASH_COOKIE, JSON.stringify(flash), { path: '/admin', maxAge: 15, httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  redirect(host ? `${proto}://${host}/admin${back === '/' ? '' : back}` : `/admin${back}`);
}

const post = (path: string, json: unknown) => call(path, { method: 'POST', json });

// ---------- 仲裁台 ----------
export async function transitionAction(f: FormData) {
  const to = s(f, 'to');
  const r = await post(`/complaints/${enc(s(f, 'id'))}/transition`, { to, reason: s(f, 'reason') || null });
  await done(f, r, `已流转：${STATUS_TEXT[to] ?? to}`);
}

export async function noticeAction(f: FormData) {
  const which = s(f, 'which');
  const r = await post(`/complaints/${enc(s(f, 'id'))}/operator-notice`, { which, channel: s(f, 'channel') });
  await done(f, r, which === 'first' ? '已记录首次通知' : '已记录二次通知');
}

/** D-025（F4）：记录运营商答辩 → 进入仲裁 */
export async function operatorReplyAction(f: FormData) {
  const r = await post(`/complaints/${enc(s(f, 'id'))}/operator-reply`, { summary: s(f, 'summary') || null });
  await done(f, r, '已记录运营商答辩，案件进入仲裁');
}

export async function exposeAction(f: FormData) {
  const r = await post(`/complaints/${enc(s(f, 'id'))}/expose`, { reason: s(f, 'reason') });
  await done(f, r, '已确认转曝光');
}

export async function publishAction(f: FormData) {
  const checklist = {
    noPersonalNames: f.get('noPersonalNames') === 'on',
    noContactInfo: f.get('noContactInfo') === 'on',
    noAccountIds: f.get('noAccountIds') === 'on',
    noImagesWithFaces: f.get('noImagesWithFaces') === 'on',
  };
  const r = await post(`/complaints/${enc(s(f, 'id'))}/publish`, { title: s(f, 'title'), publicDescription: s(f, 'publicDescription'), checklist });
  await done(f, r, '已公开（脱敏文本已保存）');
}

// ---------- 数据请求 ----------
export async function contactConfirmAction(f: FormData) {
  const r = await post(`/data-requests/${enc(s(f, 'id'))}/contact-confirmed`, { channel: s(f, 'channel') });
  await done(f, r, '已记录联系确认');
}

export async function redactAction(f: FormData) {
  const file = f.get('file');
  const body = new FormData();
  body.set('evidenceId', s(f, 'evidenceId'));
  if (file instanceof File && file.size > 0) body.set('file', file, 'redacted');
  const res = await raw(`/data-requests/${enc(s(f, 'id'))}/redact`, { method: 'POST', body }).catch(() => null);
  const json = res ? await res.json().catch(() => null) : null;
  const r: ApiResult<unknown> = res?.ok
    ? { ok: true, data: json }
    : { ok: false, err: { status: res?.status ?? 502, code: json?.code ?? json?.error ?? 'error', message: json?.message ?? (res ? `上传失败（${res.status}）` : '后台接口不可达') } };
  await done(f, r, '脱敏件已替换原文');
}

export async function resolveDataRequestAction(f: FormData) {
  const result = s(f, 'result');
  const r = await post(`/data-requests/${enc(s(f, 'id'))}/resolve`, { result, note: s(f, 'note') || undefined });
  await done(f, r, result === 'done' ? '已完成并通知申请人' : '已驳回并通知申请人');
}

// ---------- 审核台 / 角色 ----------
export async function reviewDecisionAction(f: FormData) {
  const decision = s(f, 'decision');
  const r = await post(`/review-queue/${enc(s(f, 'id'))}/decision`, { decision, note: s(f, 'note') || undefined });
  await done(f, r, decision === 'approve' ? '已通过（落地动作待 Agent 卡）' : '已驳回');
}

export async function setRolesAction(f: FormData) {
  const roles = f.getAll('roles').map(String);
  const r = await call(`/users/${enc(s(f, 'userId'))}/roles`, { method: 'PUT', json: { roles } });
  await done(f, r, '角色已更新');
}

// ---------- 品牌状态（D-018） ----------
export async function brandStatusAction(f: FormData) {
  const to = s(f, 'to');
  const evidenceCaseIds = s(f, 'evidenceCaseIds').split(/[\s,，]+/).filter(Boolean);
  const r = await post(`/brands/${enc(s(f, 'id'))}/status`, { to, reason: s(f, 'reason'), evidenceCaseIds });
  await done(f, r, `品牌状态已变更为「${BRAND_STATUS_TEXT[to] ?? to}」`);
}

// ---------- Offer 上线 / 下线（A-018） ----------
export async function offerStatusAction(f: FormData) {
  const to = s(f, 'to');
  const r = await post(`/offers/${enc(s(f, 'id'))}/status`, { to, reason: s(f, 'reason') });
  await done(f, r, to === 'active' ? '优惠已上线' : '优惠已下线');
}

// ---------- D-024 提交审核 ----------
export async function submissionDecisionAction(f: FormData) {
  const type = s(f, 'type') === 'review' ? 'review' : 'withdrawal';
  const decision = s(f, 'decision') === 'reject' ? 'reject' : 'accept';
  const r = await post(`/submissions/${type}/${enc(s(f, 'id'))}/decision`, { decision, reason: s(f, 'reason') || null });
  await done(f, r, decision === 'accept' ? (type === 'review' ? '评价已发布' : '凭证已采纳') : '已驳回并通知提交人');
}
