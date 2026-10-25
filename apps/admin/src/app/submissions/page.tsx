import { call, type Session } from '../../lib/api';
import { submissionDecisionAction } from '../../lib/actions';
import { fmt } from '../../lib/labels';
import { Back, ErrorView, Flash, one, Tag, type SP } from '../../lib/ui';

type Ev = { id: string; mime: string; bytes: number; sha256: string; available: boolean };
type W = {
  type: 'withdrawal'; id: string; brandName: string; userId: string | null; amountUsdt: number; method: string; requestedAt: string; receivedAt: string | null;
  outcome: 'paid' | 'refused' | 'pending'; status: string; bindingLevel: string | null; evidence: Ev[]; decidedAt: string | null; decidedBy: string | null;
  rejectReason: string | null; outcomeAmendedAt: string | null; amendedAfterDecision: boolean; createdAt: string;
};
type R = { type: 'review'; id: string; brandName: string; userId: string; rating: number; text: string | null; trustWeight: number; verifiedBinding: boolean; status: string; decidedAt: string | null; decidedBy: string | null; rejectReason: string | null; createdAt: string };

const OUTCOME: Record<W['outcome'], string> = { paid: '已到账', refused: '被拒付', pending: '未到账' };
const LEVEL: Record<string, string> = { self_reported: '自报级', postback_confirmed: '回传确认', operator_confirmed: '运营商确认' };
const STATUS = [['pending', '待审'], ['accepted', '已采纳 / 已发布'], ['rejected', '已驳回']] as const;

/**
 * D-024 提交审核：出款凭证（arbitrator / admin）· 评价（editor / admin）。凭证无可用截图不能采纳（按钮置灰，core 同口径）；驳回须原因并通知提交人。
 * 判定后补录（W2#002 小改 3）：凭证判定后本人把出款结果由「未到账」补录的，标「判定后补录」，可单独筛选复看；补录时已写 audit 并提醒仲裁组。
 * 评价文字不公开（裁定 ④），仅在此处审核可见。
 */
export default async function Submissions({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const type = one(sp.type) === 'review' ? 'review' : 'withdrawal';
  const status = (STATUS.find(([k]) => k === one(sp.status))?.[0] ?? 'pending') as (typeof STATUS)[number][0];
  const amended = type === 'withdrawal' && one(sp.amended) === '1';
  const qs = new URLSearchParams({ type, status, ...(amended ? { amended: '1' } : {}) });
  const back = `/submissions?${qs}`;
  const r = await call<{ items: (W | R)[] }>(`/submissions?${qs}`);
  if (!r.ok) return <ErrorView err={r.err} back={back} />;
  const me = await call<Session>('/session');
  const myId = me.ok ? me.data.userId : null; // 回避：本人提交不可审（core 同口径拒绝；审核 W2 第 005 号收尾 3）
  const link = (p: Record<string, string>) => `/admin/submissions?${new URLSearchParams({ type, status, ...p })}`;
  return (
    <>
      <h1>提交审核 <span className="muted">· 出款凭证 / 评价</span></h1>
      <nav className="filters" aria-label="类型">
        <a href={`/admin/submissions?type=withdrawal&status=${status}`} className={type === 'withdrawal' ? 'on' : ''}>出款凭证</a>
        <a href={`/admin/submissions?type=review&status=${status}`} className={type === 'review' ? 'on' : ''}>评价</a>
      </nav>
      <nav className="filters" aria-label="状态">
        {STATUS.map(([k, v]) => (
          <a key={k} href={link({ status: k })} className={status === k && !amended ? 'on' : ''}>{v}</a>
        ))}
        {type === 'withdrawal' ? <a href={link({ status: status === 'pending' ? 'accepted' : status, amended: '1' })} className={amended ? 'on' : ''}>判定后补录</a> : null}
      </nav>
      <Flash back={back} />
      {r.data.items.length === 0 ? <div className="panel muted">没有符合条件的提交</div> : null}
      {r.data.items.map((it) =>
        it.type === 'withdrawal' ? (
          <section key={it.id} className="panel">
            <h2>
              {it.brandName} <span className="mono muted">{it.id}</span>{' '}
              <Tag tone={it.status === 'pending' ? 'amber' : it.status === 'accepted' ? 'green' : 'muted'}>{it.status === 'pending' ? '待审' : it.status === 'accepted' ? '已采纳' : '已驳回'}</Tag>
              {it.amendedAfterDecision ? <> <Tag tone="red">判定后补录</Tag></> : null}
            </h2>
            <dl className="kv">
              <dt>提交人 / 绑定</dt>
              <dd className="mono">{it.userId ?? '—'} · {it.bindingLevel ? LEVEL[it.bindingLevel] ?? it.bindingLevel : '—'}</dd>
              <dt>金额 / 方式</dt>
              <dd className="num">{it.amountUsdt.toLocaleString('en-US')} USDT · {it.method}</dd>
              <dt>申请 / 到账</dt>
              <dd className="num">{fmt(it.requestedAt)} / {fmt(it.receivedAt)} · {OUTCOME[it.outcome]}</dd>
              {it.outcomeAmendedAt ? (<><dt>结果补录</dt><dd className="num">{fmt(it.outcomeAmendedAt)}{it.amendedAfterDecision ? '（判定后）' : ''}</dd></>) : null}
              {it.decidedAt ? (<><dt>判定</dt><dd className="num">{fmt(it.decidedAt)} · {it.decidedBy}{it.rejectReason ? ` · 原因：${it.rejectReason}` : ''}</dd></>) : null}
            </dl>
            <div className="ev">
              {it.evidence.length === 0 ? <p className="muted">无截图（不能采纳）</p> : null}
              {it.evidence.map((e) => {
                const pv = `/admin/submission-evidence/${encodeURIComponent(e.id)}/preview?page=1`;
                return (
                  <figure key={e.id}>
                    {e.available ? (
                      <a href={pv} target="_blank" rel="noreferrer">
                        <img src={pv} alt={`凭证截图 ${e.id}`} loading="lazy" />
                      </a>
                    ) : (
                      <p className="pre muted">原文已删除（哈希保留）</p>
                    )}
                    <figcaption className="mono muted">{e.mime} · {Math.round(e.bytes / 1024)} KB · {e.sha256.slice(0, 12)}…</figcaption>
                  </figure>
                );
              })}
            </div>
            {it.status === 'pending' ? <Decide type="withdrawal" id={it.id} back={back} canAccept={it.evidence.some((e) => e.available)} self={it.userId === myId} /> : null}
          </section>
        ) : (
          <section key={it.id} className="panel">
            <h2>
              {it.brandName} <span className="mono muted">{it.id}</span>{' '}
              <Tag tone={it.status === 'pending' ? 'amber' : it.status === 'published' ? 'green' : 'muted'}>{it.status === 'pending' ? '待审' : it.status === 'published' ? '已发布' : '已驳回'}</Tag>
            </h2>
            <dl className="kv">
              <dt>提交人</dt>
              <dd className="mono">{it.userId}</dd>
              <dt>评分 / 权重</dt>
              <dd className="num">{it.rating} 星 · 可信权重 {it.trustWeight.toFixed(2)}{it.verifiedBinding ? '（已核验绑定）' : '（自报级绑定）'}</dd>
              <dt>文字（不公开）</dt>
              <dd className="pre">{it.text ?? '（无）'}</dd>
              {it.decidedAt ? (<><dt>判定</dt><dd className="num">{fmt(it.decidedAt)} · {it.decidedBy}{it.rejectReason ? ` · 原因：${it.rejectReason}` : ''}</dd></>) : null}
            </dl>
            {it.status === 'pending' ? <Decide type="review" id={it.id} back={back} canAccept self={it.userId === myId} /> : null}
          </section>
        ),
      )}
    </>
  );
}

function Decide({ type, id, back, canAccept, self }: { type: 'withdrawal' | 'review'; id: string; back: string; canAccept: boolean; self: boolean }) {
  if (self) return <p className="hint">本人提交，不能自己审核（回避）</p>;
  return (
    <>
      <form className="act" action={submissionDecisionAction}>
        <Back to={back} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="accept" />
        <button className="btn" disabled={!canAccept}>{type === 'review' ? '发布' : '采纳'}</button>
        {!canAccept ? <p className="hint">没有可用截图的凭证不能采纳</p> : null}
      </form>
      <form className="act" action={submissionDecisionAction}>
        <Back to={back} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="reject" />
        <label className="grow">驳回原因（通知提交人）<input name="reason" required maxLength={500} /></label>
        <button className="btn danger">驳回</button>
      </form>
    </>
  );
}
