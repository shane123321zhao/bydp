import { call } from '../../lib/api';
import { contactConfirmAction, redactAction, resolveDataRequestAction } from '../../lib/actions';
import { DATA_REQUEST_TEXT, DR_STATUS_TEXT, fmt } from '../../lib/labels';
import { Back, ErrorView, Flash, one, Tag, type SP } from '../../lib/ui';

type Target = { evidenceId: string; complaintId: string; complaintClosed: boolean; redacted: boolean; originalAvailable: boolean };
type DR = {
  id: string;
  userId: string;
  kind: 'redact_evidence' | 'delete_evidence' | 'export' | 'anonymize';
  status: 'pending' | 'done' | 'rejected';
  targets: Target[];
  note: string | null;
  contactConfirmedAt: string | null;
  contactChannel: 'telegram' | 'email' | null;
  createdAt: string;
  resolvedAt: string | null;
};

/** done 是否可点：与 core resolveDataRequest 的前置条件同口径（最终仍以 api 判定为准） */
function doneBlocker(d: DR): string | null {
  if (d.kind === 'redact_evidence' && d.targets.some((t) => !t.redacted && t.originalAvailable)) return '仍有证据未上传脱敏件';
  if (d.kind === 'delete_evidence' && d.targets.some((t) => !t.complaintClosed && t.originalAvailable)) return '含未结案案件的证据：未结案只能脱敏、不能删原文（§9.2 v1.9），请驳回并引导改走脱敏';
  // 未结案投诉等前提由 api 判定（409 open_complaints 等），结果在页面提示
  if (d.kind === 'anonymize' && !d.contactChannel) return '须先经登记联系方式向本人确认';
  return null;
}

const DONE_TEXT: Record<DR['kind'], string> = {
  redact_evidence: '完成（脱敏件已全部替换）',
  delete_evidence: '完成（删除原文，哈希与状态日志保留）',
  export: '完成（生成导出包并通知）',
  anonymize: '执行注销（不可撤销：清除身份与联系方式，积分冲销，绑定失效）',
};

/** 隐私数据请求处理（admin；§9.2 v1.9 / v1.10）。执行类操作为高风险（10 分钟内登录过） */
export default async function DataRequests({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = (['pending', 'done', 'rejected'] as const).find((s) => s === one(sp.status)) ?? 'pending';
  const cursor = one(sp.cursor);
  const back = `/data-requests${status === 'pending' ? '' : `?status=${status}`}`;
  const r = await call<{ items: DR[]; next: string | null }>(`/data-requests?status=${status}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  if (!r.ok) return <ErrorView err={r.err} back={back} />;
  return (
    <>
      <h1>数据请求</h1>
      <nav className="filters" aria-label="筛选">
        {(['pending', 'done', 'rejected'] as const).map((s) => (
          <a key={s} href={`/admin/data-requests${s === 'pending' ? '' : `?status=${s}`}`} className={status === s ? 'on' : ''}>{DR_STATUS_TEXT[s]}</a>
        ))}
      </nav>
      <Flash back={back} />
      {r.data.items.length === 0 ? <div className="panel muted">没有{DR_STATUS_TEXT[status]}的请求</div> : null}
      {r.data.items.map((d) => {
        const blocker = doneBlocker(d);
        return (
          <section key={d.id} className="panel">
            <h2>
              {DATA_REQUEST_TEXT[d.kind]} <span className="mono muted">{d.id}</span> <Tag tone={d.status === 'pending' ? 'amber' : d.status === 'done' ? 'green' : 'muted'}>{DR_STATUS_TEXT[d.status]}</Tag>
            </h2>
            <dl className="kv">
              <dt>申请人</dt>
              <dd className="mono">{d.userId}</dd>
              <dt>提交 / 结案</dt>
              <dd className="num">{fmt(d.createdAt)} / {fmt(d.resolvedAt)}</dd>
              {d.note ? (<><dt>申请说明</dt><dd>{d.note}</dd></>) : null}
              {d.kind === 'anonymize' ? (
                <>
                  <dt>联系确认</dt>
                  <dd>{d.contactChannel ? `已确认（${d.contactChannel === 'telegram' ? 'Telegram' : '邮箱'} · ${fmt(d.contactConfirmedAt)}）` : '未确认'}</dd>
                </>
              ) : null}
            </dl>

            {d.targets.length ? (
              <table style={{ marginTop: 'var(--s-6)' }}>
                <thead><tr><th>证据</th><th>案件</th><th>案件结案</th><th>原文</th><th>脱敏</th>{d.status === 'pending' && d.kind === 'redact_evidence' ? <th>上传脱敏件</th> : null}</tr></thead>
                <tbody>
                  {d.targets.map((t) => (
                    <tr key={t.evidenceId}>
                      <td className="mono">{t.evidenceId}</td>
                      <td>{t.evidenceId.startsWith('se_') ? <span className="mono">{t.complaintId}<span className="muted">（出款凭证）</span></span> : <a className="link mono" href={`/admin/complaints/${t.complaintId}`}>{t.complaintId}</a>}</td>
                      <td>{t.complaintClosed ? <Tag tone="green">已结案</Tag> : <Tag tone="amber">未结案</Tag>}</td>
                      <td>{t.originalAvailable ? '在' : <Tag tone="muted">已删除</Tag>}</td>
                      <td>{t.redacted ? <Tag tone="blue">已脱敏</Tag> : '—'}</td>
                      {d.status === 'pending' && d.kind === 'redact_evidence' ? (
                        <td>
                          {!t.redacted && t.originalAvailable ? (
                            <form action={redactAction} style={{ display: 'flex', gap: 'var(--s-3)' }}>
                              <Back to={back} />
                              <input type="hidden" name="id" value={d.id} />
                              <input type="hidden" name="evidenceId" value={t.evidenceId} />
                              <input type="file" name="file" required accept="image/png,image/jpeg,image/webp,application/pdf,text/plain" />
                              <button className="btn ghost">替换原文</button>
                            </form>
                          ) : '—'}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {d.status === 'pending' ? (
              <>
                {d.kind === 'anonymize' && !d.contactChannel ? (
                  <form className="act" action={contactConfirmAction}>
                    <Back to={back} />
                    <input type="hidden" name="id" value={d.id} />
                    <label>
                      已经登记联系方式向本人确认
                      <select name="channel" defaultValue="telegram">
                        <option value="telegram">Telegram</option>
                        <option value="email">邮箱</option>
                      </select>
                    </label>
                    <button className="btn ghost">记录联系确认</button>
                  </form>
                ) : null}
                <form className="act" action={resolveDataRequestAction}>
                  <Back to={back} />
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="result" value="done" />
                  {d.kind === 'anonymize' && !blocker ? (
                    <label className="chk">
                      <input type="checkbox" name="irreversible" required /> 已核对申请人与联系确认；注销不可撤销
                    </label>
                  ) : null}
                  <button className="btn" disabled={!!blocker}>{DONE_TEXT[d.kind]}</button>
                  {blocker ? <p className="hint">{blocker}</p> : null}
                </form>
                <form className="act" action={resolveDataRequestAction}>
                  <Back to={back} />
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="result" value="rejected" />
                  <label className="grow">驳回原因（站内通知申请人）<input name="note" required maxLength={500} /></label>
                  <button className="btn danger">驳回</button>
                </form>
                <p className="hint">执行类操作需 10 分钟内登录过；结果站内通知申请人（注销除外：身份与通知已清除），全部写审计日志。</p>
              </>
            ) : null}
          </section>
        );
      })}
      {r.data.next ? <p><a className="link" href={`/admin${back}${back.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(r.data.next)}`}>下一页</a></p> : null}
    </>
  );
}
