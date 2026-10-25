/**
 * 法务页的最小 Markdown 渲染（D-021）：只支持草稿用到的子集——# 标题（可带 {#锚点}）、段落、- / 1. 列表、> 引用、表格、**粗体**、`代码`、[链接](地址)。
 * 不输出任何原始 HTML（项目禁止 dangerouslySetInnerHTML），全部生成 React 元素；链接只允许站内相对路径（按当前语言加前缀）与 https。
 */
import type { ReactNode } from 'react';

type Block =
  | { t: 'h'; level: number; text: string; id?: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'table'; head: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*?)(?:\s*\{#([a-z0-9-]+)\})?\s*$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]!.length, text: h[2]!, ...(h[3] ? { id: h[3] } : {}) });
      i++;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push({ t: 'quote', lines: q });
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (m) {
          items.push(m[3]!);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]!) && items.length) {
          items[items.length - 1] += ' ' + lines[i++]!.trim(); // 续行 / 子项并入上一项
        } else break;
      }
      out.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|>|\||\s*([-*]|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    if (para.length) out.push({ t: 'p', text: para.join(' ') });
    else i++;
  }
  return out;
}

/** 行内：**粗体** · `代码` · [文字](地址)；其余按纯文本 */
function inline(text: string, L: (p: string) => string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{inline(m[1], L, k)}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else {
      const url = m[4]!;
      const safe = /^\/(?!\/)/.test(url) ? L(url.split('#')[0]!) + (url.includes('#') ? `#${url.split('#')[1]}` : '') : /^https:\/\//.test(url) ? url : null;
      out.push(
        safe ? (
          <a key={k} href={safe} {...(safe.startsWith('https://') ? { rel: 'noopener noreferrer', target: '_blank' } : {})}>
            {m[3]}
          </a>
        ) : (
          m[3]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ blocks, L }: { blocks: Block[]; L: (p: string) => string }) {
  return (
    <>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'h':
            return b.level <= 2 ? (
              <h2 key={k} id={b.id}>
                {inline(b.text, L, k)}
              </h2>
            ) : (
              <h3 key={k} id={b.id}>
                {inline(b.text, L, k)}
              </h3>
            );
          case 'p':
            return <p key={k}>{inline(b.text, L, k)}</p>;
          case 'ul':
            return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, L, `${k}-${j}`)}</li>)}</ul>;
          case 'ol':
            return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, L, `${k}-${j}`)}</li>)}</ol>;
          case 'quote':
            return <blockquote key={k}>{b.lines.map((l, j) => <p key={j}>{inline(l, L, `${k}-${j}`)}</p>)}</blockquote>;
          case 'table':
            return (
              <div key={k} style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>{b.head.map((h, j) => <th key={j}>{inline(h, L, `${k}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c, L, `${k}-${j}-${x}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}
