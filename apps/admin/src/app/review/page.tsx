import { call } from '../../lib/api';
import { reviewDecisionAction } from '../../lib/actions';
import { REVIEW_KIND_TEXT, fmt } from '../../lib/labels';
import { Back, ErrorView, Flash, one, type SP } from '../../lib/ui';

type Item = { id: string; kind: string; subject: string; proposal: unknown; status: string; createdAt: string };

/** 审核台骨架（editor / admin）：Agent 输出只进本队列；通过后的落地动作随 M3 第 4 项 Agent 卡定义（当前只记录决定） */
export default async function Review({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const kind = Object.keys(REVIEW_KIND_TEXT).find((k) => k === one(sp.kind)) ?? '';
  const cursor = one(sp.cursor);
  const back = `/review${kind ? `?kind=${kind}` : ''}`;
  const qs = new URLSearchParams({ ...(kind && { kind }), ...(cursor && { cursor }) });
  const r = await call<{ items: Item[]; next: string | null }>(`/review-queue${qs.size ? `?${qs}` : ''}`);
  if (!r.ok) return <ErrorView err={r.err} back={back} />;
  return (
    <>
      <h1>审核台 <span className="muted">· Agent 待人工确认</span></h1>
      <nav className="filters" aria-label="筛选">
        <a href="/admin/review" className={!kind ? 'on' : ''}>全部</a>
        {Object.entries(REVIEW_KIND_TEXT).map(([k, v]) => (
          <a key={k} href={`/admin/review?kind=${k}`} className={kind === k ? 'on' : ''}>{v}</a>
        ))}
      </nav>
      <Flash back={back} />
      <div className="panel">
        <table>
          <thead><tr><th>类型</th><th>对象</th><th>提议</th><th>提交</th><th>决定</th></tr></thead>
          <tbody>
            {r.data.items.map((it) => (
              <tr key={it.id}>
                <td>{REVIEW_KIND_TEXT[it.kind] ?? it.kind}</td>
                <td className="mono">{it.subject}</td>
                <td><pre className="pre mono">{JSON.stringify(it.proposal, null, 1)}</pre></td>
                <td className="num">{fmt(it.createdAt)}</td>
                <td>
                  <form action={reviewDecisionAction} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
                    <Back to={back} />
                    <input type="hidden" name="id" value={it.id} />
                    <input name="note" maxLength={500} placeholder="备注（可选）" />
                    <span style={{ display: 'flex', gap: 'var(--s-3)' }}>
                      <button className="btn" name="decision" value="approve">通过</button>
                      <button className="btn danger" name="decision" value="reject">驳回</button>
                    </span>
                  </form>
                </td>
              </tr>
            ))}
            {r.data.items.length === 0 ? <tr><td colSpan={5} className="muted">队列为空（Agent 来源随 M3 第 4 项接入）</td></tr> : null}
          </tbody>
        </table>
        {r.data.next ? <p><a className="link" href={`/admin/review?${new URLSearchParams({ ...(kind && { kind }), cursor: r.data.next })}`}>下一页</a></p> : null}
      </div>
    </>
  );
}
