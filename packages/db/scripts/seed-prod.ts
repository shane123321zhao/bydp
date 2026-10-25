/**
 * 正式环境数据守卫（D-020 #4 · HANDOVER §9 #9）：用法 DATABASE_URL=<owner> pnpm db:seed:prod。生产 bootstrap 每次部署都执行。
 * - 正式库**不灌任何演示数据**：品牌 / 用户 / 案件全部来自真实运营。规则（积分口径等）在代码里，术语表在 packages/i18n/glossary，
 *   角色（arbitrator / editor / commerce / admin）由迁移 0012 写入——所以本脚本不插入任何行，只做检查。
 * - 发现任何 fixtures 演示行（按 id）或测试站验收数据（u_m2accept_* / u_m3* / br_agenttest / cp_po_* 等）→ 失败退出（禁止从测试站复制库）。
 * - 角色表须完整 4 个；输出只有计数，不含任何数据内容。
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../src/index';
import { loadFixtures } from '../src/seed/load';

const ROLES = ['admin', 'arbitrator', 'commerce', 'editor'];
// 测试站验收 / 测试数据的 id 形态（W3#021 / M2 / M3 验收；测试站数据清单）
const TEST_PATTERNS = ['u\\_m2accept\\_%', 'u\\_m3%', 'u\\_po\\_%', 'cp\\_po\\_%', 'br\\_agenttest%', 'u\\_demo\\_%', 'cp\\_demo\\_%'];
// seed:demo 生成的其他表行（seed/demo.ts）
const DEMO_ROWS: [table: string, pattern: string][] = [
  ['user_brand_binding', 'ubb\\_demo\\_%'],
  ['withdrawal_report', 'wr\\_demo\\_%'],
  ['click', 'clk\\_demo\\_%'],
  ['review', 'rv\\_demo\\_%'],
];

const fx = loadFixtures() as unknown as Record<string, Record<string, unknown>>;
const f: Record<string, unknown> = Object.assign({}, ...Object.values(fx));
const ids = (key: string) => ((f[key] as { id?: string }[] | undefined) ?? []).map((r) => r.id).filter((x): x is string => !!x);
const CHECKS: [table: string, ids: string[]][] = [
  ['operator', ids('operators')],
  ['brand', ids('brands')],
  ['identifier', ids('identifiers')],
  ['offer', ids('offers')],
  ['app_user', ids('users')],
  ['complaint', ids('complaints')],
  ['evidence', ids('evidence')],
  ['exposure', ids('exposures')],
];

const { db, client } = createDb();
const q = async <T>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
let failed = false;
try {
  for (const [table, list] of CHECKS) {
    if (!list.length) continue;
    const [r] = await q<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where "id" in ${list}`);
    if ((r?.n ?? 0) > 0) {
      console.log(`❌ 失败 ｜ ${table} 含 ${r!.n} 行演示数据（fixtures id）：正式库须全新初始化，不得从测试站复制`);
      failed = true;
    }
  }
  for (const [table, col] of [['app_user', 'id'], ['complaint', 'id'], ['brand', 'id']] as const) {
    const [r] = await q<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.join(TEST_PATTERNS.map((p) => sql`${sql.identifier(col)} like ${p}`), sql` or `)}`,
    );
    if ((r?.n ?? 0) > 0) {
      console.log(`❌ 失败 ｜ ${table} 含 ${r!.n} 行测试站验收 / 测试数据`);
      failed = true;
    }
  }
  for (const [table, p] of DEMO_ROWS) {
    const [r] = await q<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where "id" like ${p}`);
    if ((r?.n ?? 0) > 0) {
      console.log(`❌ 失败 ｜ ${table} 含 ${r!.n} 行演示数据（seed:demo）`);
      failed = true;
    }
  }
  const roles = (await q<{ key: string }>(sql`select "key" from "role" order by "key"`)).map((r) => r.key);
  const missing = ROLES.filter((r) => !roles.includes(r));
  if (missing.length) {
    console.log(`❌ 失败 ｜ 角色缺失：${missing.join(', ')}（应由迁移 0012 写入）`);
    failed = true;
  }
  const [c] = await q<{ brands: number; users: number; complaints: number }>(
    sql`select (select count(*)::int from "brand") as "brands", (select count(*)::int from "app_user") as "users", (select count(*)::int from "complaint") as "complaints"`,
  );
  if (!failed) console.log(`✅ 通过 ｜ 正式库无演示 / 测试数据 · 角色 ${roles.length} 个 · 品牌 ${c!.brands} · 用户 ${c!.users} · 案件 ${c!.complaints}`);
} finally {
  await client.end();
}
process.exit(failed ? 1 : 0);
