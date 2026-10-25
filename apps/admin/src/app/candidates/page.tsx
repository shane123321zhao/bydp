import { call } from '../../lib/api';
import { fmt } from '../../lib/labels';
import { ErrorView } from '../../lib/ui';

type Cand = { id: string; identifierType: string; value: string; queryCount7d: number; weightedPriority: number; firstQueried: string; status: string };
const TYPE_TEXT: Record<string, string> = { domain: '域名', mirror: '镜像', app: 'App', tg: 'Telegram', wallet: '钱包', phone: '电话' };

/** Candidate 视图（D-016 第 6 项）：未收录标识按去刷加权排序（同 IP 网段一天只计 1 次；加权 = 近 7 日 distinct 查询者） */
export default async function Candidates() {
  const r = await call<{ items: Cand[] }>('/candidates');
  if (!r.ok) return <ErrorView err={r.err} back="/candidates" />;
  return (
    <>
      <h1>Candidate <span className="muted">· 未收录标识（按加权排序）</span></h1>
      <div className="panel">
        <table>
          <thead><tr><th>类型</th><th>标识</th><th>加权（7 日查询者）</th><th>7 日查询（人 × 天）</th><th>首次被查</th></tr></thead>
          <tbody>
            {r.data.items.map((c) => (
              <tr key={c.id}>
                <td>{TYPE_TEXT[c.identifierType] ?? c.identifierType}</td>
                <td className="mono">{c.value}</td>
                <td className="num">{c.weightedPriority}</td>
                <td className="num">{c.queryCount7d}</td>
                <td className="num">{fmt(c.firstQueried)}</td>
              </tr>
            ))}
            {r.data.items.length === 0 ? <tr><td colSpan={5} className="muted">暂无待核验的标识</td></tr> : null}
          </tbody>
        </table>
        <p className="hint">加权按 IP 网段去重：同一网段一天只计 1 次（设备 Cookie 可随手清除，不作去重依据）。</p>
      </div>
    </>
  );
}
