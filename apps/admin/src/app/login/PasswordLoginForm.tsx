'use client';
/**
 * D-034：提交到主站 Auth.js 的 Credentials 回调（同源 /api/auth/callback/admin-password，带 CSRF 令牌）；
 * 用 X-Auth-Return-Redirect 取回跳地址：带 error 即失败（统一提示，不区分邮箱错 / 密码错 / 被锁），否则进入后台。
 */
import { useState } from 'react';

export function PasswordLoginForm() {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const f = new FormData(e.currentTarget);
      const { csrfToken } = (await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()) as { csrfToken: string };
      const body = new URLSearchParams({ csrfToken, email: String(f.get('email') ?? ''), password: String(f.get('password') ?? ''), callbackUrl: '/admin' });
      const res = await fetch('/api/auth/callback/admin-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
        body,
      });
      const { url } = (await res.json().catch(() => ({}))) as { url?: string };
      if (!res.ok || !url || /[?&]error=/.test(url)) {
        setErr('邮箱或密码不正确，或尝试次数过多，请稍后再试');
        return;
      }
      window.location.href = '/admin';
    } catch {
      setErr('登录失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12, marginTop: 16 }}>
      <label>
        邮箱
        <input name="email" type="email" autoComplete="username" required maxLength={254} style={{ width: '100%' }} />
      </label>
      <label>
        密码
        <input name="password" type="password" autoComplete="current-password" required maxLength={256} style={{ width: '100%' }} />
      </label>
      {err ? (
        <p className="hint" role="alert">
          {err}
        </p>
      ) : null}
      <button className="btn" disabled={busy} style={{ justifySelf: 'start' }}>
        {busy ? '登录中…' : '登录'}
      </button>
    </form>
  );
}
