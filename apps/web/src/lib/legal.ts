/**
 * 法务页正文（D-021）：读取仓库 docs/legal/<名称>-draft.md（PO 审定后的版本即真源；镜像内随代码一起，不经数据库）。
 * 运行期按需读取（页面 force-dynamic），首个 # 标题由页面头部承担，正文从其后开始。
 */
import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseMarkdown } from '../components/Markdown';

const NAMES = { terms: 'terms-draft.md', privacy: 'privacy-policy-draft.md' } as const;

function legalDir(): string {
  // 从运行目录（apps/web）向上找仓库根的 docs/legal
  for (let d = process.cwd(), i = 0; i < 6; d = dirname(d), i++) {
    const p = join(d, 'docs', 'legal');
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 docs/legal');
}

export function loadLegal(name: keyof typeof NAMES) {
  const blocks = parseMarkdown(readFileSync(join(legalDir(), NAMES[name]), 'utf8'));
  const first = blocks[0];
  return first && first.t === 'h' && first.level === 1 ? blocks.slice(1) : blocks;
}
