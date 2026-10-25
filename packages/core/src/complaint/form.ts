/**
 * 05 投诉表单与本人案件页的读取（web 专用，field-mapping 05「表单」：对象品牌 · 评分 · 绑定状态）。
 * 任何状态的品牌都可被投诉（黑名单品牌受理后可直接曝光，§9.2）；绑定取本人在该品牌最近一条（null = 未绑定）。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { BrandCard } from '../trust/index';
import { loadBrandCards } from '../trust/brand-card';
import { latestBindingsByBrand } from '../identity/bindings';

type Exec = Pick<Db, 'execute'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export type MyBindingBrief = { id: string; verificationLevel: 'self_reported' | 'postback_confirmed' | 'operator_confirmed'; compensationEligible: boolean };
export type ComplainableBrand = { brand: BrandCard; binding: MyBindingBrief | null };

/** 投诉对象候选：认证 → 观察 → 黑名单，同库按 slug；附本人绑定 */
export async function listComplainableBrands(db: Exec, userId: string): Promise<ComplainableBrand[]> {
  const ids = await q<{ id: string }>(
    db,
    sql`select "id" from ${schema.brands} order by case "status" when 'certified' then 0 when 'watch' then 1 else 2 end, "slug"`,
  );
  const cards = await loadBrandCards(db, ids.map((r) => r.id));
  const binds = await latestBindingsByBrand(db, userId);
  const byBrand = new Map(binds.map(({ brandId, ...b }) => [brandId, b]));
  return ids.flatMap((r) => (cards.get(r.id) ? [{ brand: cards.get(r.id)!, binding: byBrand.get(r.id) ?? null }] : []));
}

/** 本人案件所属品牌（本人案件页标题行用；他人案件返回 null） */
export async function getMyComplaintBrand(db: Exec, userId: string, complaintId: string): Promise<BrandCard | null> {
  const [c] = await q<{ brandId: string }>(db, sql`select "brandId" from ${schema.complaints} where "id" = ${complaintId} and "userId" = ${userId}`);
  if (!c) return null;
  return (await loadBrandCards(db, [c.brandId])).get(c.brandId) ?? null;
}
