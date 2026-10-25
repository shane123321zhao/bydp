/**
 * 绑定写入唯一入口（D-003 M1 首项 2 / A-001 非阻塞备注 2）。
 * DB 不校验 hash 与账号是否对应，唯一性依赖这里用同一函数计算 HMAC——任何代码不得绕过本函数直接 insert user_brand_binding
 * （eslint no-restricted-syntax 拦截）。boundAt / createdAt 由 DB 触发器取服务端时间。
 * 用例（连 DB）与 zod schema 分开：schema 模块保持无 DB 依赖，供前端直接引用；用例经 `@bydp/core/identity/bindings` 引入。
 */
import { randomUUID } from 'node:crypto';
import {
  bindingHmacKeyFromEnv,
  bindingPiiKeyFromEnv,
  encryptOperatorAccountId,
  hashOperatorAccountId,
  maskOperatorAccount,
  normalizeOperatorAccountId,
  schema,
  sql,
  type Db,
} from '@bydp/db';
import { z } from 'zod';
import { BindingCreate } from './index';
import { awardPoints } from './points';

export const CreateBindingInput = BindingCreate.extend({
  operatorAccountId: z.string().max(128),
  /** M2：由会话注入，禁止取自请求体 */
  userId: z.string(),
  source: z.enum(['promo_link', 'manual']),
});
export type CreateBindingInput = z.infer<typeof CreateBindingInput>;

export class BindingConflictError extends Error {
  constructor(public readonly brandId: string) {
    super(`该运营商账号已在品牌 ${brandId} 下绑定`);
    this.name = 'BindingConflictError';
  }
}

type DbOrTx = Pick<Db, 'execute'>;

/** 账号规范化：实现移至 @bydp/db（与 tracking 回传共用同一函数，A-007 G4），此处保留导出以兼容既有引用 */
export { normalizeOperatorAccountId };

/**
 * A-011：账号只以密文（AES-256-GCM，AAD = binding.id）+ 盲索引 + 掩码入库，明文不落库（bydp_app 也无明文列 INSERT 权限）。
 * id 在应用层先生成，以便作为 AAD。
 */
export async function createBinding(
  db: DbOrTx,
  raw: CreateBindingInput,
  hmacKey: string = bindingHmacKeyFromEnv(),
  piiKey: Buffer = bindingPiiKeyFromEnv(),
) {
  const input = CreateBindingInput.parse(raw);
  const operatorAccountId = normalizeOperatorAccountId(input.operatorAccountId);
  if (!operatorAccountId) throw new z.ZodError([{ code: 'custom', path: ['operatorAccountId'], message: '不能为空', input: raw.operatorAccountId }]);
  try {
    const id = `ubb_${randomUUID().replaceAll('-', '')}`;
    // 显式列清单：bydp_app 只有这些列的 INSERT 权限（A-011，明文列不在内）；drizzle insert 会带上全部列（含 DEFAULT）而被拒
    const [row] = (await db.execute(
      sql`insert into ${schema.userBrandBindings}
            ("id", "userId", "brandId", "operatorAccountIdEnc", "operatorAccountIdMasked", "operatorAccountIdHash", "source", "promoCodeId", "verificationLevel")
          values (${id}, ${input.userId}, ${input.brandId}, ${encryptOperatorAccountId(operatorAccountId, piiKey, id)}, ${maskOperatorAccount(operatorAccountId)},
                  ${hashOperatorAccountId(operatorAccountId, hmacKey)}, ${input.source}, ${input.promoCodeId ?? null}, 'self_reported')
          returning *`,
    )) as unknown as (typeof schema.userBrandBindings.$inferSelect)[];
    return row!;
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    const constraint =
      (e as { constraint_name?: string }).constraint_name ?? (e as { cause?: { constraint_name?: string } }).cause?.constraint_name;
    if (code === '23505' && constraint === 'binding_brand_account_hash_uq') throw new BindingConflictError(input.brandId);
    throw e;
  }
}

/** 只读：绑定核验等级（公开案件页展示用；不暴露账号） */
export async function getBindingLevel(db: Pick<Db, 'execute'>, bindingId: string) {
  const [row] = (await db.execute(
    sql`select "verificationLevel" from ${schema.userBrandBindings} where "id" = ${bindingId}`,
  )) as unknown as { verificationLevel: 'self_reported' | 'postback_confirmed' | 'operator_confirmed' }[];
  return row?.verificationLevel ?? null;
}

/** 只读：有效绑定的归属（提交投诉时校验 bindingId 属于本人且属于该品牌；A-015：已失效绑定视同不存在） */
export async function getBindingOwner(db: Pick<Db, 'execute'>, bindingId: string) {
  const [row] = (await db.execute(
    sql`select "userId", "brandId" from ${schema.userBrandBindings} where "id" = ${bindingId} and "revokedAt" is null`,
  )) as unknown as { userId: string; brandId: string }[];
  return row ?? null;
}

/** 只读：按 (brandId, 账号哈希) 找**有效**绑定（A-007 G4：回传匹配只用哈希，不用明文；A-015：已失效绑定不参与归因与升级，同哈希可能另有新用户的有效绑定） */
export async function findBindingByAccountHash(db: Pick<Db, 'execute'>, brandId: string, operatorAccountIdHash: string) {
  const [row] = (await db.execute(
    sql`select "id", "userId" from ${schema.userBrandBindings}
        where "brandId" = ${brandId} and "operatorAccountIdHash" = ${operatorAccountIdHash} and "revokedAt" is null`,
  )) as unknown as { id: string; userId: string }[];
  return row ?? null;
}

export type PostbackConfirmResult = 'upgraded' | 'no_binding' | 'no_click_proof' | 'not_eligible';

/**
 * 绑定升级为「回传确认」（A-007 §2 + 落地确认 K1）——四条同时满足才升：
 * ① 回传验签通过（入参类型要求 true）② 哈希匹配到 (brandId, hash) 的绑定 ③ 绑定时间早于回传接收时间
 * ④ 归属证明：运营商回传**自带**的 clickId 经归因成立，且该 Click 的 userId 就是绑定的 userId
 *    （账号经本人领码链接注册 / 充值）。靠哈希兜底归因的回传照常记转化，但不升级——否则自报他人账号即可骗得赔付资格。
 * 只升不降：只改 self_reported 行，运营商确认级不动；找不到绑定不自动创建。
 */
export async function confirmBindingByPostback(
  db: Pick<Db, 'execute'>,
  p: { signatureVerified: true; brandId: string; operatorAccountIdHash: string; postbackAt: Date; operatorClickId: string | null },
): Promise<PostbackConfirmResult> {
  if (p.signatureVerified !== true) return 'not_eligible';
  const binding = await findBindingByAccountHash(db, p.brandId, p.operatorAccountIdHash);
  if (!binding) return 'no_binding';
  if (!p.operatorClickId) return 'no_click_proof';
  const [click] = (await db.execute(
    sql`select "userId" from "click" where "id" = ${p.operatorClickId} and "brandId" = ${p.brandId}`,
  )) as unknown as { userId: string | null }[];
  if (!click || click.userId !== binding.userId) return 'no_click_proof';
  const updated = (await db.execute(
    sql`update ${schema.userBrandBindings}
        set "verificationLevel" = 'postback_confirmed', "postbackAt" = ${p.postbackAt.toISOString()}::timestamptz
        where "id" = ${binding.id} and "verificationLevel" = 'self_reported' and "boundAt" < ${p.postbackAt.toISOString()}::timestamptz
        returning "id"`,
  )) as unknown as { id: string }[];
  if (!updated.length) return 'not_eligible';
  // A-010：回传确认 +500（每用户每品牌一次；分值以规则为准）
  await awardPoints(db, {
    userId: binding.userId,
    event: 'binding_confirmed',
    refType: 'binding',
    refId: binding.id,
    dedupeKey: `binding_confirmed:${binding.userId}:${p.brandId}`,
  });
  return 'upgraded';
}

/** 运营商账号掩码（field-mapping 06「账号（掩码）」）：实现移至 @bydp/db（A-011，写入时计算并入库），此处保留导出 */
export { maskOperatorAccount };

export type MyBindingRow = {
  id: string;
  brandId: string;
  operatorAccountIdMasked: string;
  source: 'promo_link' | 'manual';
  promoCode: string | null;
  boundAt: Date;
  verificationLevel: 'self_reported' | 'postback_confirmed' | 'operator_confirmed';
  compensationEligible: boolean;
};

/** 只读：本人绑定数与是否有任一具备赔付资格（首页登录态条 MeBrief） */
export async function bindingSummaryForUser(db: Pick<Db, 'execute'>, userId: string): Promise<{ count: number; eligible: boolean }> {
  const [r] = (await db.execute(
    sql`select count(*)::int as "count", coalesce(bool_or("compensationEligible"), false) as "eligible" from ${schema.userBrandBindings} where "userId" = ${userId} and "revokedAt" is null`,
  )) as unknown as { count: number; eligible: boolean }[];
  return r ?? { count: 0, eligible: false };
}

export type LatestBinding = { id: string; brandId: string; verificationLevel: 'self_reported' | 'postback_confirmed' | 'operator_confirmed'; compensationEligible: boolean };

/** 只读：本人在每个品牌最近一条绑定（05 投诉表单「绑定状态」与自动挂绑定） */
export async function latestBindingsByBrand(db: Pick<Db, 'execute'>, userId: string): Promise<LatestBinding[]> {
  return (await db.execute(
    sql`select distinct on ("brandId") "brandId", "id", "verificationLevel", "compensationEligible"
        from ${schema.userBrandBindings} where "userId" = ${userId} and "revokedAt" is null order by "brandId", "boundAt" desc, "id" desc`,
  )) as unknown as LatestBinding[];
}

/** 只读：批量取绑定核验等级（仲裁台队列用；不暴露账号） */
export async function bindingLevelsByIds(db: Pick<Db, 'execute'>, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = (await db.execute(
    sql`select "id", "verificationLevel" from ${schema.userBrandBindings} where "id" in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
  )) as unknown as { id: string; verificationLevel: string }[];
  return new Map(rows.map((r) => [r.id, r.verificationLevel]));
}

/** 只读：本人全部绑定（账号只返回掩码） */
export async function listBindingsForUser(db: Pick<Db, 'execute'>, userId: string): Promise<MyBindingRow[]> {
  const rows = (await db.execute(
    sql`select b."id", b."brandId", b."operatorAccountIdMasked", b."source", pc."code" as "promoCode", b."boundAt",
               b."verificationLevel", b."compensationEligible"
        from ${schema.userBrandBindings} b left join ${schema.promoCodes} pc on pc."id" = b."promoCodeId"
        where b."userId" = ${userId} and b."revokedAt" is null order by b."boundAt" desc, b."id"`,
  )) as unknown as (Omit<MyBindingRow, 'boundAt'> & { boundAt: Date | string })[];
  return rows.map((r) => ({ ...r, boundAt: new Date(r.boundAt) }));
}

/** 只读：绑定是否具备赔付资格（本人投诉进度页展示；A-015：已失效绑定一律无资格） */
export async function getBindingEligibility(db: Pick<Db, 'execute'>, bindingId: string): Promise<boolean> {
  const [row] = (await db.execute(
    sql`select "compensationEligible" and "revokedAt" is null as "compensationEligible" from ${schema.userBrandBindings} where "id" = ${bindingId}`,
  )) as unknown as { compensationEligible: boolean }[];
  return row?.compensationEligible ?? false;
}

/**
 * D-024 提交（出款凭证 / 评价）用：本人在该品牌未失效的绑定。before 给定时只取 boundAt ≤ before 的（凭证须纠纷前绑定）；
 * 多条时取核验等级最高、其次最早的一条（评价权重按绑定等级由库写入）。
 */
export async function activeBindingForSubmission(db: Pick<Db, 'execute'>, userId: string, brandId: string, before?: Date): Promise<string | null> {
  const [b] = (await db.execute(
    sql`select "id" from ${schema.userBrandBindings}
        where "userId" = ${userId} and "brandId" = ${brandId} and "revokedAt" is null
          ${before ? sql`and "boundAt" <= ${before.toISOString()}` : sql``}
        order by case "verificationLevel" when 'operator_confirmed' then 0 when 'postback_confirmed' then 1 else 2 end, "boundAt"
        limit 1`,
  )) as unknown as { id: string }[];
  return b?.id ?? null;
}
