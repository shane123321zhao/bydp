/**
 * 跨域聚合视图：品牌详情（BrandDetail）与首页（HomePayload）。组合 trust / commerce / content，只读。
 * 首页推荐与小表盘的排序统一调用 @bydp/scoring/ranking（ADR-0006；A-003 C2）。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { Fact, TimelineEvent } from '../shared/index';
import { loadBrandCards, latestSnapshots } from '../trust/brand-card';
import { brandBySlug, libCounts, STATUS_LABEL, topCertified } from '../trust/brands';
import { resolveRate, withdrawalMedian } from '../trust/metrics';
import { rankBrands } from '@bydp/scoring/ranking';
import { getBrandOffers } from '../commerce/offers';
import type { BrandDetail, HomePayload } from './index';

/** 公开「本周热查」门槛：无风险信号的 Candidate 须近 7 日 ≥ 5 个不同网段查询过（D-016，待协调官裁定口径） */
export const PUBLIC_HOT_MIN_VIEWERS = 5;

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;
const iso = (d: Date | string) => new Date(d).toISOString();
const ymd = (d: Date | string) => iso(d).slice(0, 10);
const fmtInt = (n: number) => n.toLocaleString('en-US');

export async function getBrandDetail(db: Reader, slug: string): Promise<BrandDetail | null> {
  const b = await brandBySlug(db, slug);
  if (!b) return null;
  const card = (await loadBrandCards(db, [b.id])).get(b.id)!;
  const [op] = await q<{ legalName: string | null; jurisdiction: string | null; foundedYear: number | null; relatedParty: boolean }>(
    db,
    sql`select "legalName", "jurisdiction", "foundedYear", "relatedParty" from ${schema.operators} where "id" = ${b.operatorId}`,
  );
  const [counts] = await q<{ complaints: number; withdrawalReports: number; identifiers: number; offers: number }>(
    db,
    sql`select
      (select count(*)::int from ${schema.complaints} where "brandId" = ${b.id} and "publicSummary") as "complaints",
      (select count(*)::int from ${schema.withdrawalReports} where "brandId" = ${b.id}) as "withdrawalReports",
      (select count(*)::int from ${schema.identifiers} where "brandId" = ${b.id}) as "identifiers",
      (select count(*)::int from ${schema.offers} where "brandId" = ${b.id} and "status" = 'active' and ("validUntil" is null or "validUntil" >= current_date)) as "offers"`,
  );
  const snap = (await latestSnapshots(db, [b.id])).get(b.id);
  const tone = b.status === 'certified' ? ('green' as const) : ('amber' as const);
  const facts: Fact[] = [];
  if (b.status !== 'blacklist') {
    const wd = withdrawalMedian(snap?.factors);
    const res = resolveRate(snap?.factors);
    if (wd) facts.push({ v: wd, k: '出款中位', tone });
    if (res) facts.push({ v: res, k: '解决率', tone });
  }
  if (b.certifiedDepositUsdt != null) {
    const dep = Number(b.certifiedDepositUsdt);
    facts.push({ v: dep >= 10_000 ? `${Math.round(dep / 1_000) / 10} 万 U` : `${fmtInt(dep)} U`, k: '保证金', tone: 'green' });
  }
  const offers = (await getBrandOffers(db, slug)) ?? [];
  const sh = await q<{ to: string; reason: string | null; at: Date }>(
    db,
    sql`select "to", "reason", "at" from ${schema.statusHistory} where "brandId" = ${b.id} order by "at"`,
  );
  const statusHistory: TimelineEvent[] = sh.map((s) => ({
    date: iso(s.at),
    subject: STATUS_LABEL[s.to] ?? s.to,
    rest: s.reason ?? '',
    kind: s.to === 'blacklist' ? 'warning' : s.to === 'certified' ? 'decision' : 'info',
  }));
  return {
    ...card,
    operator: {
      legalName: op?.legalName ?? null,
      jurisdiction: op?.jurisdiction ?? null,
      foundedYear: op?.foundedYear ?? null,
      relatedParty: op?.relatedParty ?? false,
    },
    counts: counts!,
    facts,
    featuredOffer: offers.find((o) => o.exclusive) ?? null,
    statusHistory,
  };
}

export async function getHome(db: Reader, now = new Date()): Promise<HomePayload> {
  const [s] = await q<{
    brands: number;
    blacklisted: number;
    blacklistedToday: number;
    handled: number;
    resolved: number;
    closed: number;
    medianResolveDays: number | null;
    deposits: string | null;
  }>(
    db,
    sql`select
      (select count(*)::int from ${schema.brands}) as "brands",
      (select count(*)::int from ${schema.brands} where "status" = 'blacklist') as "blacklisted",
      (select count(distinct "brandId")::int from ${schema.statusHistory} where "to" = 'blacklist' and "brandId" is not null
         and "at" >= date_trunc('day', ${now.toISOString()}::timestamptz)) as "blacklistedToday",
      (select count(*)::int from ${schema.complaints} where "acceptedAt" is not null) as "handled",
      (select count(*)::int from ${schema.complaints} where "status" = 'resolved') as "resolved",
      (select count(*)::int from ${schema.complaints} where "status" in ('resolved','rejected','unresolved','exposed')) as "closed",
      (select percentile_cont(0.5) within group (order by extract(epoch from ("resolvedAt" - "acceptedAt")) / 86400)
         from ${schema.complaints} where "resolvedAt" is not null and "acceptedAt" is not null) as "medianResolveDays",
      (select sum("certifiedDepositUsdt") from ${schema.brands} where "status" = 'certified') as "deposits"`,
  );
  // 30 日累计序列（sparkline）：只用真实日期字段推导，不造数
  const series = await q<{ d: string; blacklisted: number; handled: number }>(
    db,
    sql`select to_char(d, 'YYYY-MM-DD') as "d",
        (select count(*)::int from ${schema.brands} where "status" = 'blacklist' and "statusSince" <= d::date) as "blacklisted",
        (select count(*)::int from ${schema.complaints} where "acceptedAt" < d + interval '1 day') as "handled"
      from generate_series(date_trunc('day', ${now.toISOString()}::timestamptz) - interval '29 days',
                           date_trunc('day', ${now.toISOString()}::timestamptz), interval '1 day') as d order by d`,
  );

  const [fake] = await q<{ fakeToday: number }>(
    db,
    sql`select count(*)::int as "fakeToday" from ${schema.identifiers}
        where "ownership" = 'fake' and "firstSeen" = (${now.toISOString()}::timestamptz)::date`,
  );
  const [latestFake] = await q<{ value: string; brandId: string | null }>(
    db,
    sql`select "value", "brandId" from ${schema.identifiers} where "ownership" = 'fake' order by "firstSeen" desc nulls last limit 1`,
  );

  const featuredList = await topCertified(db, 1);
  const featured = featuredList[0];
  // 小表盘 ×4：排序前三（排除主表盘品牌）+ 最近列入黑名单的一个（field-mapping 01：黑名单 score=null 指针 0 红）
  const all = await q<{ id: string; statusSince: string; status: string }>(
    db,
    sql`select "id", "statusSince"::text as "statusSince", "status" from ${schema.brands}`,
  );
  const cards = await loadBrandCards(db, all.map((a) => a.id));
  const since = new Map(all.map((a) => [a.id, a.statusSince]));
  const ranked = rankBrands(
    [...cards.values()].filter((c) => c.status !== 'blacklist' && c.id !== featured?.id).map((c) => ({ ...c, statusSince: since.get(c.id)! })),
    'score_desc',
  ).slice(0, 3);
  const lastBlack = rankBrands(
    [...cards.values()].filter((c) => c.status === 'blacklist').map((c) => ({ ...c, statusSince: since.get(c.id)! })),
    'listed_at_desc',
  )[0];
  const gauges = [...ranked, ...(lastBlack ? [lastBlack] : [])].map(({ statusSince: _s, ...c }) => c);

  // D-016：用户查询会自动建 Candidate；公开热查须有风险信号或 ≥ PUBLIC_HOT_MIN_VIEWERS 个不同网段查询过，防少量代理把任意域名刷上首页
  const hot = await q<{ value: string; type: string; queryCount7d: number }>(
    db,
    sql`select "value", "identifierType" as "type", "queryCount7d" from ${schema.candidates}
        where "status" = 'pending_review' and "identifierType" in ('domain', 'tg')
          and (jsonb_array_length("riskSignals") > 0 or "weightedPriority" >= ${PUBLIC_HOT_MIN_VIEWERS})
        order by "weightedPriority" desc, "queryCount7d" desc limit 5`, // 不公开用户查过的电话 / 钱包 / 名称
  );

  const name = (id: string | null) => (id ? (cards.get(id)?.name.zhHans ?? '') : '');
  const feedRows = [
    ...(await q<{ at: string; value: string; brandId: string | null; id: string }>(
      db,
      sql`select "firstSeen"::text as "at", "value", "brandId", "id" from ${schema.identifiers} where "ownership" = 'fake' and "firstSeen" is not null`,
    )).map((r) => ({ date: r.at, subject: r.value, rest: `冒充 ${name(r.brandId)}`, kind: 'fake' as const, ref: r.id })),
    ...(await q<{ at: Date; title: string; brandId: string; slug: string }>(
      db,
      sql`select "publishedAt" as "at", "title", "brandId", "slug" from ${schema.exposures}`,
    )).map((r) => ({ date: ymd(r.at), subject: name(r.brandId), rest: r.title, kind: 'exposed' as const, ref: cards.get(r.brandId)?.slug ?? r.slug })),
    ...(await q<{ at: Date; to: string; reason: string | null; brandId: string }>(
      db,
      sql`select "at", "to", "reason", "brandId" from ${schema.statusHistory} where "brandId" is not null and "to" in ('blacklist', 'watch')`,
    )).map((r) => ({
      date: ymd(r.at),
      subject: name(r.brandId),
      rest: r.reason ?? '',
      kind: r.to === 'blacklist' ? ('blacklist' as const) : ('watch' as const),
      ref: cards.get(r.brandId)?.slug ?? r.brandId,
    })),
    ...(await q<{ at: Date; title: string; brandId: string; id: string }>(
      db,
      sql`select "resolvedAt" as "at", "title", "brandId", "id" from ${schema.complaints} where "status" = 'resolved' and "publicSummary"`,
    )).map((r) => ({ date: ymd(r.at), subject: name(r.brandId), rest: r.title, kind: 'resolved' as const, ref: cards.get(r.brandId)?.slug ?? r.brandId })),
  ]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 10);

  const offers = featured ? ((await getBrandOffers(db, featured.slug)) ?? []) : [];
  const content = await q<{ type: 'lab' | 'guide'; title: string; slug: string | null }>(
    db,
    sql`select "type", "title", "slug" from ${schema.contents}
        where "type" in ('lab', 'guide') and "locale" = 'zh-Hans' and "publishedAt" is not null order by "publishedAt" desc limit 2`,
  );

  return {
    stats: {
      brandsIndexed: s!.brands,
      blacklisted: s!.blacklisted,
      blacklistedToday: s!.blacklistedToday,
      complaintsHandled: s!.handled,
      ...(s!.closed ? { resolveRate: s!.resolved / s!.closed } : {}),
      ...(s!.medianResolveDays != null ? { medianResolveDays: Math.round(Number(s!.medianResolveDays) * 10) / 10 } : {}),
      certifiedDepositsUsdt: Number(s!.deposits ?? 0),
      series: { blacklisted: series.map((r) => r.blacklisted), complaintsHandled: series.map((r) => r.handled) },
    },
    alerts: {
      fakeToday: fake!.fakeToday,
      ...(latestFake ? { latestFake: { value: latestFake.value, impersonates: name(latestFake.brandId) } } : {}),
    },
    ...(featured ? { featured } : {}),
    gauges,
    libs: await libCounts(db),
    hotCandidates: hot,
    feed: feedRows,
    ...(offers.find((o) => o.exclusive) ? { featuredOffer: offers.find((o) => o.exclusive)! } : {}),
    content: content.map((c) => ({ type: c.type, title: c.title, ...(c.slug ? { slug: c.slug } : {}) })),
    me: null, // M2：登录态
  };
}
