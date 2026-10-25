#!/usr/bin/env node
/**
 * A-003 C2 / ADR-0006：排序只能在 packages/scoring。core 与 apps 中不得出现按评分排序的实现
 * （SQL order by … score、数组 .sort 比较 score、自定义 rankBrands 定义）。调用 @bydp/scoring/ranking 不受限。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dirs = ['packages/core/src', 'packages/entity-graph/src', ...readdirSync(join(root, 'apps')).map((a) => `apps/${a}/src`)];
// 整文件匹配（自检 S-b：多行写法也要拦）；[\s\S]{0,160}? 限定在同一表达式附近
const RULES = [
  [/order\s+by[\s\S]{0,80}?\bscore\b/gi, 'SQL 按 score 排序'],
  [/\.sort\([\s\S]{0,160}?\bscore\b/g, '.sort 比较 score'],
  [/function\s+rank\w*\s*\(|const\s+rank\w*\s*=\s*\(/g, '自定义排序函数（应调用 @bydp/scoring/ranking）'],
];
const errs = [];
for (const d of dirs) {
  const abs = join(root, d);
  try {
    statSync(abs);
  } catch {
    continue;
  }
  (function walk(p) {
    for (const f of readdirSync(p)) {
      const q = join(p, f);
      if (statSync(q).isDirectory()) walk(q);
      else if (/\.(ts|tsx)$/.test(f)) {
        const text = readFileSync(q, 'utf8');
        for (const [re, why] of RULES)
          for (const m of text.matchAll(re)) {
            const line = text.slice(0, m.index).split('\n').length;
            errs.push(`${relative(root, q)}:${line} ${why}：${m[0].replace(/\s+/g, ' ').slice(0, 100)}`);
          }
      }
    }
  })(abs);
}
if (errs.length) {
  console.error(errs.join('\n'));
  process.exit(1);
}
console.log('排序隔离检查通过（core / apps 无评分排序实现）');
