/** 手动触发一次评分（运维 / 验证用）：pnpm --filter @bydp/worker score:once [ISO 时刻] */
import { connect } from '@bydp/core/runtime';
import { runDailyScoring } from './jobs/daily-scoring';

const at = process.argv[2] ? new Date(process.argv[2]) : new Date();
if (Number.isNaN(at.getTime())) {
  console.error(`无效时刻：${process.argv[2]}（示例：2026-09-28T02:00:00+08:00）`);
  process.exit(1);
}
const { db, client } = connect();
const r = await runDailyScoring(db, at);
console.log(JSON.stringify(r));
await client.end();
