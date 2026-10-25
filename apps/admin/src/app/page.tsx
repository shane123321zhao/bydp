import { call } from '../lib/api';
import { DASHBOARD_TEXT } from '../lib/labels';
import { ErrorView } from '../lib/ui';

/** 看板（全部后台角色只读）：各队列待办计数，点击进入对应队列 */
export default async function Dashboard() {
  const r = await call<Record<string, number>>('/dashboard');
  if (!r.ok) return <ErrorView err={r.err} back="/" />;
  return (
    <>
      <h1>看板</h1>
      <div className="stats">
        {DASHBOARD_TEXT.map(([key, label, href]) => {
          const n = r.data[key] ?? 0;
          return (
            <a key={key} className={`stat${n > 0 ? ' hot' : ''}`} href={href ? `/admin${href}` : undefined}>
              <b className="num">{n}</b>
              <span>{label}</span>
            </a>
          );
        })}
      </div>
      <p className="hint">计数实时读取；入口按角色可见，无权限的队列点击后显示「无权限」。</p>
    </>
  );
}
