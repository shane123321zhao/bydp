/**
 * Auth.js 胶水（A-009）：adapter / TG Credentials authorize / magic link 发信 / jwt 回调的逻辑都在这里，依赖注入、可测；
 * apps/web 的 auth.ts 只做装配。不依赖 next-auth 类型（结构化类型对齐 @auth/core 0.41 的 Adapter 签名）。
 */
import type { Db } from '@bydp/db';
import {
  consumeVerificationToken,
  findUserByEmail,
  getSessionUser,
  magicLinkAllowed,
  saveVerificationToken,
  signInWithIdentity,
  userSessionEpoch,
  type AuthKeys,
  type OnceStore,
  type RateCounter,
} from './auth';
import { sendMagicLink, type SendEmail } from './magic-link-email';
import { maskEmail, maskTelegram, normalizeEmail } from './pii';
import { verifyTelegramLogin } from './telegram';

/**
 * 会话时长：Auth.js 的 JWT 会话在每次读取时重新签发（exp = now + maxAge），即 7 天滑动；updateAge 只对数据库会话生效。
 * 另设绝对上限 30 天（自检 4）：自首次登录起超过即失效，须重新登录。
 */
export const SESSION_MAX_AGE_SEC = 7 * 24 * 3600;
export const SESSION_UPDATE_AGE_SEC = 24 * 3600;
export const SESSION_ABSOLUTE_MAX_SEC = 30 * 24 * 3600;
/** TG Login Widget 已知字段（Auth.js Credentials 的表单声明用） */
export const TELEGRAM_FIELDS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash'] as const;
/** Auth.js 表单附带、不属于 TG 签名的字段（黑名单剔除；TG 日后新增签名字段仍参与校验，自检 11） */
export const AUTH_FORM_FIELDS = new Set(['csrfToken', 'callbackUrl', 'redirect', 'redirectTo', 'json']);
/** TG 签名数据一次性消费的保留时长（≥ 10 分钟时效 + 60 秒时钟容差） */
const TG_REPLAY_TTL_SEC = 11 * 60;

type AuthDb = Pick<Db, 'execute' | 'transaction'>;

/**
 * 部署环境（BYDP_ENV=staging|production）登录必需配置（自检阻塞 1 / 2）：缺任一返回其名，web 启动即拒绝。
 * AUTH_URL 防 Host 头投毒；REDIS_URL 保证多实例限流 / 防重放有效；BYDP_TRUST_PROXY=1 才能取到真实 IP。
 */
export function missingAuthDeploymentConfig(env: Record<string, string | undefined>): string[] {
  if (!(env.BYDP_ENV === 'staging' || env.BYDP_ENV === 'production')) return [];
  const out: string[] = [];
  if (!env.AUTH_URL || !/^https:\/\//.test(env.AUTH_URL)) out.push('AUTH_URL（https）');
  if (!env.REDIS_URL) out.push('REDIS_URL');
  if (env.BYDP_TRUST_PROXY !== '1') out.push('BYDP_TRUST_PROXY=1');
  return out;
}
type AdapterUser = { id: string; email: string; emailVerified: Date | null; name?: string | null };
type VerificationToken = { identifier: string; token: string; expires: Date };

export type AuthDeps = {
  db: () => AuthDb;
  keys: () => AuthKeys;
  botToken: () => string | undefined;
  counter: () => RateCounter;
  /** TG 登录数据一次性消费（防 10 分钟内重放，自检 5） */
  once: () => OnceStore;
  /** magic link 的预期来源（AUTH_URL 的 origin）；null = 本地开发，只允许 localhost（自检阻塞 1：防 Host 头投毒） */
  expectedOrigin: () => string | null;
  send: () => SendEmail;
  emailFrom: () => string | undefined;
  /** 取客户端 IP（仅在可信反代后读转发头；否则返回 'unknown'） */
  clientIp: (req: Request | undefined) => string;
  log?: (e: Record<string, unknown>) => void;
  nowSec?: () => number;
};

export function createAuthHandlers(d: AuthDeps) {
  const log = d.log ?? ((e) => console.warn(JSON.stringify(e)));

  /** 最小 adapter：只实现邮箱 magic link 在 JWT 会话下需要的方法；身份以盲索引存，adapter 不回显邮箱以外的任何身份数据 */
  const adapter = {
    async createVerificationToken(t: VerificationToken) {
      await saveVerificationToken(d.db(), { email: t.identifier, tokenHash: t.token, expires: t.expires }, d.keys());
      return t;
    },
    async useVerificationToken(p: { identifier: string; token: string }): Promise<VerificationToken | null> {
      const r = await consumeVerificationToken(d.db(), { email: p.identifier, tokenHash: p.token }, d.keys());
      return r ? { identifier: p.identifier, token: p.token, expires: r.expires } : null;
    },
    async getUserByEmail(email: string): Promise<AdapterUser | null> {
      const id = await findUserByEmail(d.db(), email, d.keys());
      return id ? { id, email: normalizeEmail(email), emailVerified: null } : null;
    },
    async createUser(u: { email: string }): Promise<AdapterUser> {
      const r = await signInWithIdentity(d.db(), { provider: 'email', account: u.email, handle: maskEmail(u.email) }, d.keys());
      return { id: r.userId, email: normalizeEmail(u.email), emailVerified: new Date() };
    },
    async updateUser(u: { id: string; email?: string | null; emailVerified?: Date | null }): Promise<AdapterUser> {
      // 本系统不存 emailVerified（magic link 成功即视为已验证）；原样返回
      return { id: u.id, email: u.email ?? '', emailVerified: u.emailVerified ?? null };
    },
  };

  /** TG 登录（签核条件 3：只经 POST 回调提交，Auth.js Credentials 回调只接受 POST） */
  async function authorizeTelegram(creds: Record<string, unknown> | undefined) {
    const botToken = d.botToken();
    if (!botToken || !creds) return null;
    const fields = Object.fromEntries(Object.entries(creds).filter(([k, v]) => !AUTH_FORM_FIELDS.has(k) && v != null && v !== ''));
    const v = verifyTelegramLogin(fields, botToken, { nowSec: d.nowSec?.() });
    if (!v.ok) {
      log({ evt: 'telegram_login_rejected', reason: v.reason });
      return null;
    }
    // 同一份签名数据只能换一次会话
    if (!(await d.once().claim(`tg:${String(fields.hash).toLowerCase()}`, TG_REPLAY_TTL_SEC))) {
      log({ evt: 'telegram_login_rejected', reason: 'replayed' });
      return null;
    }
    const r = await signInWithIdentity(d.db(), { provider: 'telegram', account: v.user.id, handle: maskTelegram(v.user.username, v.user.id) }, d.keys());
    return { id: r.userId, epoch: r.sessionEpoch };
  }

  /** magic link 发信（签核条件 4）：超额时静默不发，调用方对外响应一致（Auth.js 统一跳转到「请查收邮件」） */
  async function sendVerificationRequest(p: { identifier: string; url: string; request?: Request }) {
    // 自检阻塞 1：链接来源必须是预期域名（AUTH_URL）；否则可被伪造 Host 头把登录令牌投到攻击者域名
    const origin = new URL(p.url).origin;
    const expected = d.expectedOrigin();
    const localDev = expected === null && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (origin !== expected && !localDev) {
      log({ evt: 'magic_link_origin_rejected' });
      throw new Error('magic link 来源不符');
    }
    const ok = await magicLinkAllowed(d.counter(), { email: p.identifier, ip: d.clientIp(p.request) }, d.keys());
    if (!ok) {
      log({ evt: 'magic_link_rate_limited' });
      return;
    }
    await sendMagicLink({ to: p.identifier, url: p.url, from: d.emailFrom(), send: d.send() });
  }

  /**
   * jwt 回调：签发时写入 uid / epoch / authTime / name；此后每次读取会话都比对 app_user.sessionEpoch 与 30 天绝对上限，
   * 不满足返回 null（会话作废）。数据库抖动时抛错 → Auth.js 清 cookie（失败即拒，可接受）。
   */
  async function jwtCallback(p: { token: Record<string, unknown>; user?: { id?: string; epoch?: number } | null }): Promise<Record<string, unknown> | null> {
    const now = d.nowSec?.() ?? Math.floor(Date.now() / 1000);
    if (p.user?.id) {
      const epoch = p.user.epoch ?? (await userSessionEpoch(d.db(), p.user.id));
      if (epoch == null) return null;
      p.token.uid = p.user.id;
      p.token.epoch = epoch;
      p.token.authTime = now;
    }
    // 数据最小化（自检 10）：会话里不留邮箱 / 头像
    delete p.token.email;
    delete p.token.picture;
    const { uid, epoch, authTime } = p.token;
    if (typeof uid !== 'string' || typeof epoch !== 'number' || typeof authTime !== 'number') return null;
    if (now - authTime > SESSION_ABSOLUTE_MAX_SEC) return null;
    const u = await getSessionUser(d.db(), { userId: uid, epoch });
    if (!u) return null;
    p.token.name = u.displayName;
    return p.token;
  }

  return { adapter, authorizeTelegram, sendVerificationRequest, jwtCallback };
}
