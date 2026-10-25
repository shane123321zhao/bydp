/**
 * 调用 api `/admin/v1/*`（契约 v0.2）：读取 Auth.js 会话 cookie（独立子域时为后台专用 cookie），作为 Bearer 转发。
 * 权限、回避、重新验证全部由 api 判定；本层只把错误体转成页面可显示的结果。
 */
import 'server-only';
import { cookies, headers as reqHeaders } from 'next/headers';

const API = (process.env.ADMIN_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
/**
 * Auth.js 会话 cookie：https 下带 __Secure- 前缀（api 两种 salt 都会尝试）；本项目 JWT 远小于 4KB，不分片。
 * D-020 #3：后台独立子域（ADMIN_HOST）时只读后台专用 cookie（__Host-，仅本主机），不再接受主站会话。
 */
const COOKIE_NAMES = process.env.ADMIN_HOST?.trim() ? ['__Host-bydp-admin.session-token'] : ['__Secure-authjs.session-token', 'authjs.session-token'];

export async function sessionToken(): Promise<string | null> {
  const jar = await cookies();
  for (const name of COOKIE_NAMES) {
    const v = jar.get(name)?.value;
    if (v) return v;
  }
  return null;
}

export type ApiErr = { status: number; code: string; message: string };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; err: ApiErr };

/** 401 unauthorized / reauth_required 与 403 forbidden 统一成 code，供页面分流 */
function toErr(status: number, body: unknown): ApiErr {
  const b = (body ?? {}) as { code?: string; error?: string; message?: string };
  const code = b.code ?? b.error ?? (status === 401 ? 'unauthorized' : 'error');
  const fallback: Record<string, string> = {
    unauthorized: '未登录或会话已失效',
    reauth_required: '该操作需要重新登录',
    forbidden: '当前角色无权执行该操作',
    rate_limited: '操作过于频繁，请稍后再试',
  };
  return { status, code, message: b.message ?? fallback[code] ?? `请求失败（${status}）` };
}

export async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // 审计记操作人 IP：Caddy 覆盖写入的真实对端地址原样转给 api（api 仅在 BYDP_TRUST_PROXY=1 时采信）
  const ip = (await reqHeaders()).get('CF-Connecting-IP');
  if (ip) headers.set('CF-Connecting-IP', ip);
  return fetch(`${API}/admin/v1${path}`, { ...init, headers, cache: 'no-store' });
}

export async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<ApiResult<T>> {
  const { json, ...rest } = init;
  const res = await raw(path, json === undefined ? rest : { ...rest, body: JSON.stringify(json), headers: { ...rest.headers, 'Content-Type': 'application/json' } }).catch(() => null);
  if (!res) return { ok: false, err: { status: 502, code: 'api_unreachable', message: '后台接口不可达' } };
  const body = await res.json().catch(() => null);
  return res.ok ? { ok: true, data: body as T } : { ok: false, err: toErr(res.status, body) };
}

export type Role = 'arbitrator' | 'commerce' | 'editor' | 'admin';
export type Session = { userId: string; roles: Role[] };
