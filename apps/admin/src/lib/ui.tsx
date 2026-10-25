/** 后台通用片段：操作结果提示 · 读取失败分流（未登录 / 需重新登录 / 无权限）· 状态徽章 */
import { cookies } from 'next/headers';
import type { ApiErr } from './api';
import { FLASH_COOKIE, type Flash as FlashData } from './flash';

export type SP = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** 登录走 web 的登录页（同域）；reauth=1 时已登录也重新验证身份 */
export const loginHref = (back: string, reauth = false) => `/login?${reauth ? 'reauth=1&' : ''}callbackUrl=${encodeURIComponent('/admin' + back)}`;

/** 操作结果提示：只读服务端写入的短时 cookie（见 actions.ts），且须与当前页路径一致 */
export async function Flash({ back }: { back: string }) {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  let f: FlashData | null = null;
  try {
    f = raw ? (JSON.parse(raw) as FlashData) : null;
  } catch {
    f = null;
  }
  if (!f || f.path !== back) return null;
  if (f.tone === 'ok') return <p className="flash ok" role="status">{f.text}</p>;
  return (
    <p className="flash bad" role="alert">
      {f.text}
      {f.code === 'reauth_required' || f.code === 'unauthorized' ? (
        <>
          {' '}
          <a className="link" href={loginHref(back, true)}>重新登录</a>
        </>
      ) : null}
    </p>
  );
}

export function ErrorView({ err, back }: { err: ApiErr; back: string }) {
  if (err.code === 'unauthorized' || err.code === 'reauth_required') {
    return (
      <div className="panel">
        <h2>{err.code === 'unauthorized' ? '请先登录' : '需要重新登录'}</h2>
        <p className="muted">{err.message}</p>
        <a className="btn" href={loginHref(back, err.code === 'reauth_required')}>前往登录</a>
      </div>
    );
  }
  return (
    <div className="panel">
      <h2>{err.code === 'forbidden' ? '无权限' : '读取失败'}</h2>
      <p className="muted">{err.message}</p>
    </div>
  );
}

export function Tag({ tone, children }: { tone?: 'red' | 'amber' | 'green' | 'blue' | 'muted'; children: React.ReactNode }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>;
}

/** 表单里随附回跳路径（server action 结果回到当前页） */
export const Back = ({ to }: { to: string }) => <input type="hidden" name="back" value={to} />;
