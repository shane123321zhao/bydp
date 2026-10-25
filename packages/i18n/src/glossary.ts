/**
 * 术语表（架构 §11 / ADR-0004 · rules/i18n.md：术语表真源 = packages/i18n/glossary/*.json）。
 * 文件格式：[{ "hans": "简体", "hant": "台湾繁体", "hk"?: ["港澳口径词"], "en"?: "English", "note"?: "说明" }]。OpenCC 只做初转，术语表条目优先。
 * hk：港澳口径词（ADR-0004：不单独成路径，只作 Meilisearch 搜索同义词，D-019）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type GlossaryEntry = { hans: string; hant: string; hk?: string[]; en?: string; note?: string };

export const GLOSSARY_DIR = fileURLToPath(new URL('../glossary', import.meta.url));

export function loadGlossary(dir = GLOSSARY_DIR): GlossaryEntry[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: GlossaryEntry[] = [];
  for (const f of files) {
    const rows = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
    if (!Array.isArray(rows)) throw new Error(`术语表 ${f} 须为数组`);
    for (const r of rows as GlossaryEntry[]) {
      if (typeof r?.hans !== 'string' || typeof r?.hant !== 'string' || !r.hans || !r.hant) throw new Error(`术语表 ${f} 条目缺 hans / hant`);
      if (r.hk !== undefined && (!Array.isArray(r.hk) || r.hk.some((x) => typeof x !== 'string' || !x))) throw new Error(`术语表 ${f} 条目 hk 须为非空字符串数组`);
      out.push(r);
    }
  }
  return out;
}
