/**
 * 品牌页 GET /brands/{slug} + 子资源（field-mapping 03）；名单 GET /lists/{lib}（field-mapping 04）。只读。
 */
import { searchBrandIds, searchCaseIds } from '../search/index';
import { schema, sql, type Db } from '@bydp/db';
import type { Fact } from '../shared/index';
import type { ComplaintPage } from '../complaint/index';
import { loadBrandCards, latestSnapshots } from './brand-card';
import { rankBrands, type RankSort } from '@bydp/scoring/ranking';
import { publicFactors, resolveRate, withdrawalMedian } from './metrics';
import type { BrandCard, Identifier, ListPage, ScoreSnapshot, WithdrawalStats } from './index';

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;
const iso = (d: Date | string) => new Date(d).toISOString();
const fmtInt = (n: number) => n.toLocaleString('en-US');

export type BrandRow = {
  id: string;
  slug: string;
  status: 'certified' | 'watch' | 'blacklist';
  statusSince: string;
  operatorId: string;
  certifiedDepositUsdt: string | null;
};

export async function brandBySlug(db: Reader, slug: string): Promise<BrandRow | null> {
  const [b] = await q<BrandRow>(
    db,
    sql`select "id", "slug", "status", "statusSince"::text as "statusSince", "operatorId", "certifiedDepositUsdt"
        from ${schema.brands} where "slug" = ${slug}`,
  );
  return b ?? null;
}

const STATUS_LABEL: Record<string, string> = { certified: '通过认证', watch: '收录观察', blacklist: '列入黑名单' };
export { STATUS_LABEL };

export async function getBrandScore(db: Reader, slug: string): Promise<ScoreSnapshot | null> {
  const b = await brandBySlug(db, slug);
  if (!b) return null;
  const s = (await latestSnapshots(db, [b.id])).get(b.id);
  if (!s) return { score: null, confidence: 'none', factorsAvailable: 0, factorsTotal: 5, factors: [] };
  return {
    score: b.status === 'blacklist' ? null : s.score, // 黑名单不计分
    confidence: b.status === 'blacklist' ? 'none' : s.confidence,
    factorsAvailable: s.factorsAvailable,
    factorsTotal: s.factorsTotal,
    algorithmVersion: s.algorithmVersion,
    computedAt: iso(s.computedAt),
    // 黑名单不计分：因子分数一并置空，只保留明细文本（审查 #1）
    factors: publicFactors(b.status === 'blacklist' ? s.factors.map((f) => ({ ...f, score: null })) : s.factors),
  };
}

// ---------------------------------------------------------------------------
// 投诉 Tab（公开案件）

const PAGE = 20;
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  return at && id && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}

export async function getBrandComplaints(db: Reader, slug: string, cursor?: string, query?: string): Promise<ComplaintPage | null> {
  const b = await brandBySlug(db, slug);
  if (!b) return null;
  const cur = decodeCursor(cursor);
  // D-019：投诉 Tab 搜索——只在该品牌已公开案件的公开标题 / 公开描述中搜（索引不含原文）；结果仍按时间倒序；KPI 为品牌整体
  const hit = query?.trim() ? await searchCaseIds(db, query, { brandId: b.id, limit: 1000 }) : null;
  const rows = await q<{
    id: string;
    title: string;
    category: 'refused' | 'delay' | 'frozen' | 'bonus' | 'closed';
    status: 'screening' | 'accepted' | 'awaiting_reply' | 'arbitrating' | 'resolved' | 'rejected' | 'unresolved' | 'exposed';
    amountUsdt: string;
    createdAt: Date;
    resolvedAt: Date | null;
    exposedAt: Date | null;
  }>(
    db,
    sql`select "id", "title", "category", "status", "amountUsdt", "createdAt", "resolvedAt", "exposedAt"
        from ${schema.complaints}
        where "brandId" = ${b.id} and "publicSummary"
          ${hit ? sql`and "id" in ${hit.length ? hit : ['']}` : sql``}
          ${cur ? sql`and ("createdAt", "id") < (${cur.at}::timestamptz, ${cur.id})` : sql``}
        order by "createdAt" desc, "id" desc limit ${PAGE + 1}`,
  );
  const [stats] = await q<{ total: number; resolved: number; closed: number; medianDays: number | null }>(
    db,
    sql`select count(*)::int as "total",
               count(*) filter (where "status" = 'resolved')::int as "resolved",
               count(*) filter (where "status" in ('resolved', 'rejected', 'unresolved', 'exposed'))::int as "closed",
               percentile_cont(0.5) within group (order by extract(epoch from ("operatorRepliedAt" - "operatorNotifiedAt")) / 86400)
                 filter (where "operatorRepliedAt" is not null and "operatorNotifiedAt" is not null) as "medianDays"
        from ${schema.complaints} where "brandId" = ${b.id} and "publicSummary"`,
  );
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    stats: {
      total: stats!.total,
      // 解决率 = 已解决 / 已结案（解决、驳回、未解决、曝光）；无结案时不给值
      ...(stats!.closed ? { resolveRate: stats!.resolved / stats!.closed } : {}),
      ...(stats!.medianDays != null ? { medianResponseDays: Math.round(Number(stats!.medianDays) * 10) / 10 } : {}),
    },
    items: page.map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      status: c.status,
      amountUsdt: Number(c.amountUsdt),
      createdAt: iso(c.createdAt),
      resolvedAt: c.resolvedAt ? iso(c.resolvedAt) : null,
      exposedAt: c.exposedAt ? iso(c.exposedAt) : null,
    })),
    next: rows.length > PAGE && last ? encodeCursor(iso(last.createdAt), last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// 出款 Tab

export async function getBrandWithdrawals(db: Reader, slug: string): Promise<WithdrawalStats | null> {
  const b = await brandBySlug(db, slug);
  if (!b) return null;
  const rows = await q<{ id: string; kind: 'user' | 'official'; method: string; amountUsdt: string; requestedAt: Date; receivedAt: Date | null; outcome: string }>(
    db,
    sql`select "id", "kind", "method", "amountUsdt", "requestedAt", "receivedAt", "outcome" from ${schema.withdrawalReports}
        where "brandId" = ${b.id} order by "requestedAt" desc`,
  );
  const mins = (r: (typeof rows)[number]) => (new Date(r.receivedAt!).getTime() - new Date(r.requestedAt).getTime()) / 60_000;
  const paid = rows.filter((r) => r.outcome === 'paid' && r.receivedAt);
  const decided = rows.filter((r) => r.outcome === 'paid' || r.outcome === 'refused');
  const sorted = paid.map(mins).sort((a, b2) => a - b2);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
  const BUCKETS: [string, (m: number) => boolean][] = [
    ['≤ 1 小时', (m) => m <= 60],
    ['1–24 小时', (m) => m > 60 && m <= 1440],
    ['1–3 天', (m) => m > 1440 && m <= 4320],
    ['> 3 天', (m) => m > 4320],
  ];
  const buckets = [
    ...BUCKETS.map(([label, f]) => {
      const count = paid.filter((r) => f(mins(r))).length;
      return { label, count, share: decided.length ? count / decided.length : 0 };
    }),
    (() => {
      const count = rows.filter((r) => r.outcome === 'refused').length;
      return { label: '拒付', count, share: decided.length ? count / decided.length : 0 };
    })(),
  ];
  return {
    ...(median != null ? { medianMinutes: Math.round(median) } : {}),
    ...(decided.length ? { refusalRate: rows.filter((r) => r.outcome === 'refused').length / decided.length } : {}),
    sampleSize: rows.filter((r) => r.kind === 'user').length,
    buckets,
    officialChecks: rows
      .filter((r) => r.kind === 'official')
      .map((r) => ({
        id: r.id,
        method: r.method,
        amountUsdt: Number(r.amountUsdt),
        ...(r.receivedAt ? { minutes: Math.round(mins(r)) } : {}),
        at: iso(r.requestedAt),
      })),
  };
}

// ---------------------------------------------------------------------------
// 标识 Tab

export async function getBrandIdentifiers(db: Reader, slug: string): Promise<Identifier[] | null> {
  const b = await brandBySlug(db, slug);
  if (!b) return null;
  const rows = await q<Identifier & { firstSeen: string | null; lastChecked: string | null; online: boolean | null }>(
    db,
    sql`select "id", "type", "value", "ownership", "chain", "firstSeen"::text as "firstSeen", "lastChecked"::text as "lastChecked",
               "online", "note"
        from ${schema.identifiers} where "brandId" = ${b.id}
        order by "primary" desc, ("ownership" = 'official') desc, "firstSeen"`,
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    value: r.value,
    ownership: r.ownership,
    chain: r.chain ?? null,
    ...(r.firstSeen ? { firstSeen: r.firstSeen } : {}),
    ...(r.lastChecked ? { lastChecked: r.lastChecked } : {}),
    ...(r.online != null ? { online: r.online } : {}),
    note: r.note ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 名单页（四库）

const LIB_META = {
  certified: '经 BYDP 领码绑定后享先行赔付保障；排序只按公开评分。',
  watch: '观察库品牌可发优惠码但强制风险标签、不享赔付。有曝光案件者以红标提示。',
  licensed: '持牌 ≠ 可信：持牌品牌同样按履约评分，也可能进入黑名单。',
  blacklist: '黑名单永不接入商业合作，不计评分。运营商可随时提交答辩。',
} as const;
export type Lib = keyof typeof LIB_META;

export async function libCounts(db: Reader) {
  const [c] = await q<{ certified: number; watch: number; blacklist: number; licensed: number }>(
    db,
    sql`select count(*) filter (where "status" = 'certified')::int as "certified",
               count(*) filter (where "status" = 'watch')::int as "watch",
               count(*) filter (where "status" = 'blacklist')::int as "blacklist",
               (select count(distinct "brandId")::int from ${schema.licenses} where "valid") as "licensed"
        from ${schema.brands}`,
  );
  return c!;
}

export async function getList(
  db: Reader,
  lib: Lib,
  opts: { region?: string; sort?: RankSort; cursor?: string; q?: string } = {},
): Promise<ListPage> {
  const sort: RankSort = opts.sort ?? (lib === 'blacklist' ? 'listed_at_desc' : 'score_desc');
  // D-019：名单页搜索——Meilisearch（不可用时 pg）给候选品牌，再按本库条件与排序口径过滤；KPI / 计数按搜索后的结果
  const hit = opts.q?.trim() ? await searchBrandIds(db, opts.q, lib === 'licensed' ? { limit: 1000 } : { limit: 1000, status: lib }) : null;
  if (hit && !hit.length) return { lib, counts: await libCounts(db), kpi: await listKpi(db, lib, []), note: LIB_META[lib], items: [], next: null };
  const rows = await q<{ id: string; statusSince: string }>(
    db,
    sql`select b."id", b."statusSince"::text as "statusSince" from ${schema.brands} b
        where ${
          lib === 'licensed'
            ? sql`exists (select 1 from ${schema.licenses} l where l."brandId" = b."id" and l."valid")`
            : sql`b."status" = ${lib}`
        }
        ${opts.region ? sql`and ${opts.region} = any(b."markets")` : sql``}
        ${hit ? sql`and b."id" in ${hit}` : sql``}`,
  );
  const cards = await loadBrandCards(db, rows.map((r) => r.id));
  const since = new Map(rows.map((r) => [r.id, r.statusSince]));
  const ranked = rankBrands(
    [...cards.values()].map((c) => ({ ...c, statusSince: since.get(c.id)! })),
    sort,
  );
  const summary = await summaryLines(db, lib, ranked);
  const offset = opts.cursor ? Math.max(0, Number.parseInt(Buffer.from(opts.cursor, 'base64url').toString(), 10) || 0) : 0;
  const page = ranked.slice(offset, offset + PAGE);
  return {
    lib,
    counts: await libCounts(db),
    kpi: await listKpi(db, lib, ranked),
    note: LIB_META[lib],
    items: page.map(({ statusSince: _s, ...c }) => ({ ...c, ...(summary.get(c.id) ? { summaryLine: summary.get(c.id)! } : {}) })),
    next: offset + PAGE < ranked.length ? Buffer.from(String(offset + PAGE)).toString('base64url') : null,
  };
}

async function listKpi(db: Reader, lib: Lib, items: (BrandCard & { statusSince: string })[]): Promise<Fact[]> {
  const n = items.length;
  const scored = items.map((i) => i.score?.score).filter((s): s is number => s != null);
  const avg = scored.length ? String(Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)) : null;
  const ids = items.map((i) => i.id);
  if (lib === 'certified') {
    const dep = items.reduce((s, i) => s + (i.certifiedDepositUsdt ?? 0), 0);
    return [
      { v: String(n), k: '本筛选', tone: 'neutral' },
      ...(avg ? [{ v: avg, k: '平均分', tone: 'green' as const }] : []),
      { v: dep >= 10_000 ? `${Math.round(dep / 10_000)} 万` : fmtInt(dep), k: '保证金 U', tone: 'neutral' },
    ];
  }
  if (lib === 'watch')
    return [
      { v: String(n), k: '本筛选', tone: 'neutral' },
      ...(avg ? [{ v: avg, k: '平均分', tone: 'amber' as const }] : []),
      { v: String(items.filter((i) => i.hasActiveExposure).length), k: '曝光中', tone: 'red' },
    ];
  if (lib === 'licensed') {
    const [r] = ids.length
      ? await q<{ regulators: number; last: string | null }>(
          db,
          sql`select count(distinct "regulator")::int as "regulators", to_char(max("verifiedAt"), 'MM-DD') as "last"
              from ${schema.licenses} where "valid" and "brandId" in ${ids}`,
        )
      : [{ regulators: 0, last: null }];
    return [
      { v: String(n), k: '本筛选', tone: 'neutral' },
      { v: String(r!.regulators), k: '监管机构', tone: 'neutral' },
      ...(r!.last ? [{ v: r!.last, k: '最近核验', tone: 'neutral' as const }] : []),
    ];
  }
  // 黑名单：含换皮站 = 黑名单品牌名下经 same_template 关联确认的标识数；今日 = 今日列入黑名单的品牌数
  const [r] = await q<{ reskins: number; today: number }>(
    db,
    sql`select
      (select count(distinct i."id")::int from ${schema.identifiers} i
         join ${schema.entityLinks} l on l."linkType" = 'same_template' and (l."fromId" = i."id" or l."toId" = i."id")
         join ${schema.brands} b on b."id" = i."brandId" and b."status" = 'blacklist') as "reskins",
      (select count(distinct "brandId")::int from ${schema.statusHistory}
         where "to" = 'blacklist' and "brandId" is not null and "at" >= date_trunc('day', now())) as "today"`,
  );
  return [
    { v: String(n), k: '本筛选', tone: 'red' },
    { v: String(r!.reskins), k: '含换皮站', tone: 'red' },
    { v: `+${r!.today}`, k: '今日', tone: 'red' },
  ];
}

/** 名单行副行：认证 / 观察 = 因子摘要；黑名单 = 案件数 · 被困金额 · 列入日期（field-mapping 04） */
async function summaryLines(db: Reader, lib: Lib, items: (BrandCard & { statusSince: string })[]): Promise<Map<string, string>> {
  const ids = items.map((i) => i.id);
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const snaps = await latestSnapshots(db, ids);
  const expo = await q<{ brandId: string; cases: number; total: string | null }>(
    db,
    sql`select e."brandId",
               (select count(*)::int from ${schema.exposureComplaints} ec
                  join ${schema.exposures} e2 on e2."id" = ec."exposureId" where e2."brandId" = e."brandId") as "cases",
               sum(e."totalClaimedUsdt") as "total"
        from ${schema.exposures} e where e."brandId" in ${ids} group by e."brandId"`,
  );
  const ex = new Map(expo.map((e) => [e.brandId, e]));
  for (const i of items) {
    if (i.status === 'blacklist' || lib === 'blacklist') {
      const e = ex.get(i.id);
      const parts = [e ? `${e.cases} 起曝光案件` : null, e?.total ? `被困 ${fmtInt(Number(e.total))} U` : null, `${i.statusSince} 列入`];
      out.set(i.id, parts.filter(Boolean).join(' · '));
    } else {
      const f = snaps.get(i.id)?.factors;
      const wd = withdrawalMedian(f);
      const res = resolveRate(f);
      const line = [wd ? `出款中位 ${wd}` : null, res ? `解决率 ${res}` : null].filter(Boolean).join(' · ');
      if (line) out.set(i.id, line);
    }
  }
  return out;
}

/** 同类可信 / 首页推荐：认证库排序后取前 N（排除指定品牌） */
export async function topCertified(db: Reader, limit: number, excludeBrandId = ''): Promise<BrandCard[]> {
  const rows = await q<{ id: string; statusSince: string }>(
    db,
    sql`select "id", "statusSince"::text as "statusSince" from ${schema.brands} where "status" = 'certified' and "id" <> ${excludeBrandId}`,
  );
  const cards = await loadBrandCards(db, rows.map((r) => r.id));
  const since = new Map(rows.map((r) => [r.id, r.statusSince]));
  return rankBrands([...cards.values()].map((c) => ({ ...c, statusSince: since.get(c.id)! })), 'score_desc')
    .slice(0, limit)
    .map(({ statusSince: _s, ...c }) => c);
}

/** /disclosure：关联方品牌公开披露（ADR-0003；relatedParty 挂 Operator，品牌继承） */
export async function getRelatedPartyBrands(db: Reader): Promise<{ slug: string; name: string }[]> {
  const rows = await q<{ slug: string; name: string }>(
    db,
    sql`select b."slug", b."name"->>'zhHans' as "name" from ${schema.brands} b
        join ${schema.operators} o on o."id" = b."operatorId" where o."relatedParty" order by b."slug"`,
  );
  return rows;
}
