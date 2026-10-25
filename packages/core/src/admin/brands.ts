/**
 * 品牌状态变更（D-018 · §9.2 v1.15 · admin 契约 v0.4.1）：admin 或 arbitrator，10 分钟重新验证（路由层）；原因必填。
 * - 权限收紧（协调官 D-018 裁定）：转入「平台认证」与「离开黑名单」只限 admin（core 自读 user_role，不信任调用方角色）；仲裁员可转黑名单、在认证 / 观察间转观察。
 * - 转认证前提：关联方运营商的品牌永不认证（§5 / §14，409 related_party；触发器兜底随 A-018，上线前置 #26）；须已登记 certifiedDepositUsdt。
 * - 同事务：锁品牌行 → 改 status / statusSince（服务端日期：0002 触发器取 current_date，测试站 / 生产库时区 UTC）→ R1 触发器写 status_history（actor / reason 经 set_config 传入）→ audit before / after。
 * - 转入黑名单的连带：评分不计（brand-card 读取时黑名单 score = null，§5）；新绑定 / 领码拒绝（tracking brand_blacklisted）；
 *   Offer 由 DB 触发器（迁移 0015 · A-018）同事务置 offline；解除黑名单不自动恢复，由 admin 在后台逐个上线（admin/offers.ts）。
 * - 通知：订阅该品牌的用户 + 该品牌有进行中案件的投诉人，各一条 `brand_status_changed`（去重）；推送由调用方在提交后入队。
 *   文案中性可追溯（协调官 D-018 #3）：不用「黑盘」「跑路」等词。
 */
import { schema, sql, type Db } from '@bydp/db';
import { ComplaintInputError } from '../complaint/write';
import { ForbiddenError, getUserRoles, writeAudit, type Actor } from './rbac';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export type BrandStatus = 'certified' | 'watch' | 'blacklist';
export const BRAND_STATUS_TEXT: Record<BrandStatus, string> = { certified: '平台认证', watch: '观察', blacklist: '黑名单' };
/** 进行中案件（通知投诉人）：未结案且未转曝光 */
const IN_PROGRESS = ['screening', 'accepted', 'awaiting_reply', 'arbitrating'] as const;
export const BRAND_STATUS_NOTICE_TYPE = 'brand_status_changed';

export class BrandStatusError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_transition' | 'related_party' = 'invalid_transition',
  ) {
    super(message);
    this.name = 'BrandStatusError';
  }
}
export class BrandNotFoundError extends Error {
  constructor() {
    super('品牌不存在');
    this.name = 'BrandNotFoundError';
  }
}

/** 原因会写进通知推送给订阅者：禁用词（对外文案口径 + D-018 #3）与个人信息（长数字串 / 邮箱 / @账号 / TG 链接）一律拒绝 */
const BANNED = /保险|留存率|黑盘|跑路|骗子|骗局|诈骗/;
// 7 位以上数字串视为电话 / 账号；后接金额单位（U / USDT / USD / 元）的放过（协调官 D-018 ③）
const PERSONAL = /\d{7,}(?!\d)(?!\s*(?:USDT|USD|U|元))|[\w.+-]+@[\w-]+\.[\w.]+|@[A-Za-z0-9_]{4,}|t\.me\//i;
export function checkReason(reason: string): string {
  const r = reason.trim();
  if (!r) throw new ComplaintInputError('须填写原因');
  if (BANNED.test(r)) throw new ComplaintInputError('原因含不可对外使用的措辞（如「黑盘」「跑路」），请改用中性描述');
  if (PERSONAL.test(r)) throw new ComplaintInputError('原因会推送给订阅者，不得包含电话、邮箱、账号或链接等个人信息');
  return r;
}

/** 按字符（非 UTF-16 单元）截断，避免切开表情 */
const summary = (s: string, n = 80) => {
  const t = Array.from(s.replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n).join('')}…` : t.join('');
};

/** 纯函数：通知标题 / 正文（中性措辞） */
export function brandStatusNotice(b: { name: string; slug: string }, from: BrandStatus, to: BrandStatus, date: string, reason: string, siteUrl?: string | null) {
  // 站点地址缺失 / 非 https 时不给相对链接（推送里点不开），省略「查看」
  const base = siteUrl && /^https:\/\/[^/\s]+/.test(siteUrl) ? siteUrl.replace(/\/+$/, '') : null;
  const view = base ? `查看：${base}/brand/${encodeURIComponent(b.slug)}` : '';
  return {
    title: `${b.name} 状态变更`,
    body: `${b.name} 的 BYDP 状态由 ${BRAND_STATUS_TEXT[from]} 变更为 ${BRAND_STATUS_TEXT[to]}（${date}）。依据：${summary(reason)}。${view}`.trim(),
  };
}

export type BrandAdminRow = { id: string; slug: string; name: string; status: BrandStatus; statusSince: string; subscribers: number; openComplaints: number };

/** 后台品牌列表（名称 / slug 模糊搜索；最多 50 条） */
export async function listAdminBrands(db: Exec, query?: string | null): Promise<BrandAdminRow[]> {
  const like = query?.trim() ? `%${query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await q<Omit<BrandAdminRow, 'subscribers' | 'openComplaints'> & { subscribers: number; openComplaints: number }>(
    db,
    sql`select b."id", b."slug", coalesce(b."name"->>'zhHans', b."name"->>'en', b."slug") as "name", b."status", b."statusSince"::text as "statusSince",
               (select count(distinct s."userId")::int from ${schema.subscriptions} s where s."targetType" = 'brand' and s."targetId" = b."id") as "subscribers",
               (select count(*)::int from ${schema.complaints} c where c."brandId" = b."id" and c."status"::text in (${sql.join(IN_PROGRESS.map((s) => sql`${s}`), sql`, `)})) as "openComplaints"
        from ${schema.brands} b
        where ${like ? sql`(b."slug" ilike ${like} or b."name"->>'zhHans' ilike ${like} or b."id" = ${query!.trim()})` : sql`true`}
        order by b."slug" limit 50`,
  );
  return rows;
}

/**
 * 变更品牌状态。同状态 → BrandStatusError（409 invalid_transition）；evidenceCaseIds 须为该品牌的案件，否则 ComplaintInputError（409 invalid_argument）。
 * 返回新通知 id（调用方提交后入队推送）。
 */
export async function changeBrandStatus(
  db: Tx,
  a: Actor,
  brandId: string,
  input: { to: BrandStatus; reason: string; evidenceCaseIds?: string[] | null },
  opts: { siteUrl?: string | null } = {},
): Promise<{ brand: BrandAdminRow; notificationIds: string[] }> {
  const reason = checkReason(input.reason);
  const evidence = [...new Set(input.evidenceCaseIds ?? [])];
  const notificationIds = await db.transaction(async (tx) => {
    const [b] = await q<{ id: string; slug: string; name: string; status: BrandStatus; statusSince: string; relatedParty: boolean; deposit: string | null }>(
      tx,
      sql`select b."id", b."slug", coalesce(b."name"->>'zhHans', b."name"->>'en', b."slug") as "name", b."status", b."statusSince"::text as "statusSince",
                 o."relatedParty", b."certifiedDepositUsdt"::text as "deposit"
          from ${schema.brands} b join ${schema.operators} o on o."id" = b."operatorId" where b."id" = ${brandId} for update of b`,
    );
    if (!b) throw new BrandNotFoundError();
    if (b.status === input.to) throw new BrandStatusError(`品牌已是「${BRAND_STATUS_TEXT[b.status]}」`);
    // 商业背书（认证）与解除黑名单只限 admin；记审计的角色随之取 admin
    if (input.to === 'certified' || b.status === 'blacklist') {
      if (!(await getUserRoles(tx, a.id)).includes('admin')) throw new ForbiddenError('转入平台认证或离开黑名单仅限管理员');
      a = { ...a, role: 'admin' };
    }
    if (input.to === 'certified') {
      if (b.relatedParty) throw new BrandStatusError('关联方品牌不能认证', 'related_party');
      if (b.deposit == null) throw new ComplaintInputError('未登记保证金，不能转入平台认证');
    }
    if (evidence.length) {
      const found = await q<{ id: string }>(
        tx,
        sql`select "id" from ${schema.complaints} where "brandId" = ${brandId} and "id" in (${sql.join(evidence.map((id) => sql`${id}`), sql`, `)})`,
      );
      if (found.length !== evidence.length) throw new ComplaintInputError('依据案件须为该品牌的案件');
    }
    await tx.execute(sql`select set_config('bydp.actor', ${a.id}, true), set_config('bydp.status_reason', ${reason}, true)`);
    const [after] = await q<{ statusSince: string }>(
      tx,
      sql`update ${schema.brands} set "status" = ${input.to}, "statusSince" = current_date, "updatedAt" = now()
          where "id" = ${brandId} returning "statusSince"::text as "statusSince"`,
    );
    await writeAudit(
      tx,
      a,
      'brand_status_change',
      { type: 'brand', id: brandId },
      { status: b.status, statusSince: b.statusSince },
      { status: input.to, statusSince: after!.statusSince, reason, evidenceCaseIds: evidence },
    );

    // 订阅者 + 进行中案件投诉人（union 去重），一条语句批量写入（持锁期间不逐行往返）
    const n = brandStatusNotice(b, b.status, input.to, after!.statusSince, reason, opts.siteUrl);
    const rows = await q<{ id: string }>(
      tx,
      sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body")
          select 'nt_' || replace(gen_random_uuid()::text, '-', ''), u."userId", ${BRAND_STATUS_NOTICE_TYPE}, ${n.title}, ${n.body}
          from (select "userId" from ${schema.subscriptions} where "targetType" = 'brand' and "targetId" = ${brandId}
                union
                select "userId" from ${schema.complaints} where "brandId" = ${brandId}
                  and "status"::text in (${sql.join(IN_PROGRESS.map((s) => sql`${s}`), sql`, `)})) u
          returning "id"`,
    );
    const ids = rows.map((r) => r.id);
    return ids;
  });
  const brand = (await listAdminBrands(db, brandId)).find((r) => r.id === brandId)!;
  return { brand, notificationIds };
}
