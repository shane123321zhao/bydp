import { call, raw } from '../../../lib/api';
import { exposeAction, noticeAction, operatorReplyAction, publishAction, transitionAction } from '../../../lib/actions';
import { BINDING_TEXT, BRAND_STATUS_TEXT, CATEGORY_TEXT, FLAG_TEXT, STATUS_TEXT, fmt } from '../../../lib/labels';
import { Back, ErrorView, Flash, Tag } from '../../../lib/ui';

type Evidence = { id: string; type: string; sha256: string; redactedSha256: string | null; redacted: boolean; originalAvailable: boolean; uploadedAt: string };
type Detail = {
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
  title: string;
  description: string;
  publicDescription: string | null;
  eventDate: string;
  evidence: Evidence[];
  timeline: { at: string; to: string; actor: string; reason: string | null }[];
  audit: { at: string; actorId: string; actorRole: string | null; action: string }[];
  screening: { reviewItemId: string; status: string; suggest: string; rules: { rule: string; note: string }[]; createdAt: string } | null;
};

const SUGGEST_TEXT: Record<string, string> = { accept: '建议受理', reject: '建议驳回', needs_info: '建议补充材料' };
const EV_TYPE: Record<string, string> = { screenshot: '截图', chat_log: '聊天记录', tx_hash: '交易哈希', other: '其他' };
const CHECKLIST: [name: string, label: string][] = [
  ['noPersonalNames', '不含个人姓名（含客服 / 代理姓名）'],
  ['noContactInfo', '不含联系方式（电话 / TG / 邮箱 / 微信）'],
  ['noAccountIds', '不含账号、钱包地址、订单号等可识别标识'],
  ['noImagesWithFaces', '公开内容不含人脸或可识别人像'],
];

/** 证据第 1 页预览：服务端先探测类型——文本直接在页内显示（React 转义），位图经本站代理以 <img> 显示 */
async function probe(ev: Evidence): Promise<{ kind: 'image' } | { kind: 'text'; text: string } | { kind: 'none'; why: string }> {
  if (!ev.originalAvailable) return { kind: 'none', why: '原文已删除（哈希保留）' };
  const res = await raw(`/evidence/${encodeURIComponent(ev.id)}/preview?page=1`).catch(() => null);
  if (!res) return { kind: 'none', why: '后台接口不可达' };
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string } | null;
    return { kind: 'none', why: b?.message ?? `预览不可用（${res.status}）` };
  }
  const type = res.headers.get('Content-Type') ?? '';
  if (type.startsWith('text/plain')) return { kind: 'text', text: await res.text() };
  // 读完再丢弃：Next 的 fetch 会 tee 响应体，cancel() 会一直等另一分支而挂起（测试站实测）
  await res.arrayBuffer();
  return { kind: 'image' };
}

export default async function ComplaintDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const back = `/complaints/${id}`;
  const r = await call<Detail>(`/complaints/${encodeURIComponent(id)}`);
  if (!r.ok) return <ErrorView err={r.err} back={back} />;
  const c = r.data;
  const previews = await Promise.all(c.evidence.map(probe));
  const canExpose = ['accepted', 'awaiting_reply', 'unresolved'].includes(c.status);
  const canClose = c.status === 'arbitrating'; // 状态机：只有 arbitrating → resolved | rejected | unresolved
  const canPublish = ['resolved', 'unresolved', 'exposed'].includes(c.status);

  return (
    <>
      <p><a className="link" href="/admin/complaints">← 仲裁台</a></p>
      <h1>
        <span className="mono">{c.id}</span> <Tag>{STATUS_TEXT[c.status] ?? c.status}</Tag>
        {c.flags.map((f) => <Tag key={f} tone="amber">{FLAG_TEXT[f] ?? f}</Tag>)}
        {c.publicSummary ? <Tag tone="green">已公开</Tag> : null}
      </h1>
      <Flash back={back} />
      <div className="grid2">
        <div>
          <section className="panel">
            <h2>案件</h2>
            <dl className="kv">
              <dt>品牌</dt>
              <dd>
                {c.brand.name} <span className="muted mono">{c.brand.slug}</span>{' '}
                <Tag tone={c.brand.status === 'blacklist' ? 'red' : undefined}>{BRAND_STATUS_TEXT[c.brand.status] ?? c.brand.status}</Tag>
              </dd>
              <dt>类别 / 金额</dt>
              <dd>{CATEGORY_TEXT[c.category] ?? c.category} · <span className="num">{c.amountUsdt.toLocaleString('en-US')}</span> USDT</dd>
              <dt>发生日期</dt>
              <dd className="num">{c.eventDate}</dd>
              <dt>绑定</dt>
              <dd>{BINDING_TEXT[c.bindingLevel] ?? c.bindingLevel}</dd>
              <dt>运营商通知</dt>
              <dd className="num">{c.notices} 次 · 答辩截止 {fmt(c.replyDeadline)}</dd>
              <dt>提交</dt>
              <dd className="num">{fmt(c.createdAt)}</dd>
              <dt>标题</dt>
              <dd>{c.title}</dd>
            </dl>
          </section>
          {c.screening ? (
            <section className="panel">
              <h2>
                初筛建议 <span className="muted">（Agent 规则，仅供参考，不改案件状态）</span>{' '}
                <Tag tone={c.screening.suggest === 'reject' ? 'red' : c.screening.suggest === 'needs_info' ? 'amber' : 'green'}>{SUGGEST_TEXT[c.screening.suggest] ?? c.screening.suggest}</Tag>
              </h2>
              {c.screening.rules.length ? (
                <ul className="body">
                  {c.screening.rules.map((x, i) => (
                    <li key={i}>{x.note}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">未命中任何规则</p>
              )}
              <p className="hint">
                <a className="link" href={`/admin/review?kind=complaint_screening`}>在审核台处理该建议</a> · {fmt(c.screening.createdAt)}
              </p>
            </section>
          ) : null}
          <section className="panel">
            <h2>投诉原文 <span className="muted">（仅后台可见，不得公开）</span></h2>
            <p className="pre">{c.description}</p>
          </section>
          <section className="panel">
            <h2>证据 <span className="muted">（沙箱预览：服务端转为位图，不下发原文件）</span></h2>
            {c.evidence.length === 0 ? <p className="muted">无证据</p> : null}
            <div className="ev">
              {c.evidence.map((e, i) => {
                const p = previews[i]!;
                const pv = (n: number) => `/admin/evidence/${encodeURIComponent(e.id)}/preview?page=${n}`;
                return (
                  <figure key={e.id}>
                    {p.kind === 'image' ? (
                      <a href={pv(1)} target="_blank" rel="noreferrer">
                        <img src={pv(1)} alt={`证据 ${e.id} 第 1 页`} loading="lazy" />
                      </a>
                    ) : p.kind === 'text' ? (
                      <pre className="pre mono">{p.text}</pre>
                    ) : (
                      <p className="pre muted">{p.why}</p>
                    )}
                    <figcaption>
                      <span>
                        {EV_TYPE[e.type] ?? e.type} {e.redacted ? <Tag tone="blue">已脱敏</Tag> : null}
                        <br />
                        <span className="mono" title={e.sha256}>sha256 {e.sha256.slice(0, 12)}…</span>
                      </span>
                      <span>
                        {p.kind === 'image' ? (
                          <>
                            PDF 其他页：
                            {[2, 3, 4, 5].map((n) => (
                              <a key={n} className="link" href={pv(n)} target="_blank" rel="noreferrer">
                                p{n}{' '}
                              </a>
                            ))}
                            <br />
                          </>
                        ) : null}
                        {e.originalAvailable ? (
                          <a className="link" href={`/admin/evidence/${encodeURIComponent(e.id)}/download`} title="例外场景使用；下载写审计日志">
                            原文下载
                          </a>
                        ) : null}
                      </span>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <h2>处理记录</h2>
            <table>
              <thead><tr><th>时间</th><th>状态</th><th>操作方</th><th>原因</th></tr></thead>
              <tbody>
                {c.timeline.map((t, i) => (
                  <tr key={i}><td className="num">{fmt(t.at)}</td><td>{STATUS_TEXT[t.to] ?? t.to}</td><td>{t.actor}</td><td>{t.reason ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>审计日志（本案）</h2>
            <table>
              <thead><tr><th>时间</th><th>操作</th><th>角色</th><th>操作人</th></tr></thead>
              <tbody>
                {c.audit.map((a, i) => (
                  <tr key={i}><td className="num">{fmt(a.at)}</td><td className="mono">{a.action}</td><td>{a.actorRole ?? '—'}</td><td className="mono">{a.actorId}</td></tr>
                ))}
                {c.audit.length === 0 ? <tr><td colSpan={4} className="muted">暂无</td></tr> : null}
              </tbody>
            </table>
          </section>
        </div>

        <div>
          <section className="panel">
            <h2>处理</h2>
            {c.status === 'screening' ? (
              <>
                <form className="act" action={transitionAction}>
                  <Back to={back} />
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="to" value="accepted" />
                  <button className="btn">受理</button>
                </form>
                <form className="act" action={transitionAction}>
                  <Back to={back} />
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="to" value="rejected" />
                  <label className="grow">驳回原因（通知投诉人，不公开）<input name="reason" required maxLength={500} /></label>
                  <button className="btn danger">驳回</button>
                </form>
              </>
            ) : null}
            {c.status === 'accepted' || (c.status === 'awaiting_reply' && c.notices < 2) ? (
              <form className="act" action={noticeAction}>
                <Back to={back} />
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="which" value={c.status === 'accepted' ? 'first' : 'second'} />
                <label className="grow">
                  {c.status === 'accepted' ? '已通知运营商（首次，答辩期 7 天起算）' : '已通知运营商（二次）'} · 渠道
                  <input name="channel" required maxLength={120} placeholder="如：认领邮箱 / 官方 TG" />
                </label>
                <button className="btn">记录通知</button>
              </form>
            ) : null}
            {c.status === 'awaiting_reply' ? (
              <form className="act" action={operatorReplyAction}>
                <Back to={back} />
                <input type="hidden" name="id" value={c.id} />
                <label className="grow">
                  运营商已答辩 · 答辩摘要（选填，不公开）
                  <textarea name="summary" maxLength={1000} rows={2} />
                </label>
                <button className="btn">记录运营商答辩</button>
              </form>
            ) : null}
            {canClose ? (
              <form className="act" action={transitionAction}>
                <Back to={back} />
                <input type="hidden" name="id" value={c.id} />
                <label>
                  结案
                  <select name="to" defaultValue="resolved">
                    <option value="resolved">已解决</option>
                    <option value="unresolved">未解决</option>
                    <option value="rejected">驳回</option>
                  </select>
                </label>
                <label className="grow">依据<input name="reason" maxLength={500} /></label>
                <button className="btn">提交</button>
              </form>
            ) : null}
            {canExpose ? (
              <form className="act" action={exposeAction}>
                <Back to={back} />
                <input type="hidden" name="id" value={c.id} />
                <label className="grow">确认转曝光 · 依据（失联须两次通知且期满；黑名单品牌受理后可直接曝光）<input name="reason" required maxLength={500} /></label>
                <button className="btn danger">确认曝光</button>
                <p className="hint">高风险操作：需 10 分钟内登录过。</p>
              </form>
            ) : null}
            {!['screening', 'accepted', 'awaiting_reply', 'arbitrating', 'unresolved'].includes(c.status) && !canPublish ? (
              <p className="muted">该状态无可执行动作。</p>
            ) : null}
          </section>

          {canPublish ? (
            <section className="panel">
              <h2>{c.publicSummary ? '修订公开文本' : '公开前人工脱敏确认'}</h2>
              <form className="act" action={publishAction}>
                <Back to={back} />
                <input type="hidden" name="id" value={c.id} />
                <label className="grow" style={{ width: '100%' }}>
                  公开标题（≤ 80 字；标题也显示在公开页，可能含姓名 / 联系方式，按需修订）
                  <input name="title" required maxLength={80} defaultValue={c.title} />
                </label>
                <label className="grow" style={{ width: '100%' }}>
                  公开陈述（≤ 500 字；公开页只显示本段，不读投诉原文）
                  <textarea name="publicDescription" required maxLength={500} defaultValue={c.publicDescription ?? ''} />
                </label>
                {CHECKLIST.map(([name, label]) => (
                  <label key={name} className="chk">
                    <input type="checkbox" name={name} required /> {label}
                  </label>
                ))}
                <button className="btn">{c.publicSummary ? '保存修订' : '确认公开'}</button>
                <p className="hint">四项对「公开标题 + 公开陈述」一并核对，须全部勾选；高风险操作，需 10 分钟内登录过；修订记审计（前后文本与标题）。</p>
              </form>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
