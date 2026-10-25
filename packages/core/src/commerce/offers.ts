/**
 * 优惠 GET /offers、/brands/{slug}/offers（field-mapping 07）。只读。
 * 黑名单品牌永不接入（§3 杀手锏 2）：一律过滤。非认证商家强制风险标签。
 */
import { schema, sql, type Db } from '@bydp/db';
import { loadBrandCards } from '../trust/brand-card';
import type { Offer, OffersPage } from './index';

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;

type OfferRow = {
  id: string;
  brandId: string;
  title: string;
  type: string;
  terms: NonNullable<Offer['terms']>;
  trueValue: NonNullable<Offer['trueValue']>;
  exclusive: boolean;
  sponsored: boolean;
  riskLabel: string | null;
  compensationEligible: boolean;
  validUntil: string | null;
  claimedCount: number;
};

const NON_CERTIFIED_RISK = '非认证商家：不享先行赔付保障';
const GAME = { sports: '体育', live: '真人百家乐', slots: '老虎机' } as const;

async function loadOffers(db: Reader, where: ReturnType<typeof sql>): Promise<Offer[]> {
  const rows = await q<OfferRow>(
    db,
    sql`select o."id", o."brandId", o."title", o."type", o."terms", o."trueValue", o."exclusive", o."sponsored", o."riskLabel",
               o."compensationEligible", o."validUntil"::text as "validUntil",
               -- field-mapping v1.6：已领码 = 带该 offer 专属码的 Click 数（24h 同用户去重由 tracking claimOffer 写入时保证）；PromoCode.claimedCount 不作真源
               (select count(*) from ${schema.clicks} c join ${schema.promoCodes} p on p."id" = c."promoCodeId" where p."offerId" = o."id")::int as "claimedCount"
        from ${schema.offers} o join ${schema.brands} b on b."id" = o."brandId"
        -- A-018：只展示上线中的 Offer（黑名单连带下线后解除黑名单也不自动恢复）；品牌状态过滤保留作纵深
        where o."status" = 'active' and b."status" <> 'blacklist' and (o."validUntil" is null or o."validUntil" >= current_date) and ${where}
        order by (o."trueValue"->>'netExpectedValueUsdt')::numeric desc, o."id"`,
  );
  const cards = await loadBrandCards(db, rows.map((r) => r.brandId));
  return rows.map((r) => {
    const brand = cards.get(r.brandId)!;
    const certified = brand.status === 'certified';
    return {
      id: r.id,
      brand,
      title: r.title,
      type: r.type,
      terms: r.terms,
      trueValue: r.trueValue,
      exclusive: r.exclusive,
      sponsored: r.sponsored,
      // 非认证强制风险标签、不享赔付——以品牌当前状态为准，不信任存量字段
      riskLabel: certified ? r.riskLabel : (r.riskLabel ?? NON_CERTIFIED_RISK),
      compensationEligible: certified && r.compensationEligible,
      claimedCount: r.claimedCount,
      ...(r.validUntil ? { validUntil: r.validUntil } : {}),
    };
  });
}

/** 领码返回用的风险标签：与列表同口径（以品牌当前状态为准；非认证强制风险标签） */
export async function getOfferRiskLabel(db: Reader, offerId: string): Promise<string | null> {
  const [r] = await q<{ riskLabel: string | null; status: string }>(
    db,
    sql`select o."riskLabel", b."status" from ${schema.offers} o join ${schema.brands} b on b."id" = o."brandId" where o."id" = ${offerId}`,
  );
  if (!r) return null;
  return r.status === 'certified' ? r.riskLabel : (r.riskLabel ?? NON_CERTIFIED_RISK);
}

export async function getBrandOffers(db: Reader, slug: string): Promise<Offer[] | null> {
  const [b] = await q<{ id: string }>(db, sql`select "id" from ${schema.brands} where "slug" = ${slug}`);
  if (!b) return null;
  return loadOffers(db, sql`o."brandId" = ${b.id}`);
}

export type OfferFilter = 'all' | 'cert' | 'pos' | 'sports' | 'live' | 'slots';

export async function getOffers(db: Reader, filter: OfferFilter = 'all', cursor?: string): Promise<OffersPage> {
  const where =
    filter === 'cert'
      ? sql`b."status" = 'certified'`
      : filter === 'pos'
        ? sql`(o."trueValue"->>'netExpectedValueUsdt')::numeric > 0`
        : filter === 'all'
          ? sql`true`
          : sql`o."terms"->'eligibleGames' ? ${GAME[filter]}`;
  const all = await loadOffers(db, where);
  const everything = filter === 'all' ? all : await loadOffers(db, sql`true`);
  const PAGE = 20;
  const offset = cursor ? Math.max(0, Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) || 0) : 0;
  return {
    stats: {
      positive: everything.filter((o) => (o.trueValue?.netExpectedValueUsdt ?? 0) > 0).length,
      subsidy: everything.filter((o) => (o.trueValue?.netExpectedValueUsdt ?? 0) <= 0).length,
      claimed: everything.reduce((s, o) => s + (o.claimedCount ?? 0), 0),
    },
    items: all.slice(offset, offset + PAGE),
    next: offset + PAGE < all.length ? Buffer.from(String(offset + PAGE)).toString('base64url') : null,
  };
}
