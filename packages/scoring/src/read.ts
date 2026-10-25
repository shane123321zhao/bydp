/**
 * 只读取数（ADR-0006 第 ③ 层）：只用 bydp_scoring_ro 的 15 张白名单表 / 列；连接启动参数显式 default_transaction_read_only=on（A-003 C4）。
 * scoring 不持有写连接；快照由 apps/worker 经 core 以 bydp_app 写入。
 */
import postgres from 'postgres';
import { BLACKLIST_LINK } from './params';
import type { BrandInput } from './types';

export function connectReadOnly(url = process.env.DATABASE_URL_SCORING_RO) {
  if (!url) throw new Error('DATABASE_URL_SCORING_RO 未设置');
  return postgres(url, { max: 2, connection: { default_transaction_read_only: true, application_name: 'bydp-scoring' } });
}

type Sql = ReturnType<typeof postgres>;
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export async function loadInputs(sql: Sql): Promise<BrandInput[]> {
  const [brands, operators, firstListed, withdrawals, complaints, reviews, attributes, identifiers, links] = await Promise.all([
    sql<{ id: string; slug: string; status: BrandInput['status']; statusSince: Date; operatorId: string }[]>`
      select "id", "slug", "status", "statusSince", "operatorId" from "brand" order by "id"`,
    sql<{ id: string; foundedYear: number | null }[]>`select "id", "foundedYear" from "operator"`,
    sql<{ brandId: string; at: Date }[]>`select "brandId", min("at") as "at" from "status_history" where "brandId" is not null group by "brandId"`,
    sql<{ id: string; brandId: string; bindingId: string | null; kind: 'user' | 'official'; fromBinding: boolean; outcome: 'paid' | 'refused' | 'pending'; requestedAt: Date; receivedAt: Date | null }[]>`
      select "id", "brandId", "bindingId", "kind", "fromBinding", "outcome", "requestedAt", "receivedAt" from "withdrawal_report" where "status" = 'accepted' order by "id"`,
    sql<{ brandId: string; status: string; acceptedAt: Date | null; operatorNotifiedAt: Date | null; operatorRepliedAt: Date | null; replyDeadline: Date | null }[]>`
      select "brandId", "status", "acceptedAt", "operatorNotifiedAt", "operatorRepliedAt", "replyDeadline" from "complaint" order by "id"`,
    sql<{ brandId: string; rating: number; trustWeight: string; createdAt: Date }[]>`
      select "brandId", "rating", "trustWeight", "createdAt" from "review" where "status" = 'published' order by "id"`,
    sql<{ brandId: string; dimension: string; values: string[]; verified: boolean }[]>`
      select "brandId", "dimension", "values", "verified" from "brand_attribute" order by "brandId", "dimension"`,
    sql<{ id: string; brandId: string | null; type: string; value: string; ownership: string; online: boolean | null }[]>`
      select "id", "brandId", "type", "value", "ownership", "online" from "identifier" order by "id"`,
    sql<{ fromKind: string; fromId: string; toKind: string; toId: string; linkType: string; confidence: string; confirmedBy: string }[]>`
      select "fromKind", "fromId", "toKind", "toId", "linkType", "confidence", "confirmedBy" from "entity_link" order by "id"`,
  ]);

  const opYear = new Map(operators.map((o) => [o.id, o.foundedYear]));
  const listed = new Map(firstListed.map((f) => [f.brandId, ymd(f.at)]));
  const status = new Map(brands.map((b) => [b.id, b.status]));
  const identBrand = new Map(identifiers.map((i) => [i.id, i.brandId]));
  // 自检 I4：仿冒标识挂在受害品牌上，不参与「共用标识」判定
  const blackIdentValues = new Set(
    identifiers.filter((i) => i.brandId && i.ownership !== 'fake' && status.get(i.brandId) === 'blacklist').map((i) => `${i.type}|${i.value}`),
  );
  const strongLinks = links.filter(
    (l) =>
      !BLACKLIST_LINK.excludeLinkTypes.includes(l.linkType) &&
      (!BLACKLIST_LINK.requireHuman || l.confirmedBy === 'human') &&
      Number(l.confidence) >= BLACKLIST_LINK.minConfidence,
  );
  const brandOf = (kind: string, id: string) => (kind === 'brand' ? id : (identBrand.get(id) ?? null));
  const group = <T extends { brandId: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.brandId) (m.get(r.brandId) ?? m.set(r.brandId, []).get(r.brandId)!).push(r);
    return m;
  };
  const W = group(withdrawals);
  const C = group(complaints);
  const R = group(reviews);
  const A = group(attributes);
  const I = group(identifiers);

  return brands.map((b) => {
    const since = ymd(b.statusSince);
    const first = listed.get(b.id);
    const idents = I.get(b.id) ?? [];
    const linkedViaEdge = strongLinks.some((l) => {
      const f = brandOf(l.fromKind, l.fromId);
      const t = brandOf(l.toKind, l.toId);
      const other = f === b.id ? t : t === b.id ? f : null;
      return !!other && other !== b.id && status.get(other) === 'blacklist';
    });
    const sharesWithBlacklist = idents.some((i) => i.ownership !== 'fake' && blackIdentValues.has(`${i.type}|${i.value}`) && status.get(b.id) !== 'blacklist');
    return {
      id: b.id,
      slug: b.slug,
      status: b.status,
      statusSince: since,
      foundedYear: opYear.get(b.operatorId) ?? null,
      listedSince: first && first < since ? first : since,
      withdrawals: (W.get(b.id) ?? []).map((w) => ({
        id: w.id,
        bindingId: w.bindingId,
        kind: w.kind,
        fromBinding: w.fromBinding,
        outcome: w.outcome,
        requestedAt: new Date(w.requestedAt),
        receivedAt: w.receivedAt ? new Date(w.receivedAt) : null,
      })),
      complaints: (C.get(b.id) ?? []).map((c) => ({
        status: c.status,
        acceptedAt: c.acceptedAt ? new Date(c.acceptedAt) : null,
        operatorNotifiedAt: c.operatorNotifiedAt ? new Date(c.operatorNotifiedAt) : null,
        operatorRepliedAt: c.operatorRepliedAt ? new Date(c.operatorRepliedAt) : null,
        replyDeadline: c.replyDeadline ? new Date(c.replyDeadline) : null,
      })),
      reviews: (R.get(b.id) ?? []).map((r) => ({ rating: r.rating, trustWeight: Number(r.trustWeight), createdAt: new Date(r.createdAt) })),
      attributes: (A.get(b.id) ?? []).map((a) => ({ dimension: a.dimension, values: a.values, verified: a.verified })),
      officialDomains: idents.filter((i) => i.ownership === 'official' && (i.type === 'domain' || i.type === 'mirror')).map((i) => ({ online: i.online })),
      linkedToBlacklist: b.status !== 'blacklist' && (linkedViaEdge || sharesWithBlacklist),
    };
  });
}
