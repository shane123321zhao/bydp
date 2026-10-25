/**
 * @bydp/scoring — 评分 + 排序引擎（ADR-0006）。依赖只有 postgres；不依赖 @bydp/core / @bydp/db / @bydp/tracking。
 * 每日 02:00 由 apps/worker 调 computeAll，结果经 core 以 bydp_app 写入 score_snapshot。
 */
import { computeBrand } from './compute';
import { connectReadOnly, loadInputs } from './read';
import type { Snapshot } from './types';

export * from './params';
export * from './types';
export { computeBrand } from './compute';
export { capPerBinding, timeScore } from './factors';
export { rankBrands, RANKING_VERSION, type RankSort } from './ranking';
export { connectReadOnly, loadInputs } from './read';

/** 全量重算（确定性：同一库状态 + 同一 computedAt → 同一结果，按 brandId 排序） */
export async function computeAll(computedAt: Date, url?: string): Promise<Snapshot[]> {
  const sql = connectReadOnly(url);
  try {
    const inputs = await loadInputs(sql);
    return inputs.map((b) => computeBrand(b, computedAt)).sort((a, b) => (a.brandId < b.brandId ? -1 : a.brandId > b.brandId ? 1 : 0));
  } finally {
    await sql.end();
  }
}
