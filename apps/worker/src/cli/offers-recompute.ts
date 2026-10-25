/**
 * D-029：按当前参数表版本（architecture §8.1）全量重算优惠真实价值。
 * 用法：tsx src/cli/offers-recompute.ts [--dry-run]   （服务器上在 worker 容器内执行）
 * 只改与当前公式结果不一致的行，每行写 audit（执行身份 system:tv-recompute）；类型不支持 / 条款不完整的列出原因、不改动。
 */
import { connect } from '@bydp/core/runtime';
import { recomputeTrueValues } from '@bydp/core/commerce/true-value-recompute';

const dry = process.argv.includes('--dry-run');
const { db, client } = connect();
let code = 0;
try {
  await db.transaction(async (tx) => {
    const r = await recomputeTrueValues(tx, { id: 'system:tv-recompute', role: 'admin', ip: null }, { write: !dry });
    console.log(`${dry ? '🔍 预检（未写入）' : '✅ 重算完成'} ｜ 参数表 ${r.version} · 优惠 ${r.total} 条 · ${dry ? '将更新' : '已更新'} ${r.changed.length} · 无变化 ${r.unchanged} · 跳过 ${r.skipped.length}`);
    for (const c of r.changed) console.log(`   ${c.id}：净值 ${String(c.from)} → ${c.to}`);
    for (const s of r.skipped) console.log(`⚠️ ${s.id} 跳过：${s.reason}`);
  });
} catch (e) {
  console.log(`❌ ${(e as Error).message.slice(0, 300)}`);
  code = 1;
} finally {
  await client.end();
}
process.exit(code);
