/**
 * 搜索归一（架构 §16 / ADR-0005：索引与查询均经 OpenCC 归一到简体）：NFKC → 台繁词组（twp）与港繁（hk）→ 简体 → 小写、压空白。
 * 同一函数用于建索引与查询，繁体 / 港澳写法与简体落到同一字面。
 */
import * as OpenCC from 'opencc-js';
import type { GlossaryEntry } from '@bydp/i18n/glossary';

let tw: ((s: string) => string) | null = null;
let hk: ((s: string) => string) | null = null;

export function toHans(s: string): string {
  tw ??= OpenCC.ConverterFactory(OpenCC.Locale.from.twp!, OpenCC.Locale.to.cn!);
  hk ??= OpenCC.ConverterFactory(OpenCC.Locale.from.hk!, OpenCC.Locale.to.cn!);
  return hk(tw(s));
}

export function normalizeSearch(s: string): string {
  return toHans(s.normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 港澳同义词（术语表 hk 列）→ Meilisearch synonyms：简体词与各港澳词（均归一后）互为同义 */
export function synonymsFromGlossary(entries: GlossaryEntry[]): Record<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!e.hk?.length) continue;
    const base = normalizeSearch(e.hans);
    const g = groups.get(base) ?? new Set([base]);
    for (const w of e.hk) g.add(normalizeSearch(w));
    groups.set(base, g);
  }
  const out: Record<string, string[]> = {};
  for (const g of groups.values()) {
    const words = [...g].filter(Boolean);
    if (words.length < 2) continue;
    for (const w of words) out[w] = [...new Set([...(out[w] ?? []), ...words.filter((x) => x !== w)])];
  }
  return out;
}
