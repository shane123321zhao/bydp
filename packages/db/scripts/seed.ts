/** 用法：DATABASE_URL=... pnpm db:seed   （仅空库；只追加表不可清空，重灌请重建库） */
import { sql } from 'drizzle-orm';
import { bindingPiiKeyFromEnv, createDb } from '../src/index';
import { buildSeed, SEED_PII_KEY } from '../src/seed/build';
import { loadFixtures } from '../src/seed/load';
import { TABLES, assertColumns } from '../src/seed/tables';

/** A-011 T9 密钥：有 AUTH_PII_KEY 即用；本机 / CI（未设 BYDP_ENV）才可退回公开的 seed 测试密钥，测试站 / 生产缺密钥直接失败 */
function seedPiiKey() {
  if (process.env.AUTH_PII_KEY) return bindingPiiKeyFromEnv();
  if (process.env.BYDP_ENV) throw new Error(`BYDP_ENV=${process.env.BYDP_ENV} 缺 AUTH_PII_KEY：拒绝用公开测试密钥加密绑定账号`);
  return SEED_PII_KEY;
}
const plan = buildSeed(loadFixtures(), seedPiiKey());
for (const { table, rows } of plan.tables) assertColumns(table, rows);

const { db, client } = createDb();
try {
  const [row] = (await db.execute(sql`select count(*)::int as n from "brand"`)) as unknown as Array<{ n: number }>;
  if ((row?.n ?? 0) > 0) throw new Error('brand 表非空：seed 只用于空库');
  await db.transaction(async (tx) => {
    // 历史时间戳回填：仅表 owner + 本事务内有效（sql/10_append_only.sql bydp_server_ts）
    await tx.execute(sql`set local bydp.allow_backfill = 'on'`);
    for (const { table, rows } of plan.tables) {
      if (!rows.length) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await tx.insert(TABLES[table]!).values(rows as any);
      console.log(`${table.padEnd(20)} +${rows.length}`);
    }
  });
  if (plan.warnings.length) {
    console.log(`\n告警 ${plan.warnings.length} 条（已入库，但 fixtures 需 PO 核对）：`);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
  }
  if (plan.skipped.length) {
    console.log(`\n跳过 ${plan.skipped.length} 行（不以占位替代，见 to-po）：`);
    for (const s of plan.skipped) console.log(`  - ${s.table} ${s.id}: ${s.reason}`);
  }
} finally {
  await client.end();
}
