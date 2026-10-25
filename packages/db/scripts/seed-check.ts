/** 验收：seed 后各表 count(*) 与 fixtures 条数对比；不一致列出原因并以非 0 退出。 */
import postgres from 'postgres';
import { buildSeed, fixtureCounts } from '../src/seed/build';
import { loadFixtures } from '../src/seed/load';

const fx = loadFixtures();
const expected = fixtureCounts(fx);
const { skipped } = buildSeed(fx);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 未设置');
const sql = postgres(url, { max: 1 });
let mismatch = 0;
try {
  console.log('table                 fixtures   db   结果');
  for (const [table, want] of Object.entries(expected)) {
    const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from "${table}"`);
    const n = row?.n ?? 0;
    const ok = n === want;
    if (!ok) mismatch++;
    const why = ok ? '' : `  ← ${skipped.filter((s) => s.table === table).map((s) => s.id).join(', ')}`;
    console.log(`${table.padEnd(20)} ${String(want).padStart(8)} ${String(n).padStart(5)}   ${ok ? 'OK' : 'MISMATCH'}${why}`);
  }
} finally {
  await sql.end();
}
if (mismatch) {
  console.log(`\n${mismatch} 张表条数不一致（fixtures 数据缺陷，见 mailbox/to-po.md 裁定项）`);
  process.exit(1);
}
