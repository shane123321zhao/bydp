/**
 * 授予后台角色（初始化第一个 admin 用；之后在后台「角色管理」操作，PUT /admin/v1/users/{id}/roles）。
 * 用法：DATABASE_URL=<owner> pnpm --filter @bydp/db grant-role <userId> <arbitrator|commerce|editor|admin> [--revoke]
 * --revoke：收回该角色（测试账号最小权限等），写 audit_log user_role_revoke；不能收回系统中最后一个 admin。
 * 以表 owner 身份执行；同事务补齐 role 参照行、写 user_role、写 audit_log（actorId = system:cli）。仲裁与商务互斥。
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../src/index';

const NAMES: Record<string, string> = { arbitrator: '仲裁员', commerce: '商务', editor: '编辑', admin: '管理员' };
const [userId, role, flag] = process.argv.slice(2);
const revoke = flag === '--revoke';
if (!userId || !role || !NAMES[role] || (flag && !revoke)) {
  console.error('用法：grant-role <userId> <arbitrator|commerce|editor|admin> [--revoke]');
  process.exit(2);
}
const { db, client } = createDb();
try {
  await db.transaction(async (tx) => {
    // 与 core admin/rbac ROLE_LOCK 同一把锁：角色变更全局串行，互斥判断不被并发绕过
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bydp:user_role'))`);
    const [u] = (await tx.execute(sql`select 1 from "app_user" where "id" = ${userId}`)) as unknown as unknown[];
    if (!u) throw new Error('用户不存在');
    if (revoke) {
      if (role === 'admin') {
        const [n] = (await tx.execute(sql`select count(*)::int as "n" from "user_role" where "roleKey" = 'admin' and "userId" <> ${userId}`)) as unknown as { n: number }[];
        if (!n || n.n === 0) throw new Error('不能收回系统中最后一个管理员');
      }
      const gone = (await tx.execute(sql`delete from "user_role" where "userId" = ${userId} and "roleKey" = ${role} returning 1`)) as unknown as unknown[];
      if (gone.length) {
        await tx.execute(
          sql`insert into "audit_log" ("actorId", "actorRole", "action", "targetType", "targetId", "before")
              values ('system:cli', null, 'user_role_revoke', 'user', ${userId}, ${JSON.stringify({ role })}::jsonb)`,
        );
      }
      console.log(gone.length ? `已收回 ${role}` : `未持有 ${role}，未变更`);
      return;
    }
    const conflict = role === 'arbitrator' ? 'commerce' : role === 'commerce' ? 'arbitrator' : null;
    if (conflict) {
      const [x] = (await tx.execute(sql`select 1 from "user_role" where "userId" = ${userId} and "roleKey" = ${conflict}`)) as unknown as unknown[];
      if (x) throw new Error('仲裁员与商务角色不能由同一人担任');
    }
    await tx.execute(sql`insert into "role" ("key", "name") values (${role}, ${NAMES[role]}) on conflict ("key") do nothing`);
    const added = (await tx.execute(
      sql`insert into "user_role" ("userId", "roleKey") values (${userId}, ${role}) on conflict do nothing returning 1`,
    )) as unknown as unknown[];
    if (added.length) {
      await tx.execute(
        sql`insert into "audit_log" ("actorId", "actorRole", "action", "targetType", "targetId", "after")
            values ('system:cli', null, 'user_role_grant', 'user', ${userId}, ${JSON.stringify({ role })}::jsonb)`,
      );
    }
    console.log(added.length ? `已授予 ${role}` : `已有 ${role}，未变更`);
  });
} finally {
  await client.end();
}
