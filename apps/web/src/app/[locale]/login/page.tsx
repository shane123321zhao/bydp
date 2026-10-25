/**
 * 登录页（D-010 · design-system §15 · 原型 login）。已登录直接跳回；Auth.js 的错误 / 失效链接回到本页并行内提示。
 */
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ADMIN_SCOPE, auth } from '../../../auth';
import { Icon } from '../../../components/Icon';
import { Legal } from '../../../components/atoms';
import { safeCallback } from '../../../lib/safe-callback';
import { href } from '../../../lib/seo';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '登录', robots: { index: false, follow: false } };

/** Auth.js 回到本页时带的 error：只映射需要用户处理的一类，其余统一口径 */
const LINK_ERROR: Record<string, string> = {
  Verification: '登录链接已失效或已使用，请重新发送',
  CredentialsSignin: 'Telegram 登录未通过验证，请重试',
  IdentityBlocked: '该登录身份处于自我排除期内，暂不能注册或登录。',
};
const IDENTITY_BLOCKED = '该登录身份处于自我排除期内，暂不能注册或登录。';

export default async function LoginPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  // 后台子域（auth-admin 实例）：默认回到后台，文案改为后台登录
  const callbackUrl = ADMIN_SCOPE ? (sp.callbackUrl?.startsWith('/admin') ? safeCallback(sp.callbackUrl) : '/admin') : safeCallback(sp.callbackUrl);
  // reauth=1：敏感操作要求重新验证身份（隐私页注销 / 后台高风险操作），已登录也停留在登录页
  if ((await auth())?.user && sp.reauth !== '1') redirect(callbackUrl);
  const botId = process.env.TELEGRAM_BOT_TOKEN?.split(':')[0] ?? null; // bot id 为公开信息（token 冒号前段），token 本体不下发
  const sender = process.env.EMAIL_FROM?.match(/<([^>]+)>/)?.[1] ?? process.env.EMAIL_FROM ?? null;
  // §16：TG 首登被拦截时 Auth.js 回跳 ?error=CredentialsSignin&code=identity_blocked；邮箱首登回跳 ?error=IdentityBlocked
  const linkError = sp.code === 'identity_blocked' ? IDENTITY_BLOCKED : sp.error ? (LINK_ERROR[sp.error] ?? '登录未完成，请重试') : null;
  return (
    <>
      <header className="hdr">
        <a className="back" href={ADMIN_SCOPE ? '/admin' : '/'} aria-label="返回">
          <Icon n="back" />
        </a>
        <div style={{ flexGrow: 1, fontSize: 16, fontWeight: 700 }}>登录</div>
      </header>
      <section className="login-hero rise">
        <div className="brandmark">
          <i />
          <b className="num">BYDP</b>
          <span>博弈点评 · 存前一查</span>
        </div>
        {ADMIN_SCOPE ? (
          <>
            <h1>运营后台登录</h1>
            <p>仅限已授权的后台账号。不设密码，用邮箱收登录链接{botId ? '或 Telegram 登录' : ''}。</p>
          </>
        ) : (
          <>
            <h1>
              登录后解锁
              <br />
              <span style={{ color: 'var(--accent)' }}>领码 · 投诉 · 赔付资格</span>
            </h1>
            <p>不设密码。用 Telegram 一键登录，或用邮箱收登录链接。</p>
          </>
        )}
      </section>
      <LoginForm botId={botId && /^\d+$/.test(botId) ? botId : null} sender={sender} callbackUrl={callbackUrl} linkError={linkError} />
      <Legal
        links={[
          ['服务条款', href(locale, '/terms')],
          ['隐私政策', href(locale, '/privacy-policy')],
        ]}
      />
    </>
  );
}
