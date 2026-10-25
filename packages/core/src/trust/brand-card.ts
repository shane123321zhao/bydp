/**
 * BrandCard 组装（所有品牌出现处复用，design-system §12）：品牌 + 最新评分快照 + 牌照。
 * 读路径，bydp_app 连接；不读任何商业域数据。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { BrandCard, ScoreSnapshot } from './index';

type Reader = Pick<Db, 'execute'>;

type SnapshotRow = {
  brandId: string;
  score: number | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  factorsAvailable: number;
  factorsTotal: number;
  algorithmVersion: string;
  computedAt: Date | string;
  factors: NonNullable<ScoreSnapshot['factors']>;
};

const iso = (d: Date | string) => new Date(d).toISOString();

/** 每品牌最新一条评分快照 */
export async function latestSnapshots(db: Reader, brandIds: string[]): Promise<Map<string, SnapshotRow>> {
  if (!brandIds.length) return new Map();
  const rows = (await db.execute(sql`
    select distinct on ("brandId") "brandId", "score", "confidence", "factorsAvailable", "factorsTotal",
           "algorithmVersion", "computedAt", "factors"
    from ${schema.scoreSnapshots}
    where "brandId" in ${brandIds}
    order by "brandId", "computedAt" desc`)) as unknown as SnapshotRow[];
  return new Map(rows.map((r) => [r.brandId, r]));
}

type BrandRow = {
  id: string;
  slug: string;
  name: BrandCard['name'];
  status: BrandCard['status'];
  hasActiveExposure: boolean;
  markets: string[];
  certifiedDepositUsdt: string | number | null;
  logoUrl: string | null;
  primaryDomain: string | null;
  reviewCount: number;
};
type LicenseRow = { brandId: string; regulator: string; licenseNo: string; valid: boolean; verifiedAt: string | null };

export async function loadBrandCards(db: Reader, brandIds: string[]): Promise<Map<string, BrandCard>> {
  const ids = [...new Set(brandIds)];
  if (!ids.length) return new Map();
  // drizzle 把数组展开为参数列表 ($1, $2, …)，不拼字符串
  const list = ids;
  const brands = (await db.execute(sql`
    select b."id", b."slug", b."name", b."status", b."hasActiveExposure", b."markets", b."certifiedDepositUsdt", b."logoUrl",
           (select i."value" from ${schema.identifiers} i
             where i."brandId" = b."id" and i."primary" and i."type" = 'domain' and i."ownership" = 'official' limit 1) as "primaryDomain",
           (select count(*)::int from ${schema.reviews} r where r."brandId" = b."id") as "reviewCount"
    from ${schema.brands} b where b."id" in ${list}`)) as unknown as BrandRow[];
  // 同品牌多牌照：有效优先，其次最近核验
  const licenses = (await db.execute(sql`
    select distinct on ("brandId") "brandId", "regulator", "licenseNo", "valid", "verifiedAt"::text as "verifiedAt"
    from ${schema.licenses} where "brandId" in ${list}
    order by "brandId", "valid" desc, "verifiedAt" desc nulls last`)) as unknown as LicenseRow[];
  const lic = new Map(licenses.map((l) => [l.brandId, l]));
  const snaps = await latestSnapshots(db, ids);

  return new Map(
    brands.map((b) => {
      const s = snaps.get(b.id);
      const l = lic.get(b.id);
      const card: BrandCard = {
        id: b.id,
        slug: b.slug,
        name: b.name,
        status: b.status,
        hasActiveExposure: b.hasActiveExposure,
        markets: b.markets,
        license: l ? { regulator: l.regulator, licenseNo: l.licenseNo, valid: l.valid, ...(l.verifiedAt ? { verifiedAt: l.verifiedAt } : {}) } : null,
        // 黑名单不计分（§5）：即使快照里有分数也不对外返回
        score: s
          ? {
              score: b.status === 'blacklist' ? null : s.score,
              confidence: b.status === 'blacklist' ? 'none' : s.confidence,
              factorsAvailable: s.factorsAvailable,
              factorsTotal: s.factorsTotal,
              algorithmVersion: s.algorithmVersion,
              computedAt: iso(s.computedAt),
            }
          : null,
        certifiedDepositUsdt: b.certifiedDepositUsdt == null ? null : Number(b.certifiedDepositUsdt),
        primaryDomain: b.primaryDomain,
        logoUrl: b.logoUrl,
        reviewCount: b.reviewCount,
      };
      return [b.id, card];
    }),
  );
}
