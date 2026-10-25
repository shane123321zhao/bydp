#!/usr/bin/env node
/**
 * design-system §13 / rules/design-system.md：apps/web 组件禁止写死颜色、阴影、圆角、间距（token 只在 tokens.css 定义）。
 * - 所有 .css/.tsx/.ts（tokens.css 除外）：禁止 #hex、rgb()/rgba()/hsl()/hsla() 字面色
 * - CSS 与 TSX 内联样式：margin-*、padding-*、gap、border-radius、box-shadow 的值里禁止非 0、非 1px 的 px/rem/em 字面量
 *   （百分比允许；hairline 1px 允许）。字号、宽高、定位偏移不在规则内。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// 可传入目录（apps/admin 复用本检查：node ../web/scripts/check-web-tokens.mjs src）
const root = process.argv[2] ? process.cwd() : new URL('..', import.meta.url).pathname;
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(root, 'src');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(css|tsx?)$/.test(f) && !p.endsWith('tokens.css')) files.push(p);
  }
})(SRC);

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const PROP = /(?:^|[;{\s"'])(margin(?:-\w+)?|padding(?:-\w+)?|gap|row-gap|column-gap|border-radius|box-shadow|marginTop|marginBottom|marginLeft|marginRight|paddingTop|paddingBottom|paddingLeft|paddingRight|borderRadius|boxShadow)\s*:\s*([^;}\n,]+)/g;
const LIT = /(?<![\w-])(\d*\.?\d+)(px|rem|em)\b/g;

const errors = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*(\*|\/\/).*$/, '');
    if (COLOR.test(code)) errors.push(`${relative(root, f)}:${i + 1} 字面颜色：${line.trim().slice(0, 120)}`);
    for (const m of code.matchAll(PROP)) {
      const val = m[2].replace(/var\([^)]*\)/g, '').replace(/calc\(.*\)/g, (c) => c.replace(/var\([^)]*\)/g, ''));
      for (const n of val.matchAll(LIT)) {
        if (Number(n[1]) === 0 || (n[2] === 'px' && Number(n[1]) === 1)) continue;
        errors.push(`${relative(root, f)}:${i + 1} ${m[1]} 字面值 ${n[0]}（改用 var(--s-*/--r-*/--sh-*)）`);
      }
    }
  });
}
if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} 处违反 design-system §13 token 约束`);
  process.exit(1);
}
console.log(`token 约束检查通过（${files.length} 个文件）`);
