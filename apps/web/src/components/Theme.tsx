'use client';
import { useEffect, useState } from 'react';

/** 主题 = <html data-accent data-bg>，默认 green × night；用户选择存 localStorage，服务端不存（D-001 补充） */
const ACCENTS = [['green', '雷达绿'], ['blue', '冰蓝'], ['gold', '香槟金']] as const;
const BGS = [['night', '夜'], ['dusk', '暮'], ['day', '日']] as const;
const KEY = 'bydp-theme';

export const THEME_BOOT = `try{var t=JSON.parse(localStorage.getItem('${KEY}')||'{}');var r=document.documentElement;if(['green','blue','gold'].includes(t.a))r.dataset.accent=t.a;if(['night','dusk','day'].includes(t.b))r.dataset.bg=t.b}catch(e){}`;

export function ThemeSwitch() {
  const [t, setT] = useState<{ a: string; b: string }>({ a: 'green', b: 'night' });
  useEffect(() => {
    const r = document.documentElement;
    setT({ a: r.dataset.accent ?? 'green', b: r.dataset.bg ?? 'night' });
  }, []);
  const apply = (n: { a: string; b: string }) => {
    const r = document.documentElement;
    r.dataset.accent = n.a;
    r.dataset.bg = n.b;
    try {
      localStorage.setItem(KEY, JSON.stringify(n));
    } catch {
      /* 隐私模式：仅本次生效 */
    }
    setT(n);
  };
  return (
    <div className="theme" role="group" aria-label="主题">
      {ACCENTS.map(([a, l]) => (
        <button key={a} type="button" aria-pressed={t.a === a} onClick={() => apply({ ...t, a })}>
          {l}
        </button>
      ))}
      {BGS.map(([b, l]) => (
        <button key={b} type="button" aria-pressed={t.b === b} onClick={() => apply({ ...t, b })}>
          {l}
        </button>
      ))}
    </div>
  );
}
