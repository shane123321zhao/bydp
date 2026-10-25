/**
 * 演示数据（方案 A）：pnpm db:seed:demo —— 在 base seed 之后执行。**仅限本地 / 演示环境，禁止在生产库运行。**
 * 生产保护：DATABASE_URL 带 BYDP_ENV=production 或主机名含 prod 时拒绝执行。
 */
import { sql } from 'drizzle-orm';
import { bindingPiiKeyFromEnv, createDb } from '../src/index';
import { SEED_PII_KEY } from '../src/seed/build';
import { buildDemo } from '../src/seed/demo';
import { TABLES, assertColumns } from '../src/seed/tables';

const url = process.env.DATABASE_URL ?? '';
if (process.env.BYDP_ENV === 'production' || /prod/i.test(new URL(url || 'postgres://x').hostname)) {
  console.error('拒绝执行：demo 数据不得进入生产库（PO 裁定 2026-09-27）');
  process.exit(1);
}
/** A-011 T9 密钥：有 AUTH_PII_KEY 即用；本机 / CI（未设 BYDP_ENV）才可退回公开的 seed 测试密钥，测试站 / 生产缺密钥直接失败 */
function seedPiiKey() {
  if (process.env.AUTH_PII_KEY) return bindingPiiKeyFromEnv();
  if (process.env.BYDP_ENV) throw new Error(`BYDP_ENV=${process.env.BYDP_ENV} 缺 AUTH_PII_KEY：拒绝用公开测试密钥加密绑定账号`);
  return SEED_PII_KEY;
}
const plan = buildDemo(seedPiiKey());
for (const { table, rows } of plan.tables) assertColumns(table, rows);
const { db, client } = createDb(url);
try {
  const [row] = (await db.execute(sql`select count(*)::int as n from "app_user" where "id" like 'u_demo_%'`)) as unknown as { n: number }[];
  if ((row?.n ?? 0) > 0) throw new Error('demo 数据已存在：重灌请重建库');
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local bydp.allow_backfill = 'on'`);
    for (const { table, rows } of plan.tables) {
      for (let i = 0; i < rows.length; i += 500) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await tx.insert(TABLES[table]!).values(rows.slice(i, i + 500) as any);
      }
      console.log(`${table.padEnd(20)} +${rows.length} (demo)`);
    }
  });
} finally {
  await client.end();
}
