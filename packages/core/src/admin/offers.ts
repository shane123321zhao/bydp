/**
 * 后台 Offer 上线 / 下线（A-018 落地 · §9.2 v1.15 / v1.17 · admin 契约 v0.5.0）：仅 admin；原因必填；写 audit before / after。
 * - 品牌转入黑名单时 DB 触发器同事务把该品牌 Offer 全部置 offline；解除黑名单**不自动恢复**，由 admin 在此逐个上线。
 * - 黑名单品牌的 Offer 上线由 DB 触发器拒绝（CONSTRAINT offer_blacklisted_brand_inactive → api 409 invalid_transition）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { ComplaintInputError } from '../complaint/write';
import { writeAudit, type Actor } from './rbac';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export type OfferStatus = 'active' | 'offline';
export type AdminOffer = { id: string; brandId: string; title: string; status: OfferStatus; validUntil: string | null; exclusive: boolean };

export class OfferStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfferStatusError';
  }
}
export class OfferNotFoundError extends Error {
  constructor() {
    super('优惠不存在');
    this.name = 'OfferNotFoundError';
  }
}

const COLS = sql`"id", "brandId", "title", "status", "validUntil"::text as "validUntil", "exclusive"`;

export async function listBrandOffers(db: Exec, brandId: string): Promise<AdminOffer[]> {
  return q<AdminOffer>(db, sql`select ${COLS} from ${schema.offers} where "brandId" = ${brandId} order by "status", "id"`);
}

export async function setOfferStatus(db: Tx, a: Actor, offerId: string, input: { to: OfferStatus; reason: string }): Promise<AdminOffer> {
  const reason = input.reason.trim();
  if (!reason) throw new ComplaintInputError('须填写原因');
  return db.transaction(async (tx) => {
    const [o] = await q<AdminOffer>(tx, sql`select ${COLS} from ${schema.offers} where "id" = ${offerId} for update`);
    if (!o) throw new OfferNotFoundError();
    if (o.status === input.to) throw new OfferStatusError(`优惠已是「${input.to === 'active' ? '上线' : '下线'}」`);
    const [after] = await q<AdminOffer>(tx, sql`update ${schema.offers} set "status" = ${input.to}, "updatedAt" = now() where "id" = ${offerId} returning ${COLS}`);
    await writeAudit(tx, a, 'offer_status_change', { type: 'offer', id: offerId }, { status: o.status }, { status: input.to, reason });
    return after!;
  });
}
