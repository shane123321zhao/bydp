import { call, type Role } from '../../lib/api';
import { setRolesAction } from '../../lib/actions';
import { ROLE_TEXT } from '../../lib/labels';
import { Back, ErrorView, Flash, one, type SP } from '../../lib/ui';

const ROLES: Role[] = ['arbitrator', 'editor', 'commerce', 'admin'];

/** 角色管理（admin）：按用户 id 整体替换。仲裁员与商务互斥、不能移除自己的管理员、不能移除最后一个管理员（api 判定） */
export default async function Roles({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const userId = one(sp.userId).trim();
  const back = `/roles${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`;
  const r = userId ? await call<Role[]>(`/users/${encodeURIComponent(userId)}/roles`) : null;
  if (r && !r.ok) return <ErrorView err={r.err} back={back} />;
  return (
    <>
      <h1>角色</h1>
      <Flash back={back} />
      <div className="panel">
        <form className="act" method="get" action="/admin/roles">
          <label className="grow">用户 id<input name="userId" defaultValue={userId} required maxLength={64} className="mono" /></label>
          <button className="btn ghost">查询</button>
        </form>
      </div>
      {r?.ok ? (
        <div className="panel">
          <h2>
            <span className="mono">{userId}</span> 当前角色：{r.data.length ? r.data.map((x) => ROLE_TEXT[x]).join(' · ') : '无'}
          </h2>
          <form className="act" action={setRolesAction}>
            <Back to={back} />
            <input type="hidden" name="userId" value={userId} />
            {ROLES.map((role) => (
              <label key={role} className="chk" style={{ width: 'auto' }}>
                <input type="checkbox" name="roles" value={role} defaultChecked={r.data.includes(role)} /> {ROLE_TEXT[role]}
              </label>
            ))}
            <button className="btn">保存</button>
            <p className="hint">整体替换；仲裁员与商务不能由同一人担任（物理隔离）。高风险操作，需 10 分钟内登录过；写审计日志（前后角色）。</p>
          </form>
        </div>
      ) : null}
    </>
  );
}
