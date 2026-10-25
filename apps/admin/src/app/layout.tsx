import type { Metadata } from 'next';
import { headers } from 'next/headers';
import '../styles/admin.css';
import { call, type Role, type Session } from '../lib/api';
import { ROLE_TEXT } from '../lib/labels';
import { ErrorView } from '../lib/ui';

export const metadata: Metadata = { title: 'BYDP 运营后台', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** 菜单按会话角色显示（真正的权限由各接口校验，契约 /session 说明） */
const NAV: [href: string, label: string, roles: Role[]][] = [
  ['/', '看板', ['arbitrator', 'editor', 'commerce', 'admin']],
  ['/complaints', '仲裁台', ['arbitrator', 'admin']],
  ['/data-requests', '数据请求', ['admin']],
  ['/review', '审核台', ['editor', 'admin']],
  ['/submissions', '提交审核', ['arbitrator', 'editor', 'admin']],
  ['/candidates', 'Candidate', ['editor', 'admin']],
  ['/brands', '品牌状态', ['arbitrator', 'admin']],
  ['/risk', '风控', ['admin']],
  ['/roles', '角色', ['admin']],
];

export default async function Layout({ children }: { children: React.ReactNode }) {
  // D-034：登录页（/admin/login）不需要会话即可渲染；其余页面照旧先校验会话
  if ((await headers()).get('x-bydp-admin-path') === '/login')
    return (
      <html lang="zh-CN" data-bg="night" data-accent="green">
        <body>
          <main className="main">{children}</main>
        </body>
      </html>
    );
  const s = await call<Session>('/session');
  return (
    <html lang="zh-CN" data-bg="night" data-accent="green">
      <body>
        {s.ok ? (
          <div className="shell">
            <nav className="side" aria-label="后台导航">
              <div className="mark">
                <i />
                <b>BYDP</b>
                <span>运营后台</span>
              </div>
              {NAV.filter(([, , roles]) => roles.some((r) => s.data.roles.includes(r))).map(([href, label]) => (
                <a key={href} href={`/admin${href === '/' ? '' : href}`}>
                  {label}
                </a>
              ))}
              <div className="who">
                <div className="mono">{s.data.userId}</div>
                <div>{s.data.roles.map((r) => ROLE_TEXT[r] ?? r).join(' · ')}</div>
              </div>
            </nav>
            <main className="main">{children}</main>
          </div>
        ) : (
          <main className="main">
            <ErrorView err={s.err} back="/" />
          </main>
        )}
      </body>
    </html>
  );
}
