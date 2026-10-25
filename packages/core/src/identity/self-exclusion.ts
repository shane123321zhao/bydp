/**
 * 自我排除（A-011 · §7 v1.8 · D-013 #3）：self_exclusion 只追加；startsAt / endsAt / identityHashes 由 DB 触发器生成。
 * 生效口径：**任一条未到期即生效，取最晚结束**（永久优先）——期内再选较短档位不会缩短既有排除（期内不可撤销）。
 * 期内拒绝：领码（含其返回的前往官网跳转链接）、添加绑定。查验、投诉与案件查看不受影响（§7 v1.8 / 原型 rg 页）。
 * permanent 另由 DB 拒绝该身份哈希再注册、以及本人新增快照外身份（0008 identity_permanent_block，审核 A-011 D1）。
 */
import { randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';

type Exec = Pick<Db, 'execute'>;
export type SelfExclusionPeriod = '30' | '90' | '180' | '365' | 'permanent';
export const SELF_EXCLUSION_PERIODS: readonly SelfExclusionPeriod[] = ['30', '90', '180', '365', 'permanent'];
/** 契约 MePayload.settings.selfExclusion：endsAt 为 null = 永久 */
export type SelfExclusionState = { period: SelfExclusionPeriod; endsAt: string | null };

/** 自我排除期内的业务拒绝 → 接口 `self_excluded` */
export class SelfExcludedError extends Error {
  constructor(public readonly state: SelfExclusionState) {
    super(state.endsAt ? `自我排除期内（至 ${state.endsAt.slice(0, 10)}）` : '已永久自我排除');
    this.name = 'SelfExcludedError';
  }
}

/** 当前生效的自我排除：未到期行中结束最晚者（永久优先）；无则 null */
export async function getSelfExclusion(db: Exec, userId: string): Promise<SelfExclusionState | null> {
  const [r] = (await db.execute(
    sql`select "period", "endsAt" from ${schema.selfExclusions}
        where "userId" = ${userId} and ("endsAt" is null or "endsAt" > now())
        order by "endsAt" desc nulls first limit 1`,
  )) as unknown as { period: SelfExclusionPeriod; endsAt: Date | string | null }[];
  return r ? { period: r.period, endsAt: r.endsAt === null ? null : new Date(r.endsAt).toISOString() } : null;
}

export async function assertNotSelfExcluded(db: Exec, userId: string): Promise<void> {
  const s = await getSelfExclusion(db, userId);
  if (s) throw new SelfExcludedError(s);
}

/** POST /me/self-exclusion：立即生效，不可撤销；返回生效后的状态（取全部未到期行中最晚者） */
export async function startSelfExclusion(db: Exec, userId: string, period: SelfExclusionPeriod): Promise<SelfExclusionState> {
  if (!SELF_EXCLUSION_PERIODS.includes(period)) throw new Error('period 不识别');
  await db.execute(sql`insert into ${schema.selfExclusions} ("id", "userId", "period") values (${`se_${randomUUID().replaceAll('-', '')}`}, ${userId}, ${period})`);
  return (await getSelfExclusion(db, userId))!;
}
