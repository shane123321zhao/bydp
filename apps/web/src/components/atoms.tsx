import type { BrandCard as Card } from '@bydp/core/trust';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

type Tone = 'neutral' | 'red' | 'amber' | 'green' | 'purple' | 'muted' | 'accent';
export const toneVar = (t: Tone | undefined) =>
  t === 'neutral' || !t ? 'var(--ink)' : t === 'muted' ? 'var(--muted)' : `var(--${t})`;

/** 评分环（表盘替代，§13）：≥75 绿、其余琥珀；黑名单 ✕ 红；无分 — */
export function Ring({ score, black, size = 64, stroke = 5 }: { score: number | null | undefined; black?: boolean; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const val = black ? 100 : (score ?? 0);
  const color = black ? 'var(--red)' : score == null ? 'var(--muted)' : score >= 75 ? 'var(--green)' : 'var(--amber)';
  const label = black ? '黑名单不计分' : score == null ? '暂无评分' : `评分 ${score}`;
  return (
    <span role="img" aria-label={label} style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
        {score == null && !black ? null : (
          <circle
            className="ring"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            style={{ ['--full' as string]: c, ['--to' as string]: c * (1 - val / 100), strokeDashoffset: c * (1 - val / 100) }}
          />
        )}
      </svg>
      <span className="num" aria-hidden style={{ fontSize: Math.round(size * 0.32), fontWeight: 700, color, lineHeight: 1 }}>
        {black ? '✕' : (score ?? '—')}
      </span>
    </span>
  );
}

/** Logo：logoUrl 缺素材（全部演示品牌）→ 首字字标（field-mapping v1.3） */
export function Logo({ b, size = 44 }: { b: Pick<Card, 'name' | 'status'>; size?: number }) {
  const cls = b.status === 'blacklist' ? 'logo bl' : b.status === 'watch' ? 'logo watch' : 'logo';
  return (
    <span className={cls} style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }} aria-hidden>
      {(b.name.zhHans ?? b.name.en ?? '?').slice(0, 1)}
    </span>
  );
}

export function StatusBadge({ b }: { b: Pick<Card, 'status' | 'hasActiveExposure'> }) {
  if (b.status === 'blacklist') return <span className="badge b-red">黑名单</span>;
  if (b.status === 'certified')
    return (
      <span className="badge b-green">
        <Icon n="shield" s={10} w={2.6} />
        认证
      </span>
    );
  if (b.hasActiveExposure) return <span className="badge b-red">曝光中</span>;
  return <span className="badge b-amber">观察</span>;
}

export function Head({ title, sub, link }: { title: string; sub?: string; link?: ReactNode }) {
  return (
    <div className="head">
      <div>
        <h2 className="title" style={{ margin: 0 }}>
          {title}
          {sub ? <small>{sub}</small> : null}
        </h2>
      </div>
      {link}
    </div>
  );
}

export function Stat({ v, k, tone }: { v: ReactNode; k: string; tone?: Tone }) {
  return (
    <div className="stat">
      <b className="num" style={{ color: toneVar(tone) }}>
        {v}
      </b>
      <span>{k}</span>
    </div>
  );
}

export function Facts({ facts }: { facts: { v?: string; k?: string; tone?: Tone }[] }) {
  if (!facts.length) return null;
  return (
    <div className="facts">
      {facts.map((f, i) => (
        <div key={i} style={{ border: '1px solid var(--gb)' }}>
          <Stat v={f.v} k={f.k ?? ''} tone={f.tone} />
        </div>
      ))}
    </div>
  );
}

/**
 * dense 列表（design-system §11/§12）：默认显示 3 条；剩余 ≤ 1 条直接全显，否则折叠为「还有 N 条 ›」。
 * 用原生 <details>，无 JS 也可展开。
 */
export function Dense<T>({ items, limit = 3, render }: { items: T[]; limit?: number; render: (x: T, i: number) => ReactNode }) {
  const need = items.length - limit > 1;
  if (!need) return <>{items.map(render)}</>;
  return (
    <>
      {items.slice(0, limit).map(render)}
      <details className="more">
        <summary>还有 {items.length - limit} 条 ›</summary>
        {items.slice(limit).map((x, i) => render(x, i + limit))}
      </details>
    </>
  );
}

export function Timeline({ events }: { events: { date?: string; subject?: string; rest?: string; kind?: 'info' | 'decision' | 'warning' }[] }) {
  const dt = (k?: string) => (k === 'warning' ? 'var(--red)' : k === 'decision' ? 'var(--green)' : 'var(--muted)');
  return (
    <div className="tl">
      <Dense
        items={events}
        render={(e, i) => (
          <div key={i} className="e" style={{ ['--dt' as string]: dt(e.kind) }}>
            <span className="num" style={{ color: 'var(--muted)', fontSize: 12 }}>
              {e.date ? e.date.slice(5, 10) : ''}
            </span>
            <span className="t">
              <b style={{ color: e.kind === 'warning' ? 'var(--red)' : 'var(--ink)' }}>{e.subject}</b> {e.rest}
            </span>
          </div>
        )}
      />
    </div>
  );
}

export function Legal({ links }: { links: [string, string][] }) {
  return (
    <footer className="legal">
      <span className="b">18+</span>
      <span>不向中国大陆居民提供服务</span>
      {links.map(([label, href]) => (
        <a key={href} href={href}>
          {label}
        </a>
      ))}
    </footer>
  );
}

export const fmtUsdt = (n: number) => n.toLocaleString('en-US');
export const zhName = (b: Pick<Card, 'name'>) => b.name.zhHans ?? b.name.en ?? '';

/** 带进度条的列表行（原型 s2 行）：主体 ink + 说明 body + 条 + 右侧标签 */
/** link：行尾行内链接（D-024「玩家评价」行「写评价」），样式沿用 .link */
export function BarRow({ a, b, pct, tone, tag, link }: { a: string; b?: string; pct?: number; tone: Tone; tag: string; link?: ReactNode }) {
  return (
    <div className="row" style={{ gridTemplateColumns: link ? '1fr auto auto' : '1fr auto', minHeight: 52 }}>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <span className="s">
          <b>{a}</b> {b}
        </span>
        {pct != null ? (
          <div className="bar">
            <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: toneVar(tone) }} />
          </div>
        ) : null}
      </div>
      {link}
      <span className={`badge b-${tone === 'neutral' ? 'muted' : tone}`}>{tag}</span>
    </div>
  );
}

export function Kpis({ items }: { items: { v: ReactNode; k: string; tone?: Tone }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 'var(--s-4)', marginBottom: 'var(--s-4)' }}>
      {items.map((x, i) => (
        <div key={i} style={{ borderRadius: 'var(--r-lg)', background: 'var(--well)', border: '1px solid var(--gb)', padding: 'var(--s-5)' }}>
          <Stat v={x.v} k={x.k} tone={x.tone} />
        </div>
      ))}
    </div>
  );
}
