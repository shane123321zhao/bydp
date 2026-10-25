/**
 * Auth.js v5（next-auth 5.0.0-beta.32，锁定精确版本，升级须单独提审）装配（A-009）。逻辑全在 @bydp/core/identity/authjs。
 * - 会话：JWT，7 天滑动（Auth.js 每次读会话重签），另有 30 天绝对上限；每次读会话比对 app_user.sessionEpoch（作废即失效）。
 * - 部署环境缺 AUTH_URL / REDIS_URL / BYDP_TRUST_PROXY=1 即拒绝启动（lib/rate-counter.ts assertAuthDeployment）。
 * - TG：Credentials `telegram`，由 Login Widget 的 data-onauth 回调经 signIn() POST 提交（签核条件 3，不用 redirect 模式）；
 *   同一份签名数据只能用一次（Redis SET NX）。
 * - 邮箱：Resend magic link，15 分钟一次性；限流超额静默不发（签核条件 4）。
 * 密钥（AUTH_SECRET / IDENTITY_HMAC_KEY / AUTH_PII_KEY / TELEGRAM_BOT_TOKEN / RESEND_API_KEY）只从环境变量读取，懒加载。
 */
import 'server-only';
import { createAuthHandlers, SESSION_MAX_AGE_SEC, SESSION_UPDATE_AGE_SEC, TELEGRAM_FIELDS } from '@bydp/core/identity/authjs';
import { MAGIC_LINK_MAX_AGE_SEC, resendSender } from '@bydp/core/identity/magic-link-email';
import { identityKeysFromEnv, normalizeEmail } from '@bydp/core/identity/pii';
import { DEVICE_COOKIE, DEVICE_ID, deviceFingerprint, recordDeviceLogin } from '@bydp/core/identity/device';
import { cookies } from 'next/headers';
import { findUserByEmail, IdentityBlockedError, probeIdentityBlocked, userSessionEpoch } from '@bydp/core/identity/auth';
import { auditPasswordLogin, authorizePasswordLogin, passwordLoginConfigFromEnv } from '@bydp/core/identity/password-login';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Resend from 'next-auth/providers/resend';
import { db } from './lib/db';
import { assertAuthDeployment, clientIp, expectedOrigin, onceStore, rateCounter } from './lib/rate-counter';

// 服务启动（首次加载本模块）即检查部署必需配置；构建期收集页面数据时跳过（运行期变量此时尚未注入）
if (process.env.NEXT_PHASE !== 'phase-production-build') assertAuthDeployment();

let keys: ReturnType<typeof identityKeysFromEnv> | undefined;
class IdentityBlockedSignin extends CredentialsSignin {
  code = 'identity_blocked';
}

const h = createAuthHandlers({
  db,
  keys: () => (keys ??= identityKeysFromEnv()),
  botToken: () => process.env.TELEGRAM_BOT_TOKEN,
  counter: rateCounter,
  once: onceStore,
  expectedOrigin,
  send: () => resendSender(),
  emailFrom: () => process.env.EMAIL_FROM,
  clientIp,
});

/**
 * D-020 #3（HANDOVER §9 #22）：同一镜像另起 auth-admin 实例服务后台独立子域（BYDP_AUTH_SCOPE=admin，AUTH_URL=后台域名）。
 * 后台 cookie 用 __Host- 前缀——浏览器强制仅本主机、无 Domain（不会落到父域）、Path=/、Secure；名字与主站不同，api 以此为 salt 区分两类会话。
 */
export const ADMIN_SCOPE = process.env.BYDP_AUTH_SCOPE === 'admin';
const hostOnly = (name: string, httpOnly = true) => ({ name: `__Host-bydp-admin.${name}`, options: { httpOnly, sameSite: 'lax' as const, path: '/', secure: true } });
const ADMIN_COOKIES = { sessionToken: hostOnly('session-token'), csrfToken: hostOnly('csrf-token'), callbackUrl: hostOnly('callback-url') };

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  ...(ADMIN_SCOPE ? { cookies: ADMIN_COOKIES } : {}),
  // D-010：登录 / 已发送 / 出错都回到自建登录页（next-intl 默认语言无前缀）
  pages: { signIn: '/login', verifyRequest: '/login', error: '/login' },
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SEC, updateAge: SESSION_UPDATE_AGE_SEC },
  // 结构化对齐 @auth/core 0.41 Adapter（邮箱 magic link 在 JWT 会话下所需方法），类型断言避免引入仅类型入口
  adapter: h.adapter as never,
  providers: [
    Credentials({
      id: 'telegram',
      name: 'Telegram',
      credentials: Object.fromEntries(TELEGRAM_FIELDS.map((k) => [k, {}])),
      authorize: async (c) => {
        try {
          return (await h.authorizeTelegram(c as Record<string, unknown>)) as never;
        } catch (e) {
          // §16：被自我排除拦截的身份 → 登录页显示专门提示（code 只是类型，不含任何身份信息）
          if (e instanceof IdentityBlockedError) throw new IdentityBlockedSignin();
          throw e;
        }
      },
    }),
    // D-034：后台账号密码登录（测试站开关，缺省关闭；只认 .env.prod 白名单的单个邮箱；正式环境不启用）。入口页在 apps/admin /admin/login
    Credentials({
      id: 'admin-password',
      name: '后台密码登录',
      credentials: { email: {}, password: {} },
      authorize: async (c, req) =>
        (await authorizePasswordLogin(
          {
            config: passwordLoginConfigFromEnv(),
            counter: rateCounter(),
            findUserId: (email) => findUserByEmail(db(), email, (keys ??= identityKeysFromEnv())),
            epochOf: (userId) => userSessionEpoch(db(), userId),
            audit: (e) => auditPasswordLogin(db(), e),
          },
          { email: c?.email, password: c?.password, ip: clientIp(req) },
        )) as never,
    }),
    Resend({
      maxAge: MAGIC_LINK_MAX_AGE_SEC,
      normalizeIdentifier: normalizeEmail,
      sendVerificationRequest: (p) => h.sendVerificationRequest(p),
    }),
  ],
  events: {
    // D-015 #2：登录成功记设备（只存 bydp_did 的盲索引），同设备多账号写 audit_log 标记；失败只记日志，不影响登录
    signIn: async ({ user }) => {
      try {
        const did = (await cookies()).get(DEVICE_COOKIE)?.value;
        if (user?.id && did && DEVICE_ID.test(did)) {
          await recordDeviceLogin(db(), { userId: user.id, fingerprint: deviceFingerprint(did, identityKeysFromEnv().hmacKey) });
        }
      } catch (e) {
        console.error(JSON.stringify({ evt: 'device_record_failed', error: (e as Error).message.slice(0, 120) }));
      }
    },
  },
  callbacks: {
    // 邮箱首登：Auth.js 在 createUser 之前调本回调；被自我排除拦截的身份直接回登录页并提示（老用户不受影响）
    // 只在用户点开登录链接之后（已证明控制该邮箱）探测；发信请求阶段一律放行，避免成为「某邮箱是否在排除期」的免登录查询口（自检 B1）
    signIn: async ({ user, account, email }) => {
      if (email?.verificationRequest) return true;
      if (account?.provider !== 'resend' || !user.email || user.id?.startsWith('u_')) return true;
      return (await probeIdentityBlocked(db(), { provider: 'email', account: user.email }, identityKeysFromEnv())) ? '/login?error=IdentityBlocked' : true;
    },
    jwt: ({ token, user }) => h.jwtCallback({ token, user: user as { id?: string; epoch?: number } | undefined }) as never,
    // authTime（签发时刻，秒）：敏感操作（申请注销）要求近期重新验证身份
    session: ({ session, token }) => ({
      ...session,
      authTime: typeof token.authTime === 'number' ? token.authTime : undefined,
      user: { ...session.user, id: token.uid as string, name: (token.name as string) ?? null },
    }),
  },
});
