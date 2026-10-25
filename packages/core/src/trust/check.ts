/**
 * GET /check 用例（架构 §9.1；field-mapping 02；设计基准 prototype CHECK 表）。
 * 只读：M1 不写 Candidate（查询计数 / 入队属写路径，随限流一起在 M3 做）。
 *
 * 数据来源说明（未能直接映射到结构化字段的，见 to-po）：
 * - 认证 / 观察态三事实取自 score_snapshot.factors[].metrics（scoring 结构化输出，A-003 C3）。
 * - 未收录态「域名注册天数」在 §7 无字段（WHOIS），不输出，不占位。
 */
import { decideVerdict, detect, skeleton, type Normalized, type Ownership, type Verdict } from '@bydp/entity-graph';
import { schema, sql, type Db } from '@bydp/db';
import type { Fact, TimelineEvent } from '../shared/index';
import { loadBrandCards, latestSnapshots } from './brand-card';
import { topCertified as rankedCertified } from './brands';
import { publicFactors, refusalRate, resolveRate, withdrawalMedian } from './metrics';
import type { BrandCard, CheckResult, EntityLinkRow, Identifier } from './index';
import { searchBrandIds } from '../search/index';

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;

type IdentRow = {
  id: string;
  brandId: string | null;
  type: Identifier['type'];
  value: string;
  ownership: Ownership;
  chain: string | null;
  firstSeen: string | null;
  lastChecked: string | null;
  online: boolean | null;
  note: string | null;
  primary: boolean;
};
type BrandRow = { id: string; status: 'certified' | 'watch' | 'blacklist'; statusSince: string; operatorId: string; name: BrandCard['name'] };

const SEVERITY: Record<Verdict, number> = { blacklist: 4, fake: 3, watch: 2, unknown: 1, certified: 0 };
const DAY = 86_400_000;
const days = (from: string, to: Date) => Math.floor((to.getTime() - new Date(from).getTime()) / DAY);
const fmtInt = (n: number) => n.toLocaleString('en-US');
const zh = (n: BrandCard['name'] | undefined) => n?.zhHans ?? n?.en ?? '';

const IDENT_COLS = sql`"id", "brandId", "type", "value", "ownership", "chain", "firstSeen"::text as "firstSeen",
  "lastChecked"::text as "lastChecked", "online", "note", "primary"`;

async function findIdentifiers(db: Reader, n: Normalized): Promise<IdentRow[]> {
  const types = n.type === 'domain' ? ['domain', 'mirror'] : [n.type];
  return q<IdentRow>(db, sql`select ${IDENT_COLS} from ${schema.identifiers} where "type" in ${types} and lower("value") = lower(${n.value})`);
}

async function findBrandByName(db: Reader, name: string): Promise<BrandRow | null> {
  const rows = await q<BrandRow>(
    db,
    sql`select "id", "status", "statusSince"::text as "statusSince", "operatorId", "name" from ${schema.brands}
        where ${name} in ("name"->>'zhHans', "name"->>'zhHant', lower("name"->>'en'), "slug") or lower(${name}) = lower("name"->>'en')
        limit 1`,
  );
  return rows[0] ?? null;
}

/** 形近官方标识（trgm 预筛 + skeleton 精判） */
async function findLookalikeOfficial(db: Reader, n: Normalized): Promise<IdentRow | null> {
  if (n.type !== 'domain') return null;
  const rows = await q<IdentRow>(
    db,
    sql`select ${IDENT_COLS} from ${schema.identifiers}
        where "ownership" = 'official' and "type" in ('domain', 'mirror') and similarity("value", ${n.value}) > 0.2
        order by similarity("value", ${n.value}) desc limit 20`,
  );
  const sk = skeleton(n.value);
  return rows.find((r) => r.value !== n.value && skeleton(r.value) === sk) ?? null;
}

export async function checkIdentifier(db: Reader, query: string, now = new Date()): Promise<CheckResult> {
  const n = detect(query);
  const base = { query, normalized: { type: n.type, value: n.value }, checkedAt: now.toISOString() };

  // 1) 标识精确匹配（同一值可挂多个品牌，如共用收款地址：取最严重的判定）
  let ident: IdentRow | null = null;
  let brand: BrandRow | null = null;
  const hits = n.type === 'name' ? [] : await findIdentifiers(db, n);
  if (hits.length) {
    const brandRows = await q<BrandRow>(
      db,
      sql`select "id", "status", "statusSince"::text as "statusSince", "operatorId", "name" from ${schema.brands}
          where "id" in ${hits.map((h) => h.brandId ?? '')}`,
    );
    const byId = new Map(brandRows.map((b) => [b.id, b]));
    const ranked = hits
      .map((h) => ({ h, b: h.brandId ? (byId.get(h.brandId) ?? null) : null }))
      .map((x) => ({ ...x, v: decideVerdict({ ownership: x.h.ownership, brandStatus: x.b?.status ?? null }) }))
      .sort((a, b) => SEVERITY[b.v] - SEVERITY[a.v]);
    ident = ranked[0]!.h;
    brand = ranked[0]!.b;
  } else if (n.type === 'name') {
    brand = await findBrandByName(db, n.value);
  }

  const verdict: Verdict = ident
    ? decideVerdict({ ownership: ident.ownership, brandStatus: brand?.status ?? null })
    : brand
      ? brand.status
      : 'unknown';

  if (verdict === 'unknown') return unknownResult(db, n, base);
  // 仿冒标识未挂品牌（brandId 可空）：只输出标识自身事实（审查 #6）
  if (verdict === 'fake' && !brand) {
    const d = ident!.firstSeen ? days(ident!.firstSeen, now) : null;
    return {
      ...base,
      verdict,
      matchNote: '仿冒标识 · 被冒充对象待确认',
      brand: null,
      operatorName: null,
      facts: compact([d == null ? null : { v: d < 30 ? '< 30 天' : `${d} 天`, k: '首次发现', tone: 'neutral' as const }]),
      timeline: await fakeTimeline(db, ident!),
      alternative: await topCertified(db, ''),
    };
  }

  const b = brand!;
  const cards = await loadBrandCards(db, [b.id]);
  const card = cards.get(b.id)!;
  const [op] = await q<{ legalName: string | null }>(db, sql`select "legalName" from ${schema.operators} where "id" = ${b.operatorId}`);
  const brandIdents = await q<IdentRow>(db, sql`select ${IDENT_COLS} from ${schema.identifiers} where "brandId" = ${b.id}`);

  const result: CheckResult = {
    ...base,
    verdict,
    matchNote: matchNote(verdict, ident, b),
    brand: card,
    operatorName: op?.legalName ?? null,
    facts: [],
    // 仿冒态：时间线只讲这个仿冒标识（首次发现 / 关联确认），不混入被冒充品牌的历史
    timeline: verdict === 'fake' && ident ? await fakeTimeline(db, ident) : await timeline(db, b, ident, brandIdents),
  };

  if (verdict === 'blacklist') {
    result.facts = await blacklistFacts(db, b, brandIdents);
    result.related = await relatedRows(db, b, brandIdents);
  } else if (verdict === 'watch') {
    const f = (await latestSnapshots(db, [b.id])).get(b.id)?.factors;
    result.facts = compact([fact(refusalRate(f), '拒付率', 'red'), fact(withdrawalMedian(f), '出款中位', 'amber'), fact(resolveRate(f), '仲裁解决率', 'amber')]);
    result.related = await relatedRows(db, b, brandIdents);
  } else if (verdict === 'certified') {
    const snap = (await latestSnapshots(db, [b.id])).get(b.id);
    const f = snap?.factors;
    result.facts = compact([fact(withdrawalMedian(f), '出款中位到账', 'green'), fact(resolveRate(f), '仲裁解决率', 'green'), fact(refusalRate(f), '拒付率', 'neutral')]);
    result.factors = publicFactors(snap?.factors) as NonNullable<CheckResult['factors']>;
  } else if (verdict === 'fake') {
    const [link] = await q<{ confidence: string }>(
      db,
      sql`select "confidence" from ${schema.entityLinks}
          where "linkType" = 'impersonates' and "fromKind" = 'identifier' and "fromId" = ${ident!.id} order by "confidence" desc limit 1`,
    );
    const officials = brandIdents.filter((i) => i.ownership === 'official');
    const d = ident!.firstSeen ? days(ident!.firstSeen, now) : null;
    result.facts = compact([
      link ? { v: `${Math.round(Number(link.confidence) * 100)}%`, k: '仿冒置信度', tone: 'purple' as const } : null,
      // design-system §14：数据源是 Identifier.firstSeen（首次发现），WHOIS 注册日待 Candidate.domainRegisteredAt（M3）
      d == null ? null : { v: d < 30 ? '< 30 天' : `${d} 天`, k: '首次发现', tone: 'neutral' as const },
      { v: `${officials.length} 个`, k: '官方标识', tone: 'green' as const },
    ]);
    result.officialIdentifiers = officials.filter((i) => i.type !== 'wallet').map(toIdentifier);
    result.brand = { ...card, score: card.score ? { ...card.score, score: null } : null }; // 非官方标识不计分
  }

  if (verdict !== 'certified') result.alternative = await topCertified(db, b.id);
  return result;
}

// ---------------------------------------------------------------------------

type Base = { query: string; normalized: { type: string; value: string }; checkedAt: string };

async function unknownResult(db: Reader, n: Normalized, base: Base): Promise<CheckResult> {
  const [cand] = await q<{
    id: string;
    queryCount7d: number;
    weightedPriority: string;
    firstQueried: string;
    riskSignals: { signal: string; detail?: string; severity?: 'low' | 'medium' | 'high'; source?: string }[];
  }>(
    db,
    sql`select "id", "queryCount7d", "weightedPriority", "firstQueried"::text as "firstQueried", "riskSignals"
        from ${schema.candidates} where "identifierType" = ${n.type === 'name' ? 'domain' : n.type} and lower("value") = lower(${n.value}) limit 1`,
  );
  const look = await findLookalikeOfficial(db, n);
  const riskSignals = [...(cand?.riskSignals ?? [])];
  let lookBrand: BrandCard | undefined;
  if (look?.brandId) {
    lookBrand = (await loadBrandCards(db, [look.brandId])).get(look.brandId);
    // 形近官方域名但未经人工确认 → 不直接判"假"，作为高危信号（§13：仿冒判定待人工确认）
    riskSignals.unshift({ signal: `与 ${zh(lookBrand?.name)} 官方域名 ${look.value} 形近`, severity: 'high', source: 'entity-graph' });
  }
  const timelineEv: TimelineEvent[] = cand
    ? [{ date: new Date(cand.firstQueried).toISOString(), subject: '首次被查', rest: '进入 Candidate 队列', kind: 'info' }]
    : [];
  return {
    ...base,
    verdict: 'unknown',
    matchNote: '未收录 · 待核验',
    brand: null,
    operatorName: null,
    facts: compact([
      cand ? { v: `${cand.queryCount7d} 次`, k: '本周查询', tone: 'neutral' as const } : null,
      riskSignals.length ? { v: `${riskSignals.length} 项`, k: '风险信号', tone: 'amber' as const } : null,
    ]),
    riskSignals,
    timeline: timelineEv,
    candidate: cand ? { id: cand.id, queryCount7d: cand.queryCount7d, weightedPriority: Number(cand.weightedPriority) } : null,
    alternative: await topCertified(db, look?.brandId ?? ''),
    suggestions: await suggestBrands(db, n.value),
  };
}

/**
 * D-019：未精确命中时的模糊候选（Meilisearch，不可用时降级 pg_trgm）。只作「你是不是要找」，判定仍是 unknown（五态不变）。
 * 最多 5 个，按相关度；品牌卡含自身状态（黑名单候选同样列出）。
 */
async function suggestBrands(db: Reader, value: string): Promise<BrandCard[]> {
  const ids = (await searchBrandIds(db, value, { limit: 5 })).slice(0, 5);
  if (!ids.length) return [];
  const cards = await loadBrandCards(db, ids);
  return ids.map((id) => cards.get(id)).filter((c): c is BrandCard => !!c);
}

function matchNote(v: Verdict, ident: IdentRow | null, b: BrandRow): string {
  const kind = ident ? (ident.type === 'mirror' ? '镜像域名' : ident.type === 'domain' ? '官方域名' : '官方标识') : '品牌名称';
  switch (v) {
    case 'blacklist':
      return ident?.note ? `标识匹配 · ${zh(b.name)}${ident.note.replace(/域名$/, '').replace(/^跑路后/, '')}域名` : `${kind} · 黑名单`;
    case 'certified':
      return `${kind} · ${ident?.primary ? '主站' : '认证库'}`;
    case 'watch':
      return `${kind} · 观察库`;
    case 'fake':
      return '形近标识 · 非官方';
    default:
      return '未收录 · 待核验';
  }
}

function fact(v: string | null, k: string, tone: NonNullable<Fact['tone']>): Fact | null {
  return v ? { v, k, tone } : null;
}
const compact = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x != null);

async function blacklistFacts(db: Reader, b: BrandRow, idents: IdentRow[]): Promise<Fact[]> {
  // 同类投诉：案件聚合（D-003：来自 Complaint，不来自曝光标题）
  const [c] = await q<{ n: number; related: number | null }>(
    db,
    sql`select count(*)::int as n, max("relatedComplaintCount") as related from ${schema.complaints} where "brandId" = ${b.id} and "publicSummary"`,
  );
  const [e] = await q<{ total: string | null }>(db, sql`select sum("totalClaimedUsdt") as total from ${schema.exposures} where "brandId" = ${b.id}`);
  // 原站存活：最早官方域名 firstSeen → 列入黑名单日（field-mapping：Identifier.firstSeen→lastChecked 派生月数；已下线站以 statusSince 截止）
  const first = idents
    .filter((i) => i.ownership === 'official' && (i.type === 'domain' || i.type === 'mirror') && i.firstSeen)
    .map((i) => i.firstSeen!)
    .sort()[0];
  const months = first ? Math.round(days(first, new Date(b.statusSince)) / 30.44) : null;
  const count = Math.max(c?.n ?? 0, c?.related ?? 0);
  return compact([
    count ? { v: `${count} 起`, k: '同类投诉', tone: 'red' as const } : null,
    e?.total ? { v: fmtInt(Number(e.total)), k: '申报被困 USDT', tone: 'red' as const } : null,
    months != null ? { v: `${months} 个月`, k: '原站存活', tone: 'neutral' as const } : null,
  ]);
}

/** 关联行：品牌 / 其标识为端点的 EntityLink + 与他品牌共用的标识（如收款地址） */
async function relatedRows(db: Reader, b: BrandRow, idents: IdentRow[]): Promise<EntityLinkRow[]> {
  const identIds = idents.map((i) => i.id);
  const ends = [b.id, ...identIds];
  const links = await q<{
    fromKind: 'brand' | 'identifier';
    fromId: string;
    toKind: 'brand' | 'identifier';
    toId: string;
    linkType: EntityLinkRow['linkType'];
    confidence: string;
    confirmedBy: 'agent' | 'human';
    evidence: string | null;
  }>(db, sql`select "fromKind", "fromId", "toKind", "toId", "linkType", "confidence", "confirmedBy", "evidence"
             from ${schema.entityLinks} where "fromId" in ${ends} or "toId" in ${ends} order by "confidence" desc`);

  const otherIdentIds = links.flatMap((l) => (ends.includes(l.fromId) ? [l] : [])).filter((l) => l.toKind === 'identifier').map((l) => l.toId);
  const otherIdentIds2 = links.filter((l) => !ends.includes(l.fromId) && l.fromKind === 'identifier').map((l) => l.fromId);
  const otherBrandIds = links
    .map((l) => (ends.includes(l.fromId) ? { k: l.toKind, id: l.toId } : { k: l.fromKind, id: l.fromId }))
    .filter((x) => x.k === 'brand')
    .map((x) => x.id);
  const identMap = new Map(
    (
      await q<IdentRow>(db, sql`select ${IDENT_COLS} from ${schema.identifiers} where "id" in ${[...otherIdentIds, ...otherIdentIds2, '']}`)
    ).map((i) => [i.id, i]),
  );

  // 共用标识（同 type+value 挂在其他品牌上）
  const shared = await q<IdentRow & { otherBrandId: string }>(
    db,
    sql`select ${sql.raw('a."id", a."brandId", a."type", a."value", a."ownership", a."chain", a."firstSeen"::text as "firstSeen", a."lastChecked"::text as "lastChecked", a."online", a."note", a."primary"')},
               o."brandId" as "otherBrandId"
        from ${schema.identifiers} a join ${schema.identifiers} o on o."type" = a."type" and o."value" = a."value" and o."brandId" <> a."brandId"
        where a."brandId" = ${b.id}`,
  );
  const cards = await loadBrandCards(db, [...otherBrandIds, ...shared.map((s) => s.otherBrandId)]);

  const rows: EntityLinkRow[] = [];
  for (const l of links) {
    const other = ends.includes(l.fromId) ? { k: l.toKind, id: l.toId } : { k: l.fromKind, id: l.fromId };
    if (ends.includes(other.id)) {
      // 两端都属本品牌（如原域名 ↔ 重开域名）：展示非查询端
      const i = idents.find((x) => x.id === l.fromId);
      if (i) rows.push(linkRow(l, i.value, 'identifier', i.id));
      continue;
    }
    if (other.k === 'brand') {
      const c = cards.get(other.id);
      if (c) rows.push(linkRow(l, zh(c.name), 'brand', c.slug));
    } else {
      const i = identMap.get(other.id);
      if (i) rows.push(linkRow(l, i.value, 'identifier', i.id));
    }
  }
  for (const s of shared) {
    const c = cards.get(s.otherBrandId);
    // 只取这两个品牌之间的关联边（审查 #7）；没有边时同值本身是事实，置信 1、不标人工确认
    const brandLink = links.find(
      (l) =>
        l.linkType === 'shared_wallet' &&
        ((l.fromId === b.id && l.toId === s.otherBrandId) || (l.toId === b.id && l.fromId === s.otherBrandId)),
    );
    rows.push({
      subject: s.value,
      subjectType: 'identifier',
      subjectRef: s.id,
      linkType: s.type === 'wallet' ? 'shared_wallet' : 'shared_support',
      confidence: brandLink ? Number(brandLink.confidence) : 1,
      ...(brandLink ? { confirmedBy: brandLink.confirmedBy } : {}),
      evidence: `${s.chain ? s.chain + ' ' : ''}${s.type === 'wallet' ? '收款地址' : '标识'} · 同时被${zh(c?.name)}使用`,
      tag: s.type === 'wallet' ? '钱包' : s.type,
    });
  }
  // 去重（同 subject 保留置信度最高者）
  const seen = new Map<string, EntityLinkRow>();
  for (const r of rows) if (!seen.has(r.subject!) || (seen.get(r.subject!)!.confidence ?? 0) < (r.confidence ?? 0)) seen.set(r.subject!, r);
  return [...seen.values()].sort((a, b2) => (b2.confidence ?? 0) - (a.confidence ?? 0));
}

function linkRow(
  l: { linkType: EntityLinkRow['linkType']; confidence: string; confirmedBy: 'agent' | 'human'; evidence: string | null },
  subject: string,
  subjectType: 'identifier' | 'brand',
  subjectRef: string,
): EntityLinkRow {
  return {
    subject,
    subjectType,
    subjectRef,
    linkType: l.linkType,
    confidence: Number(l.confidence),
    confirmedBy: l.confirmedBy,
    ...(l.evidence ? { evidence: l.evidence } : {}),
  };
}

const toIdentifier = (i: IdentRow): Identifier => ({
  id: i.id,
  type: i.type,
  value: i.value,
  ownership: i.ownership,
  chain: i.chain,
  ...(i.firstSeen ? { firstSeen: i.firstSeen } : {}),
  ...(i.lastChecked ? { lastChecked: i.lastChecked } : {}),
  ...(i.online != null ? { online: i.online } : {}),
  note: i.note,
});

const STATUS_LABEL: Record<string, string> = { certified: '通过认证', watch: '收录观察', blacklist: '列入黑名单' };

async function timeline(db: Reader, b: BrandRow, ident: IdentRow | null, idents: IdentRow[]): Promise<TimelineEvent[]> {
  const ev: TimelineEvent[] = [];
  const sh = await q<{ to: string; reason: string | null; at: Date }>(
    db,
    sql`select "to", "reason", "at" from ${schema.statusHistory} where "brandId" = ${b.id} order by "at"`,
  );
  for (const s of sh)
    ev.push({
      date: new Date(s.at).toISOString(),
      subject: STATUS_LABEL[s.to] ?? s.to,
      rest: s.reason ?? '',
      kind: s.to === 'blacklist' ? 'warning' : s.to === 'certified' ? 'decision' : 'info',
    });
  const cps = await q<{ id: string; title: string; createdAt: Date; resolvedAt: Date | null; exposedAt: Date | null }>(
    db,
    sql`select "id", "title", "createdAt", "resolvedAt", "exposedAt" from ${schema.complaints}
        where "brandId" = ${b.id} and "publicSummary" order by "createdAt"`,
  );
  for (const c of cps) {
    ev.push({ date: new Date(c.createdAt).toISOString(), subject: `投诉 #${c.id}`, rest: c.title, kind: 'info' });
    if (c.exposedAt) ev.push({ date: new Date(c.exposedAt).toISOString(), subject: '转曝光', rest: `案件 #${c.id}`, kind: 'warning' });
    if (c.resolvedAt) ev.push({ date: new Date(c.resolvedAt).toISOString(), subject: '已解决', rest: `案件 #${c.id}`, kind: 'decision' });
  }
  const ends = [b.id, ...idents.map((i) => i.id)];
  const links = await q<{ confirmedAt: Date | null; evidence: string | null; confirmedBy: string }>(
    db,
    sql`select "confirmedAt", "evidence", "confirmedBy" from ${schema.entityLinks}
        where ("fromId" in ${ends} or "toId" in ${ends}) and "confirmedAt" is not null`,
  );
  for (const l of links)
    ev.push({ date: new Date(l.confirmedAt!).toISOString(), subject: l.confirmedBy === 'human' ? '人工确认关联' : '发现关联', rest: l.evidence ?? '', kind: 'info' });
  if (ident?.firstSeen && ident.ownership !== 'official')
    ev.push({ date: new Date(ident.firstSeen).toISOString(), subject: '首次发现', rest: ident.value, kind: 'warning' });
  else if (ident?.firstSeen && ident.note)
    ev.push({ date: new Date(ident.firstSeen).toISOString(), subject: '发现新域名', rest: `${ident.value} · ${ident.note}`, kind: 'info' });
  return ev.sort((a, b2) => (a.date! < b2.date! ? -1 : 1));
}

/** 同类可信 Top1：统一走 trust/brands.topCertified（临时排序，A-003 签核后换 scoring） */
async function topCertified(db: Reader, excludeBrandId: string): Promise<BrandCard | null> {
  return (await rankedCertified(db, 1, excludeBrandId))[0] ?? null;
}

async function fakeTimeline(db: Reader, ident: IdentRow): Promise<TimelineEvent[]> {
  const ev: TimelineEvent[] = [];
  if (ident.firstSeen) ev.push({ date: new Date(ident.firstSeen).toISOString(), subject: '首次发现', rest: ident.note ?? ident.value, kind: 'warning' });
  const links = await q<{ confirmedAt: Date | null; confirmedBy: string; evidence: string | null; confidence: string }>(
    db,
    sql`select "confirmedAt", "confirmedBy", "evidence", "confidence" from ${schema.entityLinks}
        where ("fromId" = ${ident.id} or "toId" = ${ident.id}) and "confirmedAt" is not null order by "confirmedAt"`,
  );
  for (const l of links)
    ev.push({
      date: new Date(l.confirmedAt!).toISOString(),
      subject: l.confirmedBy === 'human' ? '人工确认' : '发现关联',
      rest: `${l.evidence ?? ''} · 置信 ${Math.round(Number(l.confidence) * 100)}%`,
      kind: 'decision',
    });
  return ev.sort((a, b2) => (a.date! < b2.date! ? -1 : 1));
}
