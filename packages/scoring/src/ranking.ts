/**
 * 排序规则（ADR-0006：排序与评分同属 scoring、同版本、规则公开）。自 core/ranking-provisional 迁入（A-003 C2）。
 * score_desc = score 降序（null 置后）→ confidence 降序 → statusSince 升序 → slug；listed_at_desc = statusSince 降序 → slug。
 * 赞助位不参与排序。泛型：不依赖调用方类型。
 */
import { ALGORITHM_VERSION } from './params';

/** 与评分同一版本号（C1：只在 params.ts 维护一处） */
export const RANKING_VERSION = ALGORITHM_VERSION;
/** 码位比较：不依赖运行环境的 ICU 区域设置（自检 S-d，确定性） */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export type RankSort = 'score_desc' | 'listed_at_desc';
type Rankable = { slug: string; statusSince: string; score?: { score?: number | null; confidence?: 'none' | 'low' | 'medium' | 'high' } | null };

const CONF = { high: 3, medium: 2, low: 1, none: 0 } as const;

export function rankBrands<T extends Rankable>(items: T[], sort: RankSort): T[] {
  const out = [...items];
  if (sort === 'listed_at_desc') return out.sort((a, b) => cmp(b.statusSince, a.statusSince) || cmp(a.slug, b.slug));
  return out.sort((a, b) => {
    const sa = a.score?.score ?? null;
    const sb = b.score?.score ?? null;
    if (sa !== sb) return sa == null ? 1 : sb == null ? -1 : sb - sa;
    return CONF[b.score?.confidence ?? 'none'] - CONF[a.score?.confidence ?? 'none'] || cmp(a.statusSince, b.statusSince) || cmp(a.slug, b.slug);
  });
}
