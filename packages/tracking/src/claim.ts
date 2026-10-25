/**
 * 领码（A-007 §2）：前置校验 → 写 Click（24h 幂等）→ 生成跳转链接。
 * 跳转链接两层防开放跳转（A-007 F1）：DB 层形状 CHECK + 主机触发器（迁移 0005）；本层用 WHATWG `new URL()` 解析
 * **替换后的**链接，复核 hostname（去 www.）属于品牌**当前** ownership=official 的 domain / mirror 标识——
 * 标识后来被改为仿冒或删除时，不再返回跳转链接，只返回码。
 */
import { schema, sql, type Db } from '@bydp/db';
import { TrackingError } from './errors';
import { CLAIM_DEDUPE_HOURS } from './params';
import { rows, type Exec } from './rows';

export type ClaimInput = {
  /** 由会话注入，禁止取自请求体 */
  userId: string;
  offerId: string;
  slot?: string | null;
  channel?: string | null;
  /** 取 CF-IPCountry */
  region?: string | null;
  partnerId?: string | null;
};

export type ClaimResult = {
  clickId: string;
  /** true = 24h 内重复领码，返回既有 Click */
  reused: boolean;
  /** 自动发放类优惠无码（null） */
  code: string | null;
  /** 无模板或主机复核不通过时为 null（只返回码） */
  trackingUrl: string | null;
};

type OfferRow = {
  brandId: string;
  exclusive: boolean;
  active: boolean;
  brandStatus: 'certified' | 'watch' | 'blacklist';
  relatedParty: boolean;
  template: string | null;
};

/** 官方主机集合：与迁移 0005 bydp_redirect_host_ok 同口径（lower(value)，不去标识的 www.） */
export async function officialHosts(db: Exec, brandId: string): Promise<string[]> {
  const r = await rows<{ value: string }>(
    db,
    sql`select "value" from "identifier"
        where "brandId" = ${brandId} and "ownership" = 'official' and "type" in ('domain', 'mirror')`,
  );
  return r.map((x) => x.value.toLowerCase());
}

/** 与迁移 0005 offer / brand_redirect_template_shape 同一正则（禁 @ 与 \\，占位符只允许 {clickId}） */
const TEMPLATE_SHAPE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/([^{}\s@\\]|\{clickId\})*)?$/;

/**
 * 模板先过形状正则（与 DB 同口径），`{clickId}` → encodeURIComponent(clickId)，再用 WHATWG URL 复核：
 * https、无 userinfo、hostname（去 www.）∈ 官方主机。任一不满足返回 null。
 */
export function buildTrackingUrl(template: string | null, clickId: string, hosts: readonly string[]): string | null {
  if (!template || !TEMPLATE_SHAPE.test(template)) return null;
  let u: URL;
  try {
    u = new URL(template.split('{clickId}').join(encodeURIComponent(clickId)));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return hosts.includes(host) ? u.href : null;
}

export async function claimOffer(db: Pick<Db, 'transaction'>, input: ClaimInput): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [offer] = await rows<OfferRow>(
      tx,
      sql`select o."brandId", o."exclusive",
                 -- A-018：Offer 独立状态 offline（含黑名单连带下线）与过期同口径拒绝
                 (o."status" = 'active' and (o."validUntil" is null or o."validUntil" >= current_date)) as "active",
                 b."status" as "brandStatus", op."relatedParty",
                 coalesce(o."redirectTemplate", b."redirectTemplate") as "template"
          from "offer" o join "brand" b on b."id" = o."brandId" join "operator" op on op."id" = b."operatorId"
          where o."id" = ${input.offerId}`,
    );
    if (!offer) throw new TrackingError('offer_not_found');
    // 黑名单先于「已下线 / 过期」判断：A-018 起黑名单品牌的 Offer 必为 offline，仍应告知「该平台在黑名单中」
    if (offer.brandStatus === 'blacklist') throw new TrackingError('brand_blacklisted');
    if (!offer.active) throw new TrackingError('offer_expired');
    // ADR-0003：关联方不开放付费独家位
    if (offer.relatedParty && offer.exclusive) throw new TrackingError('related_party_exclusive');
    if (input.partnerId) {
      const [p] = await rows(tx, sql`select 1 from "partner" where "id" = ${input.partnerId} and "active"`);
      if (!p) throw new TrackingError('partner_invalid');
    }

    // 同一用户 + offer 串行化，保证 24h 幂等在并发下成立
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`claim:${input.userId}:${input.offerId}`}, 0))`);
    const [prev] = await rows<{ id: string; code: string | null }>(
      tx,
      sql`select c."id", pc."code" from "click" c left join "promo_code" pc on pc."id" = c."promoCodeId"
          where c."userId" = ${input.userId} and c."offerId" = ${input.offerId}
            and c."createdAt" > now() - make_interval(hours => ${CLAIM_DEDUPE_HOURS})
          order by c."createdAt" desc, c."id" desc limit 1`,
    );

    let clickId: string;
    let code: string | null;
    if (prev) {
      clickId = prev.id;
      code = prev.code;
    } else {
      const [pc] = await rows<{ id: string; code: string | null }>(
        tx,
        sql`select "id", "code" from "promo_code"
            where "offerId" = ${input.offerId} and ("activeUntil" is null or "activeUntil" >= current_date)
            order by coalesce("channel" = ${input.channel ?? null}, false) desc, "id" limit 1`,
      );
      const [row] = await tx
        .insert(schema.clicks)
        .values({
          brandId: offer.brandId,
          offerId: input.offerId,
          promoCodeId: pc?.id ?? null,
          userId: input.userId,
          partnerId: input.partnerId ?? null,
          slot: input.slot ?? null,
          channel: input.channel ?? null,
          region: input.region ?? null,
        })
        .returning({ id: schema.clicks.id });
      clickId = row!.id;
      code = pc?.code ?? null;
    }

    const trackingUrl = buildTrackingUrl(offer.template, clickId, await officialHosts(tx, offer.brandId));
    return { clickId, reused: Boolean(prev), code, trackingUrl };
  });
}
