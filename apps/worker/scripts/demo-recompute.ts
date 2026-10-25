/**
 * 方案 A：在「base + demo」库上用 scoring 重算（只读角色、固定时刻 DEMO_AT），把结果回写 fixtures 快照。
 * 分数只来自重算，不手改（PO 裁定 2026-09-27）。用法：
 *   DATABASE_URL_SCORING_RO=... pnpm demo:recompute          # 回写 fixtures
 *   DATABASE_URL_SCORING_RO=... pnpm demo:verify             # CI：只核对，不写（base + demo 库重算 = fixtures 快照）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeAll } from '@bydp/scoring';

const DEMO_AT = new Date('2026-09-23T02:00:00Z'); // 与 packages/db/src/seed/demo.ts 的 DEMO_AT 一致
const file = join(import.meta.dirname, '..', '..', '..', 'docs', 'design', 'fixtures', 'trust.json');
const fx = JSON.parse(readFileSync(file, 'utf8')) as { scoreSnapshots: unknown[] } & Record<string, unknown>;
const snaps = await computeAll(DEMO_AT);
const next = snaps.map((s) => ({
  brandId: s.brandId,
  algorithmVersion: s.algorithmVersion,
  computedAt: s.computedAt.toISOString().replace('.000Z', 'Z'),
  score: s.score,
  confidence: s.confidence,
  factorsAvailable: s.factorsAvailable,
  factorsTotal: s.factorsTotal,
  factors: s.factors,
}));
if (process.argv.includes('--verify')) {
  const want = JSON.stringify(fx.scoreSnapshots);
  const got = JSON.stringify(next);
  if (want !== got) {
    console.error('demo 重算结果与 fixtures 快照不一致：请运行 pnpm demo:recompute 并审阅差异');
    process.exit(1);
  }
  console.log(`demo 重算核对通过（${next.length} 个品牌）`);
  process.exit(0);
}
fx.scoreSnapshots = next;
writeFileSync(file, JSON.stringify(fx, null, 2) + '\n');
for (const s of snaps) console.log(s.brandId.padEnd(14), String(s.score).padStart(5), s.confidence.padEnd(7), `${s.factorsAvailable}/5`);
