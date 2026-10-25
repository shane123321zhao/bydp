import { call } from '../../lib/api';
import { BINDING_TEXT, BRAND_STATUS_TEXT, CATEGORY_TEXT, FLAG_TEXT, STATUS_TEXT, fmt } from '../../lib/labels';
import { ErrorView, one, Tag, type SP } from '../../lib/ui';

type Row = {
  id: string;
  brand: { id: string; slug: string; name: string; status: string };
  status: string;
  category: string;
  amountUsdt: number;
  createdAt: string;
  replyDeadline: string | null;
  notices: number;
  flags: string[];
  publicSummary: boolean;
  bindingLevel: string;
};

const STATUSES = ['screening', 'accepted', 'awaiting_reply', 'arbitrating', 'resolved', 'unresolved', 'rejected', 'exposed'];

/** 仲裁台队列（arbitrator / admin）：按状态或服务端计算的 flag 筛选 */
export default async function Complaints({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = one(sp.status);
  const flag = one(sp.flag);
  const cursor = one(sp.cursor);
  const qs = new URLSearchParams({ ...(status && { status }), ...(flag && { flag }), ...(cursor && { cursor }) });
  const r = await call<{ items: Row[]; next: string | null }>(`/complaints${qs.size ? `?${qs}` : ''}`);
  if (!r.ok) return <ErrorView err={r.err} back="/complaints" />;
  const href = (p: Record<string, string>) => `/admin/complaints${Object.keys(p).length ? `?${new URLSearchParams(p)}` : ''}`;
  return (
    <>
      <h1>仲裁台</h1>
      <nav className="filters" aria-label="筛选">
        <a href={href({})} className={!status && !flag ? 'on' : ''}>全部</a>
        {Object.entries(FLAG_TEXT).map(([k, v]) => (
          <a key={k} href={href({ flag: k })} className={flag === k ? 'on' : ''}>{v}</a>
        ))}
        {STATUSES.map((k) => (
          <a key={k} href={href({ status: k })} className={status === k ? 'on' : ''}>{STATUS_TEXT[k]}</a>
        ))}
      </nav>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>案件</th>
              <th>品牌</th>
              <th>类别</th>
              <th>金额 USDT</th>
              <th>状态</th>
              <th>通知</th>
              <th>答辩截止</th>
              <th>绑定</th>
              <th>提交</th>
            </tr>
          </thead>
          <tbody>
            {r.data.items.map((c) => (
              <tr key={c.id}>
                <td><a className="link mono" href={`/admin/complaints/${c.id}`}>{c.id}</a></td>
                <td>
                  {c.brand.name} {c.brand.status === 'blacklist' ? <Tag tone="red">{BRAND_STATUS_TEXT.blacklist}</Tag> : null}
                </td>
                <td>{CATEGORY_TEXT[c.category] ?? c.category}</td>
                <td className="num">{c.amountUsdt.toLocaleString('en-US')}</td>
                <td>
                  <Tag>{STATUS_TEXT[c.status] ?? c.status}</Tag>
                  {c.flags.map((f) => <Tag key={f} tone="amber">{FLAG_TEXT[f] ?? f}</Tag>)}
                  {c.publicSummary ? <Tag tone="green">已公开</Tag> : null}
                </td>
                <td className="num">{c.notices}</td>
                <td className="num">{fmt(c.replyDeadline)}</td>
                <td>{BINDING_TEXT[c.bindingLevel] ?? c.bindingLevel}</td>
                <td className="num">{fmt(c.createdAt)}</td>
              </tr>
            ))}
            {r.data.items.length === 0 ? (
              <tr><td colSpan={9} className="muted">没有符合条件的案件</td></tr>
            ) : null}
          </tbody>
        </table>
        {r.data.next ? (
          <p><a className="link" href={href({ ...(status && { status }), ...(flag && { flag }), cursor: r.data.next })}>下一页</a></p>
        ) : null}
      </div>
    </>
  );
}
