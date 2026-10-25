'use client';
import { useLocale } from 'next-intl';
import { usePathname } from '../i18n/navigation';
import { href } from '../lib/seo';
import { Icon, type IconName } from './Icon';

/** 悬浮胶囊导航（§13）。M2 登录闭环：投诉（05，D-014）与我的均已开放。 */
const ITEMS: [string, string, IconName, boolean][] = [
  ['/', '首页', 'home', true],
  ['/certified', '名单', 'list', true],
  ['/offers', '优惠', 'offers', true],
  ['/complaint', '投诉', 'complaint', true],
  ['/me', '我的', 'me', true],
];
const LISTS = ['/certified', '/watchlist', '/licensed', '/blacklist'];

/** hideOffers：排除期用户不显示「优惠」入口（D-019） */
export function Nav({ hideOffers = false }: { hideOffers?: boolean }) {
  const path = usePathname();
  const locale = useLocale();
  return (
    <nav className="nav" aria-label="主导航">
      {ITEMS.filter(([to]) => !(hideOffers && to === '/offers')).map(([to, label, icon, enabled]) => {
        const on = to === '/' ? path === '/' : to === '/certified' ? LISTS.some((l) => path.startsWith(l)) : path.startsWith(to);
        return enabled ? (
          <a key={to} href={href(locale, to)} aria-current={on ? 'page' : undefined}>
            <Icon n={icon} s={20} w={1.9} />
            {label}
          </a>
        ) : (
          <a key={to} aria-disabled="true" title="登录后开放" style={{ opacity: 0.45 }}>
            <Icon n={icon} s={20} w={1.9} />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
