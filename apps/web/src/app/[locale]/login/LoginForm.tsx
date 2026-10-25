'use client';
/**
 * 登录表单（design-system §15 · 原型 login）：Telegram 一键登录（官方组件回调模式：Telegram.Login.auth → signIn POST，
 * 不走 redirect，A-009 条件 3）+ 邮箱 magic link（form / sent / 三种错误态，行内红字不弹窗）。
 */
import { signIn } from 'next-auth/react';
import { useLocale } from 'next-intl';
import { href } from '../../../lib/seo';
import { useActionState, useEffect, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { requestMagicLink, type MagicLinkState } from './actions';

declare global {
  interface Window {
    Telegram?: { Login: { auth: (o: { bot_id: string; request_access?: boolean }, cb: (user: Record<string, string | number> | false) => void) => void } };
  }
}

// send：设计稿未含（发信服务故障兜底），文案待协调官审定
const ERR = { format: '邮箱格式不对，请检查后重试', rate: '发送太频繁，请 10 分钟后再试', region: '依据服务条款，不向中国大陆居民提供服务', send: '发送失败，请稍后再试' } as const;
const TG_SCRIPT = 'https://telegram.org/js/telegram-widget.js?22';

export function LoginForm({ botId, sender, callbackUrl, linkError }: { botId: string | null; sender: string | null; callbackUrl: string; linkError: string | null }) {
  const locale = useLocale();
  const [state, action, pending] = useActionState<MagicLinkState, FormData>(requestMagicLink, { step: 'form' });
  const [view, setView] = useState<'form' | 'sent'>('form');
  const [left, setLeft] = useState(0);
  const [tgBusy, setTgBusy] = useState(false);
  const [lastEmail, setLastEmail] = useState('');

  useEffect(() => {
    if (state.step === 'sent') {
      setView('sent');
      setLeft(60);
    }
  }, [state]);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  function telegramLogin() {
    if (!botId) return;
    const run = () =>
      window.Telegram?.Login.auth({ bot_id: botId, request_access: false }, (user) => {
        if (!user) return setTgBusy(false);
        void signIn('telegram', { ...Object.fromEntries(Object.entries(user).map(([k, v]) => [k, String(v)])), redirectTo: callbackUrl });
      });
    setTgBusy(true);
    if (window.Telegram?.Login) return run();
    const s = document.createElement('script');
    s.src = TG_SCRIPT;
    s.async = true;
    s.onload = run;
    s.onerror = () => setTgBusy(false);
    document.head.appendChild(s);
  }

  if (view === 'sent' && state.step === 'sent')
    return (
      <>
        <section className="card glass first rise login-sent">
          <span className="ic">
            <Icon n="mail" s={30} w={1.8} />
          </span>
          <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-.01em' }}>请查收邮件</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--body)' }}>
            登录链接已发送到
            <br />
            <b className="num" style={{ color: 'var(--ink)' }}>
              {state.masked}
            </b>
            <br />
            15 分钟内有效，只能使用一次
          </div>
          {sender ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
              没收到？看看垃圾邮件；发件人是 <span className="num">{sender}</span>
            </div>
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-4)', width: '100%', marginTop: 'var(--s-3)' }}>
            <form action={action} style={{ display: 'contents' }}>
              <input type="hidden" name="email" value={lastEmail} />
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <button className="ghost" style={{ height: 42 }} disabled={left > 0 || pending}>
                <span className="num">{left > 0 ? `重新发送 (${left}s)` : '重新发送'}</span>
              </button>
            </form>
            <button className="ghost" style={{ height: 42 }} onClick={() => setView('form')}>
              换个邮箱
            </button>
          </div>
        </section>
        <div className="note-row rise">
          <Icon n="info" s={14} />
          <span>打开邮件里的按钮即完成登录，无需密码。链接只在本设备的浏览器生效。</span>
        </div>
      </>
    );

  const err = state.step === 'form' ? state.error : undefined;
  return (
    <section className="card glass rise login-card">
      <button className="btn" style={{ height: 50, fontSize: 15, gap: 'var(--s-5)' }} onClick={telegramLogin} disabled={!botId || tgBusy} aria-busy={tgBusy}>
        <Icon n="send" s={18} w={2.4} /> 用 Telegram 登录
      </button>
      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 'calc(-1 * var(--s-2))' }}>推荐 · 通过 Telegram 官方组件，我们不会拿到你的手机号</div>
      <div className="divider">或用邮箱</div>
      <form action={action} onSubmit={(e) => setLastEmail(String(new FormData(e.currentTarget).get('email') ?? ''))} style={{ display: 'contents' }}>
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <div className={`fld${err || linkError ? ' err' : ''}`}>
          <label htmlFor="login-email">邮箱地址</label>
          <input id="login-email" className="f num" name="email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" defaultValue={state.step === 'form' ? state.email : ''} required />
        </div>
        {err || linkError ? (
          <div className="err-line" role="alert">
            <Icon n="alert" s={13} /> {err ? ERR[err] : linkError}
          </div>
        ) : null}
        <button className="ghost" style={{ height: 46, fontWeight: 600 }} disabled={pending}>
          <Icon n="mail" s={16} /> {pending ? '发送中…' : '发送登录链接'}
        </button>
      </form>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6, textAlign: 'center' }}>
        继续即表示你已年满 18 岁并同意
        <a href={href(locale, '/terms')} style={{ color: 'inherit', textDecoration: 'underline' }}>
          服务条款
        </a>
        与
        <a href={href(locale, '/privacy-policy')} style={{ color: 'inherit', textDecoration: 'underline' }}>
          隐私政策
        </a>
        ；不向中国大陆居民提供服务。
      </div>
    </section>
  );
}
