'use client';
import { useSelectedLayoutSegment } from 'next/navigation';

/** hideOffers：排除期用户不显示「优惠」分栏（D-019） */
export function BrandTabs({ base, counts, hideOffers = false }: { base: string; counts: { complaints?: number; withdrawalReports?: number; identifiers?: number; offers?: number }; hideOffers?: boolean }) {
  const seg = useSelectedLayoutSegment();
  const TABS: [string | null, string, number | null][] = [
    [null, '概览', null],
    ['complaints', '投诉', counts.complaints ?? 0],
    ['withdrawal', '出款', counts.withdrawalReports ?? 0],
    ['domains', '标识', counts.identifiers ?? 0],
    ['bonus', '优惠', counts.offers ?? 0],
  ].filter(([s]) => !(hideOffers && s === 'bonus')) as [string | null, string, number | null][];
  return (
    <nav className="seg glass rise" style={{ gridTemplateColumns: `repeat(${TABS.length},1fr)` }} aria-label="品牌页分栏">
      {TABS.map(([s, label, n]) => (
        <a key={label} href={s ? `${base}/${s}` : base} aria-current={seg === s ? 'page' : undefined}>
          {label}
          {n != null ? <small className="num">{n}</small> : null}
        </a>
      ))}
    </nav>
  );
}
