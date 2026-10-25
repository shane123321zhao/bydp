import { call } from '../../lib/api';
import { fmt } from '../../lib/labels';
import { ErrorView, one, type SP } from '../../lib/ui';

type Flag = { device: string; accounts: number; userIds: string[]; lastFlaggedAt: string };

/** 风控（admin）：同设备多账号标记——只标不拦，供人工判断 */
export default async function Risk({ searchParams }: { searchParams: SP }) {
  const cursor = one((await searchParams).cursor);
  const r = await call<{ items: Flag[]; next: string | null }>(`/risk/device-flags${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  if (!r.ok) return <ErrorView err={r.err} back="/risk" />;
  return (
    <>
      <h1>风控 <span className="muted">· 同设备多账号</span></h1>
      <p className="hint">品牌状态变更（认证 / 观察 / 黑名单）：<a className="link" href="/admin/brands">品牌状态</a></p>
      <div className="panel">
        <table>
          <thead><tr><th>设备（盲索引前 16 位）</th><th>账号数</th><th>账号</th><th>最近标记</th></tr></thead>
          <tbody>
            {r.data.items.map((f) => (
              <tr key={f.device}>
                <td className="mono">{f.device}</td>
                <td className="num">{f.accounts}</td>
                <td className="mono">{f.userIds.map((u) => <div key={u}><a className="link" href={`/admin/roles?userId=${encodeURIComponent(u)}`}>{u}</a></div>)}</td>
                <td className="num">{fmt(f.lastFlaggedAt)}</td>
              </tr>
            ))}
            {r.data.items.length === 0 ? <tr><td colSpan={4} className="muted">暂无标记</td></tr> : null}
          </tbody>
        </table>
        {r.data.next ? <p><a className="link" href={`/admin/risk?cursor=${encodeURIComponent(r.data.next)}`}>下一页</a></p> : null}
      </div>
    </>
  );
}
