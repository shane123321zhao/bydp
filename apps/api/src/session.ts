/**
 * 会话 → userId（userId 只取自会话，禁止取自请求体）。
 * - authJsBearerSession（A-009）：只认 `Authorization: Bearer <Auth.js 会话 JWT>`，**不读 cookie**（签核条件 1：防 CSRF）；
 *   用与 web 相同的 AUTH_SECRET 解密，再比对 app_user.sessionEpoch（作废后的旧 token 即 401）；
 * - noSession：未配置 AUTH_SECRET 时，一律未登录 → 需登录的接口返回 401；
 * - devHeaderSession：本地会话，读 `X-Dev-User`。仅当 BYDP_DEV_SESSION=1 **且**环境明确是开发 / 测试
 *   （NODE_ENV ∈ {development, test} 或 BYDP_ENV=local）时启用；其余一律拒绝启动（白名单，NODE_ENV 未设也拒绝）。
 */
import { decode } from '@auth/core/jwt';
import { getSessionUser } from '@bydp/core/identity/auth';
import type { Context } from 'hono';
import type { Env } from './app';

export type ResolveUser = (c: Context) => string | null | Promise<string | null>;

export const noSession: ResolveUser = () => null;

const DEV_USER = /^u_[A-Za-z0-9_]{1,64}$/;
export const devHeaderSession: ResolveUser = (c) => {
  const u = c.req.header('X-Dev-User');
  if (!u || !DEV_USER.test(u)) return null;
  // 本地会话的签发时刻：可用 X-Dev-Auth-Time（秒）模拟，缺省视为刚登录
  const t = Number(c.req.header('X-Dev-Auth-Time') ?? Math.floor(Date.now() / 1000));
  if (Number.isFinite(t)) (c as Context<Env>).set('authTime', t);
  return u;
};

/** Auth.js 会话 cookie 名即 JWT 加密的 salt：http 下为前者，https 下为 __Secure- 前缀；两者都尝试 */
export const AUTHJS_SALTS = ['__Secure-authjs.session-token', 'authjs.session-token'] as const;

/**
 * D-020 #3（HANDOVER §9 #22）：后台独立子域（ADMIN_HOST）时，后台登录由单独的 auth-admin 实例签发，cookie 名（= salt）为下者，
 * __Host- 前缀由浏览器强制「仅本主机、无 Domain、Path=/、Secure」。/admin/v1 只认该 salt：主站会话（含被 XSS 借用的）对后台无效。
 */
export const ADMIN_SESSION_COOKIE = '__Host-bydp-admin.session-token';
export const ADMIN_SALTS = [ADMIN_SESSION_COOKIE] as const;

export function authJsBearerSession(secret: string, salts: readonly string[] = AUTHJS_SALTS): ResolveUser {
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET 缺失或过短');
  return async (c) => {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec(c.req.header('Authorization') ?? '');
    if (!m) return null;
    for (const salt of salts) {
      const claims = await decode<{ uid?: unknown; epoch?: unknown; authTime?: unknown }>({ token: m[1]!, secret, salt }).catch(() => null);
      if (!claims) continue;
      if (typeof claims.uid !== 'string' || typeof claims.epoch !== 'number') return null;
      const u = await getSessionUser((c as Context<Env>).get('db'), { userId: claims.uid, epoch: claims.epoch });
      if (u && typeof claims.authTime === 'number') (c as Context<Env>).set('authTime', claims.authTime);
      return u?.userId ?? null;
    }
    return null;
  };
}

/** 后台会话：配置 ADMIN_HOST（独立子域）时只认后台 cookie 的 salt；未配置（测试站 /admin 路径）沿用主站会话 */
export function adminSessionFromEnv(env: Record<string, string | undefined> = process.env): ResolveUser {
  if (env.ADMIN_HOST?.trim() && env.BYDP_DEV_SESSION !== '1') return env.AUTH_SECRET ? authJsBearerSession(env.AUTH_SECRET, ADMIN_SALTS) : noSession;
  return sessionFromEnv(env);
}

export function sessionFromEnv(env: Record<string, string | undefined> = process.env): ResolveUser {
  if (env.BYDP_DEV_SESSION !== '1') return env.AUTH_SECRET ? authJsBearerSession(env.AUTH_SECRET) : noSession;
  const devEnv = env.NODE_ENV === 'development' || env.NODE_ENV === 'test' || env.BYDP_ENV === 'local';
  if (!devEnv) throw new Error('BYDP_DEV_SESSION 只能在开发环境开启（NODE_ENV=development|test 或 BYDP_ENV=local），不得用于生产');
  console.warn('⚠ 本地会话已开启（X-Dev-User）：仅限开发环境');
  return devHeaderSession;
}
