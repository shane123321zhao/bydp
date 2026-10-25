/**
 * 「我的」用例（field-mapping 06 · api-contract /me*）。userId 只来自会话。连 DB，与 `./index`（纯 zod）分开。
 * - 等级门槛（A-010 · §9.2 v1.7）：0 / 500 / 1500 / 3000 / 6000；nextLevelAt = 下一级门槛积分（满级不返回）。
 * - 动态流：投诉 / 领码 / 绑定 / 订阅 / 通知 / 积分合并，取最近 20 条；「已用」= 该码 Click 已有 first_deposit 转化（D-011 #2）；
 *   积分事件以「+N 分」标签展示（points_event，A-010）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { STATUS_TEXT } from '../complaint/cases';
import { loadBrandCards } from '../trust/brand-card';
import { getPrimaryIdentity } from './auth';
import { assertNotSelfExcluded, getSelfExclusion } from './self-exclusion';
import { nextLevel } from './points';

/** 积分事由（动态流文案） */
const POINTS_TEXT: Record<string, string> = {
  binding_confirmed: '绑定经运营商回传确认',
  withdrawal_report_accepted: '出款凭证被采纳',
  review_published: '评价已发布',
  complaint_resolved: '投诉已解决',
};
import { bindingSummaryForUser, createBinding, listBindingsForUser, type MyBindingRow } from './bindings';
import type { Binding, MePayload } from './index';

type Exec = Pick<Db, 'execute'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const ACTIVE = sql`"status" not in ('resolved', 'rejected', 'exposed')`;
const LEVEL_TEXT = { self_reported: '自报', postback_confirmed: '回传确认', operator_confirmed: '运营商确认' } as const;

/** D-012 #2：只能绑定认证库 / 观察库品牌；黑名单不可绑（不为黑名单背书、导流） */
export const BINDABLE_BRAND_STATUSES = ['certified', 'watch'] as const;

/** 黑名单品牌不可绑定 → 接口 400 `brand_not_bindable` */
export class BrandNotBindableError extends Error {
  constructor() {
    super('黑名单平台不可绑定');
    this.name = 'BrandNotBindableError';
  }
}

export class MeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeInputError';
  }
}

async function toBindingViews(db: Exec, rows: MyBindingRow[]): Promise<Binding[]> {
  const cards = await loadBrandCards(db, [...new Set(rows.map((r) => r.brandId))]);
  return rows.map((r) => ({
    id: r.id,
    brand: cards.get(r.brandId),
    operatorAccountIdMasked: r.operatorAccountIdMasked,
    source: r.source,
    promoCode: r.promoCode,
    boundAt: r.boundAt.toISOString(),
    verificationLevel: r.verificationLevel,
    compensationEligible: r.compensationEligible,
  }));
}

export async function listMyBindings(db: Exec, userId: string): Promise<Binding[]> {
  return toBindingViews(db, await listBindingsForUser(db, userId));
}

/**
 * POST /me/bindings：自报级绑定。带 promoCodeId 时须是本人领过的码且属于该品牌（来源记 promo_link），否则 400。
 * 同品牌同账号已被绑定 → BindingConflictError（409）。
 */
export async function createMyBinding(
  db: Exec & Pick<Db, 'insert'>,
  userId: string,
  input: { brandId: string; operatorAccountId: string; promoCodeId?: string | null },
): Promise<Binding> {
  await assertNotSelfExcluded(db, userId); // A-011：自我排除期内不可添加绑定
  const [brand] = await q<{ id: string; status: string }>(db, sql`select "id", "status" from ${schema.brands} where "id" = ${input.brandId}`);
  if (!brand) throw new MeInputError('品牌不存在');
  if (!BINDABLE_BRAND_STATUSES.includes(brand.status as (typeof BINDABLE_BRAND_STATUSES)[number])) throw new BrandNotBindableError();
  if (input.promoCodeId) {
    const [claimed] = await q(
      db,
      sql`select 1 from ${schema.clicks} c join ${schema.promoCodes} pc on pc."id" = c."promoCodeId"
          where c."userId" = ${userId} and c."promoCodeId" = ${input.promoCodeId} and c."brandId" = ${input.brandId} limit 1`,
    );
    if (!claimed) throw new MeInputError('该码不是你在此品牌领取的');
  }
  const row = await createBinding(db, {
    userId,
    brandId: input.brandId,
    operatorAccountId: input.operatorAccountId,
    promoCodeId: input.promoCodeId ?? null,
    source: input.promoCodeId ? 'promo_link' : 'manual',
  });
  const [view] = await toBindingViews(db, (await listBindingsForUser(db, userId)).filter((b) => b.id === row.id));
  return view!;
}

/** POST /me/subscriptions：目标须存在；同一用户同一目标只保留一条（重复订阅更新渠道） */
export async function subscribe(
  db: Exec,
  userId: string,
  input: { targetType: 'brand' | 'complaint' | 'candidate'; targetId: string; channel: 'telegram' | 'email' },
): Promise<{ id: string; created: boolean }> {
  const table = { brand: schema.brands, complaint: schema.complaints, candidate: schema.candidates }[input.targetType];
  // 投诉：只允许订阅公开案件或本人案件
  const guard = input.targetType === 'complaint' ? sql` and ("publicSummary" or "userId" = ${userId})` : sql``;
  const [target] = await q(db, sql`select 1 from ${table} where "id" = ${input.targetId}${guard}`);
  if (!target) throw new MeInputError('订阅对象不存在');
  const [existing] = await q<{ id: string }>(
    db,
    sql`update ${schema.subscriptions} set "channel" = ${input.channel}
        where "userId" = ${userId} and "targetType" = ${input.targetType} and "targetId" = ${input.targetId} returning "id"`,
  );
  if (existing) return { id: existing.id, created: false };
  const id = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql`insert into ${schema.subscriptions} ("id", "userId", "targetType", "targetId", "channel", "events")
        values (${id}, ${userId}, ${input.targetType}, ${input.targetId}, ${input.channel}, ${sql`array['status_change']::text[]`})`,
  );
  return { id, created: true };
}

/** 按 slug 或简体名找品牌（D-017 TG `/sub 品牌`）；找不到返回 null */
export async function findBrandForSubscription(db: Exec, query: string): Promise<{ id: string; name: string } | null> {
  const v = query.trim().slice(0, 64);
  if (!v) return null;
  const [b] = await q<{ id: string; name: string | null; slug: string }>(
    db,
    sql`select "id", "name"->>'zhHans' as "name", "slug" from ${schema.brands} where lower("slug") = lower(${v}) or "name"->>'zhHans' = ${v} order by ("slug" = lower(${v})) desc limit 1`,
  );
  return b ? { id: b.id, name: b.name ?? b.slug } : null;
}

/** 取消订阅（D-017 TG `/unsub`）：只删本人的；返回是否删到 */
export async function unsubscribe(db: Exec, userId: string, input: { targetType: 'brand' | 'complaint' | 'candidate'; targetId: string }): Promise<boolean> {
  const rows = await q(
    db,
    sql`delete from ${schema.subscriptions} where "userId" = ${userId} and "targetType" = ${input.targetType} and "targetId" = ${input.targetId} returning 1`,
  );
  return rows.length > 0;
}

/** GET /me */
/** 首页登录态条（field-mapping 01「我的（登录）」· 契约 MeBrief）：昵称 · 绑定数 · 赔付资格 · 进行中投诉数 */
export async function getMeBrief(db: Exec, userId: string): Promise<{ displayName: string; bindings: number; compensationEligible: boolean; activeComplaints: number } | null> {
  const [r] = await q<{ displayName: string; active: number }>(
    db,
    sql`select u."displayName", (select count(*) from ${schema.complaints} where "userId" = u."id" and ${ACTIVE})::int as "active"
        from ${schema.users} u where u."id" = ${userId}`,
  );
  if (!r) return null;
  const b = await bindingSummaryForUser(db, userId);
  return { displayName: r.displayName, bindings: b.count, compensationEligible: b.eligible, activeComplaints: r.active };
}

export async function getMe(db: Exec, userId: string): Promise<MePayload | null> {
  const [u] = await q<{ displayName: string; joinedAt: string; region: string | null; locale: string; level: number; points: number }>(
    db,
    sql`select "displayName", "joinedAt"::text, "region", "locale", "level", "points" from ${schema.users} where "id" = ${userId}`,
  );
  if (!u) return null;
  const idn = await getPrimaryIdentity(db, userId);
  const [counts] = await q<{ active: number; total: number; codes: number; subs: number; tgSubs: number }>(
    db,
    sql`select
          (select count(*) from ${schema.complaints} where "userId" = ${userId} and ${ACTIVE})::int as "active",
          (select count(*) from ${schema.complaints} where "userId" = ${userId})::int as "total",
          (select count(distinct "promoCodeId") from ${schema.clicks} where "userId" = ${userId} and "promoCodeId" is not null)::int as "codes",
          (select count(*) from ${schema.subscriptions} where "userId" = ${userId})::int as "subs",
          (select count(*) from ${schema.subscriptions} where "userId" = ${userId} and "channel" = 'telegram')::int as "tgSubs"`,
  );
  const bindingRows = await listBindingsForUser(db, userId);
  const bindings = await toBindingViews(db, bindingRows);

  type Act = { at: Date; date: string; subject: string; rest: string; tag: string; ref?: string };
  const acts: Act[] = [];
  const mk = (at: Date | string, subject: string, rest: string, tag: string, ref?: string): Act => ({ at: new Date(at), date: ymd(at), subject, rest, tag, ...(ref ? { ref } : {}) });
  const complaints = await q<{ id: string; title: string; status: string; createdAt: Date; brandId: string }>(
    db,
    sql`select "id", "title", "status", "createdAt", "brandId" from ${schema.complaints} where "userId" = ${userId} order by "createdAt" desc limit 20`,
  );
  // D-011 #2：「已用」= 该码的 Click 已有 first_deposit 转化
  const claims = await q<{ code: string | null; title: string; createdAt: Date; used: boolean }>(
    db,
    sql`select pc."code", o."title", c."createdAt",
               exists (select 1 from ${schema.conversions} v where v."clickId" = c."id" and v."event" = 'first_deposit') as "used"
        from ${schema.clicks} c
        join ${schema.promoCodes} pc on pc."id" = c."promoCodeId" join ${schema.offers} o on o."id" = c."offerId"
        where c."userId" = ${userId} order by c."createdAt" desc limit 20`,
  );
  const subs = await q<{ targetType: string; targetId: string; channel: string; createdAt: Date }>(
    db,
    sql`select "targetType", "targetId", "channel", "createdAt" from ${schema.subscriptions} where "userId" = ${userId} order by "createdAt" desc limit 20`,
  );
  const pts = await q<{ event: string; points: number; refType: string; refId: string; createdAt: Date }>(
    db,
    sql`select "event", "points", "refType", "refId", "createdAt" from ${schema.pointsEvents} where "userId" = ${userId} order by "createdAt" desc limit 20`,
  );
  const notes = await q<{ title: string; body: string | null; sentAt: Date }>(
    db,
    sql`select "title", "body", "sentAt" from ${schema.notifications} where "userId" = ${userId} order by "sentAt" desc limit 20`,
  );
  const cards = await loadBrandCards(db, [
    ...new Set([...complaints.map((c) => c.brandId), ...bindingRows.map((b) => b.brandId), ...subs.filter((s) => s.targetType === 'brand').map((s) => s.targetId)]),
  ]);
  // name 为多语言对象；动态文案为简体口径
  const brandName = (id: string) => cards.get(id)?.name?.zhHans ?? cards.get(id)?.name?.en ?? id;
  for (const c of complaints) acts.push(mk(c.createdAt, `投诉 #${c.id}`, c.title, STATUS_TEXT[c.status] ?? c.status, `/me/complaints/${c.id}`));
  for (const c of claims) acts.push(mk(c.createdAt, c.code ? `领码 ${c.code}` : '领取优惠', c.used ? `${c.title} · 已用` : c.title, c.used ? '已用' : '领码'));
  for (const b of bindingRows) acts.push(mk(b.boundAt, '绑定', `${brandName(b.brandId)} · ${LEVEL_TEXT[b.verificationLevel]}`, '绑定'));
  for (const s of subs)
    acts.push(mk(s.createdAt, '订阅', `${s.targetType === 'brand' ? brandName(s.targetId) : `${s.targetType === 'complaint' ? '投诉' : '候选'} #${s.targetId}`} · ${s.channel === 'telegram' ? 'TG' : '邮件'}`, '订阅'));
  for (const n of notes) acts.push(mk(n.sentAt, '通知', n.title, '状态变更'));
  for (const e of pts)
    acts.push(mk(e.createdAt, '积分', POINTS_TEXT[e.event] ?? e.event, `+${e.points} 分`, e.refType === 'complaint' ? `/me/complaints/${e.refId}` : undefined));
  acts.sort((a, b) => b.at.getTime() - a.at.getTime());

  return {
    user: {
      displayName: u.displayName,
      ...(idn ? { provider: idn.provider, handleMasked: idn.handle ?? undefined } : {}),
      joinedAt: u.joinedAt,
      ...(u.region ? { region: u.region } : {}),
      locale: u.locale,
      level: u.level,
      points: u.points,
      ...(nextLevel(u.points) ? { nextLevelAt: nextLevel(u.points)!.at } : {}),
    },
    counts: { bindings: bindingRows.length, complaintsActive: counts!.active, complaintsTotal: counts!.total, codes: counts!.codes, subscriptions: counts!.subs },
    bindings,
    activity: acts.slice(0, 20).map(({ at: _at, ...a }) => a),
    settings: { locale: u.locale, notifications: counts!.tgSubs > 0, selfExclusion: await getSelfExclusion(db, userId) },
  };
}

/** 添加绑定页（§16）：可绑定品牌 = 认证 / 观察库（黑名单不可绑）；附带本人在各品牌最近领过的码（「经 BYDP 领码注册」来源用） */
export async function listBindableBrands(db: Exec, userId: string) {
  const ids = await q<{ id: string }>(db, sql`select "id" from ${schema.brands} where "status" in (${sql.join(BINDABLE_BRAND_STATUSES.map((s) => sql`${s}`), sql`, `)}) order by "status", "slug"`);
  const cards = await loadBrandCards(db, ids.map((r) => r.id));
  const claims = await q<{ brandId: string; promoCodeId: string; code: string | null }>(
    db,
    sql`select distinct on (c."brandId") c."brandId", c."promoCodeId", pc."code" from ${schema.clicks} c
        join ${schema.promoCodes} pc on pc."id" = c."promoCodeId"
        where c."userId" = ${userId} order by c."brandId", c."createdAt" desc, c."id" desc`,
  );
  const claimed = new Map(claims.map((c) => [c.brandId, { promoCodeId: c.promoCodeId, code: c.code }]));
  return ids.map((r) => ({ brand: cards.get(r.id)!, claimed: claimed.get(r.id) ?? null }));
}
