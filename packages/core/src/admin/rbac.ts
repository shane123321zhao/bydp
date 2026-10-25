/**
 * 后台 RBAC（admin 契约 v0.2 · §9.2 v1.7）：角色只从 `user_role` 读取，core 不信任调用方传入的角色。
 * 角色（DB role_key）：arbitrator 仲裁 · editor 编辑 · commerce 商务（本期无后台写权限）· admin 管理员（全部）。
 * 仲裁与商务物理隔离：同一用户不得同时持 arbitrator 与 commerce（ADR-0003）。
 */
import { schema, sql, type Db } from '@bydp/db';

type Exec = Pick<Db, 'execute'>;
export type Role = 'arbitrator' | 'commerce' | 'editor' | 'admin';
export const ROLES: readonly Role[] = ['arbitrator', 'commerce', 'editor', 'admin'];
const ROLE_NAMES: Record<Role, string> = { arbitrator: '仲裁员', commerce: '商务', editor: '编辑', admin: '管理员' };

export type Permission =
  | 'admin.session'
  | 'dashboard.read'
  | 'arbitration.read'
  | 'arbitration.write'
  | 'evidence.preview'
  | 'evidence.download'
  | 'privacy.read'
  | 'privacy.write'
  | 'review.read'
  | 'review.write'
  | 'brand.read'
  | 'brand.status.write'
  | 'offer.status.write'
  | 'risk.read'
  | 'roles.read'
  | 'roles.write';

/** 权限矩阵（契约 v0.2 各 tag 说明）。数组顺序 = 记 audit_log 时优先取的角色 */
const GRANTS: Record<Permission, Role[]> = {
  'admin.session': ['arbitrator', 'editor', 'commerce', 'admin'],
  'dashboard.read': ['arbitrator', 'editor', 'commerce', 'admin'],
  'arbitration.read': ['arbitrator', 'admin'],
  'arbitration.write': ['arbitrator', 'admin'],
  'evidence.preview': ['arbitrator', 'admin'],
  'evidence.download': ['arbitrator', 'admin'],
  'privacy.read': ['admin'],
  'privacy.write': ['admin'],
  'review.read': ['editor', 'admin'],
  'review.write': ['editor', 'admin'],
  // D-018：品牌状态变更（admin 或仲裁员；10 分钟重新验证在路由层）
  'brand.read': ['arbitrator', 'admin'],
  'brand.status.write': ['arbitrator', 'admin'],
  // A-018：Offer 上线 / 下线仅 admin（商业动作，仲裁与商务隔离）
  'offer.status.write': ['admin'],
  'risk.read': ['admin'],
  'roles.read': ['admin'],
  'roles.write': ['admin'],
};

export class ForbiddenError extends Error {
  constructor(message = '无权限执行该操作') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export async function getUserRoles(db: Exec, userId: string): Promise<Role[]> {
  const rows = (await db.execute(sql`select "roleKey" from ${schema.userRoles} where "userId" = ${userId} order by "roleKey"`)) as unknown as {
    roleKey: Role;
  }[];
  return rows.map((r) => r.roleKey);
}

/** 校验权限并返回本次操作记入 audit_log 的角色；无权限抛 ForbiddenError */
export function authorize(roles: readonly Role[], perm: Permission): Role {
  const r = GRANTS[perm].find((g) => roles.includes(g));
  if (!r) throw new ForbiddenError();
  return r;
}

export type Actor = { id: string; role: Role; ip: string | null };

/** 写 audit_log（只追加）。所有后台写操作同事务调用 */
export async function writeAudit(
  db: Exec,
  a: Actor,
  action: string,
  target: { type: string; id: string | null },
  before: unknown,
  after: unknown,
): Promise<void> {
  await db.execute(
    sql`insert into ${schema.auditLogs} ("actorId", "actorRole", "action", "targetType", "targetId", "before", "after", "ip")
        values (${a.id}, ${a.role}, ${action}, ${target.type}, ${target.id}, ${before == null ? null : JSON.stringify(before)}::jsonb,
                ${after == null ? null : JSON.stringify(after)}::jsonb, ${a.ip})`,
  );
}

/** 角色变更全局串行锁的键（core 与 db/scripts/grant-role.ts 共用同一字符串） */
export const ROLE_LOCK = 'bydp:user_role';

/** 重新验证窗口（审核 admin 第 1 轮）：高风险操作 10 分钟、其余后台请求 24 小时（会话 authTime 计） */
export const ADMIN_REAUTH = { highRiskSec: 10 * 60, baselineSec: 24 * 3600 } as const;

/** 会话签发过久 → 接口 401 reauth_required（与注销二次验证同一口径） */
export class AdminReauthRequiredError extends Error {
  constructor(public readonly windowSec: number) {
    super(windowSec <= ADMIN_REAUTH.highRiskSec ? '该操作需 10 分钟内重新登录' : '后台会话已超过 24 小时，请重新登录');
    this.name = 'AdminReauthRequiredError';
  }
}

export function assertRecentAuth(authTime: number | null | undefined, windowSec: number, nowSec = Math.floor(Date.now() / 1000)): void {
  if (typeof authTime !== 'number' || nowSec - authTime > windowSec || authTime > nowSec + 60) throw new AdminReauthRequiredError(windowSec);
}

export class RoleChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleChangeError';
  }
}

/**
 * PUT /users/{id}/roles：整体替换（admin）。仲裁与商务互斥；不能移除自己的 admin，也不能移除系统中最后一个 admin（防止锁死后台）。
 * 并发：全部角色变更以事务级咨询锁串行（ROLE_LOCK，CLI grant-role 共用），互斥与最后一个 admin 的判断在锁内完成。
 * role 参照表行按需补齐（role 表无种子，见 to-po W3#046）。同事务写 audit_log（before / after）。
 */
export async function setUserRoles(db: Pick<Db, 'execute' | 'transaction'>, actor: Actor, userId: string, roles: Role[]): Promise<Role[]> {
  const next = [...new Set(roles)].sort();
  if (next.some((r) => !ROLES.includes(r))) throw new RoleChangeError('角色不识别');
  if (next.includes('arbitrator') && next.includes('commerce')) throw new RoleChangeError('仲裁员与商务角色不能由同一人担任');
  if (userId === actor.id && !next.includes('admin')) throw new RoleChangeError('不能移除自己的管理员角色');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ROLE_LOCK}))`);
    const [u] = (await tx.execute(sql`select 1 from ${schema.users} where "id" = ${userId}`)) as unknown as unknown[];
    if (!u) throw new RoleChangeError('用户不存在');
    const before = await getUserRoles(tx, userId);
    if (before.includes('admin') && !next.includes('admin')) {
      const [n] = (await tx.execute(
        sql`select count(*)::int as "n" from ${schema.userRoles} where "roleKey" = 'admin' and "userId" <> ${userId}`,
      )) as unknown as { n: number }[];
      if (!n || n.n === 0) throw new RoleChangeError('不能移除系统中最后一个管理员');
    }
    for (const r of next) {
      await tx.execute(sql`insert into ${schema.roles} ("key", "name") values (${r}, ${ROLE_NAMES[r]}) on conflict ("key") do nothing`);
    }
    await tx.execute(sql`delete from ${schema.userRoles} where "userId" = ${userId}`);
    for (const r of next) await tx.execute(sql`insert into ${schema.userRoles} ("userId", "roleKey") values (${userId}, ${r})`);
    await writeAudit(tx, actor, 'user_roles_set', { type: 'user', id: userId }, { roles: before }, { roles: next });
    return next;
  });
}
