import { call, type Session } from '../../lib/api';
import { brandStatusAction, offerStatusAction } from '../../lib/actions';
import { BRAND_STATUS_TEXT } from '../../lib/labels';
import { Back, ErrorView, Flash, one, type SP } from '../../lib/ui';

type Brand = { id: string; slug: string; name: string; status: 'certified' | 'watch' | 'blacklist'; statusSince: string; subscribers: number; openComplaints: number };

/** 转入各状态的连带后果（§9.2 v1.14；确认前展示） */
const CONSEQUENCE: Record<Brand['status'], string> = {
  certified: '品牌页显示「平台认证」（商业背书，仅管理员；须已登记保证金，关联方品牌不可认证）；评分照常计算；若由黑名单转出，Offer 保持下线，须管理员逐个上线。',
  watch: '品牌页显示「观察」；评分照常计算；若由黑名单转出，Offer 保持下线，须管理员逐个上线。',
  blacklist: '评分不再显示（置空）；该品牌全部 Offer 立即下线（解除后不自动恢复）、领码与新绑定被拒；进行中的案件照常处理。',
};

/** 仲裁员可做的变更（§9.2 v1.15）：转黑名单、由认证转观察；转认证与离开黑名单只限 admin（api 同样校验） */
const allowed = (isAdmin: boolean, from: Brand['status'], to: Brand['status']) => to !== from && (isAdmin || (to !== 'certified' && from !== 'blacklist'));

/** 品牌状态（admin / 仲裁员）：查品牌 → 选新状态 + 原因 → 确认。高风险操作，需 10 分钟内登录过；写审计与状态日志，通知订阅者与进行中案件的投诉人 */
export default async function Brands({ searchParams }: { searchParams: SP }) {
  const q = one((await searchParams).q).trim();
  const back = `/brands${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  const r = await call<{ items: Brand[] }>(`/brands${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (!r.ok) return <ErrorView err={r.err} back="/brands" />;
  const s = await call<Session>('/session');
  const isAdmin = s.ok && s.data.roles.includes('admin');
  return (
    <>
      <h1>品牌状态</h1>
      <Flash back={back} />
      <div className="panel">
        <form className="act" method="get" action="/admin/brands">
          <label className="grow">品牌名 / slug / id<input name="q" defaultValue={q} maxLength={80} /></label>
          <button className="btn ghost">查询</button>
        </form>
      </div>
      {r.data.items.map((b) => (
        <div className="panel" key={b.id}>
          <h2>
            {b.name} <span className="mono muted">{b.slug}</span> · 当前：{BRAND_STATUS_TEXT[b.status]}（自 {b.statusSince}）
          </h2>
          <p className="hint">订阅者 {b.subscribers} 人 · 进行中案件 {b.openComplaints} 件——变更后各收到一条站内通知与推送。</p>
          {(['certified', 'watch', 'blacklist'] as const).some((s) => allowed(isAdmin, b.status, s)) ? (
          <form className="act" action={brandStatusAction}>
            <Back to={back} />
            <input type="hidden" name="id" value={b.id} />
            <label>
              新状态
              <select name="to" required defaultValue="">
                <option value="" disabled>选择</option>
                {(['certified', 'watch', 'blacklist'] as const).filter((s) => allowed(isAdmin, b.status, s)).map((s) => (
                  <option key={s} value={s}>{BRAND_STATUS_TEXT[s]}</option>
                ))}
              </select>
            </label>
            <label className="grow">原因（必填，会原样推送给订阅者与投诉人：中性描述，勿含个人信息、电话、账号、链接）<textarea name="reason" required maxLength={500} rows={2} /></label>
            <label>依据案件 id（可选，逗号分隔）<input name="evidenceCaseIds" maxLength={400} className="mono" /></label>
            <label className="chk" style={{ width: 'auto' }}><input type="checkbox" required /> 已确认连带后果，原因不含个人信息</label>
            <button className="btn">确认变更</button>
            <ul className="hint">
              {(['certified', 'watch', 'blacklist'] as const).filter((s) => allowed(isAdmin, b.status, s)).map((s) => (
                <li key={s}>转{BRAND_STATUS_TEXT[s]}：{CONSEQUENCE[s]}</li>
              ))}
            </ul>
          </form>
          ) : (
            <p className="hint">离开黑名单仅限管理员操作。</p>
          )}
          <BrandOffers brand={b} isAdmin={isAdmin} back={back} />
        </div>
      ))}
      {r.data.items.length === 0 ? <div className="panel muted">没有匹配的品牌</div> : null}
    </>
  );
}

type Offer = { id: string; title: string; status: 'active' | 'offline'; validUntil: string | null; exclusive: boolean };

/** A-018：该品牌的 Offer 与上线状态；上线 / 下线仅管理员（黑名单品牌上线由数据库拒绝），原因必填、写审计 */
async function BrandOffers({ brand, isAdmin, back }: { brand: Brand; isAdmin: boolean; back: string }) {
  const r = await call<{ items: Offer[] }>(`/brands/${encodeURIComponent(brand.id)}/offers`);
  if (!r.ok || r.data.items.length === 0) return null;
  return (
    <table>
      <thead>
        <tr><th>优惠</th><th>状态</th><th>有效期</th>{isAdmin ? <th>操作</th> : null}</tr>
      </thead>
      <tbody>
        {r.data.items.map((o) => (
          <tr key={o.id}>
            <td>{o.title} <span className="mono muted">{o.id}</span>{o.exclusive ? ' · 独家' : ''}</td>
            <td>{o.status === 'active' ? '上线' : '下线'}</td>
            <td className="num">{o.validUntil ?? '长期'}</td>
            {isAdmin ? (
              <td>
                {brand.status === 'blacklist' && o.status === 'offline' ? (
                  <span className="muted">黑名单期间不可上线</span>
                ) : (
                  <form className="act" action={offerStatusAction}>
                    <Back to={back} />
                    <input type="hidden" name="id" value={o.id} />
                    <input type="hidden" name="to" value={o.status === 'active' ? 'offline' : 'active'} />
                    <input name="reason" required maxLength={500} placeholder="原因（必填）" />
                    <button className="btn ghost">{o.status === 'active' ? '下线' : '上线'}</button>
                  </form>
                )}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
