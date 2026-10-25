import { brandIdentifiers } from '../../../../../lib/brand';
import { brandMetadata } from '../../../../../lib/brand-meta';
import { BarRow, Dense, Head, Kpis } from '../../../../../components/atoms';

export const generateMetadata = ({ params }: { params: Promise<{ locale: string; slug: string }> }) => brandMetadata(params, 'domains');

const TYPE: Record<string, string> = { domain: '域名', mirror: '镜像', app: 'App', tg: 'TG', wallet: '钱包', phone: '电话' };

export default async function Domains({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ids = (await brandIdentifiers(slug)) ?? [];
  const official = ids.filter((i) => i.ownership === 'official');
  const fakes = ids.filter((i) => i.ownership === 'fake');
  const last = ids.map((i) => i.lastChecked).filter(Boolean).sort().pop();
  return (
    <section className="card glass rise" style={{ minHeight: 300 }}>
      <Head title="官方标识" sub="仅以此列表为准 · 其余均为非官方" />
      <Kpis
        items={[
          { v: official.length, k: '官方标识', tone: 'green' },
          { v: fakes.filter((f) => f.online).length, k: '仿冒在线', tone: fakes.length ? 'purple' : undefined },
          ...(last ? [{ v: last.slice(5), k: '最近核验' }] : []),
        ]}
      />
      {ids.length ? (
        <Dense
          items={ids}
          render={(i, k) => (
            <BarRow
              key={k}
              a={i.type === 'wallet' ? `${(i.value ?? '').slice(0, 4)}…${(i.value ?? '').slice(-4)}` : (i.value ?? '')}
              b={[i.ownership === 'fake' ? '仿冒' : TYPE[i.type ?? ''], i.chain, i.firstSeen ? `${i.firstSeen.slice(0, 7)} 起` : null, i.online === false ? '已下线' : i.online ? '在线' : null, i.note].filter(Boolean).join(' · ')}
              pct={100}
              tone={i.ownership === 'fake' ? 'purple' : i.ownership === 'official' ? 'green' : 'amber'}
              tag={i.ownership === 'fake' ? '仿冒' : i.ownership === 'official' ? TYPE[i.type ?? '']! : '待查'}
            />
          )}
        />
      ) : (
        <p className="adv">暂无收录标识。</p>
      )}
    </section>
  );
}
