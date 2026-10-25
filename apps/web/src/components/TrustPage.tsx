import type { ReactNode } from 'react';
import { href } from '../lib/seo';
import { Icon } from './Icon';
import { Legal } from './atoms';

/** 信任页外壳（E-E-A-T）。正文取自已定稿的架构 / ADR，对外发布前由主编 / 合规审定（架构 §13）。 */
export function TrustPage({ locale, title, sub, children }: { locale: string; title: string; sub: string; children: ReactNode }) {
  const L = (p: string) => href(locale, p);
  return (
    <main>
      <header className="hdr">
        <a className="back" href={L('/')} aria-label="返回首页">
          <Icon n="back" />
        </a>
        <div className="hdr-t">
          <h1 style={{ margin: 0, fontSize: 17 }}>{title}</h1>
          <small>{sub}</small>
        </div>
      </header>
      <article className="card glass first rise prose">{children}</article>
      <Legal
        links={[
          ['服务地区', L('/regions')],
          ['评分方法', L('/methodology')],
          ['认证标准', L('/certification')],
          ['官方渠道', L('/official')],
          ['联盟披露', L('/disclosure')],
          ['服务条款', L('/terms')],
          ['隐私政策', L('/privacy-policy')],
        ]}
      />
    </main>
  );
}
