/**
 * 积分发放（A-010 · §9.2 v1.7）：只追加 points_event；分值由 DB 触发器按当前生效规则写入（应用层不定分值），
 * 余额与等级由触发器派生。dedupeKey 保证同一事由只发一次（重复调用静默忽略）；规则停用时不发放、不报错，
 * 以免发分失败拖垮上游业务事务（回传确认 / 投诉结案）。
 */
import { randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';

type Exec = Pick<Db, 'execute'>;
export type PointsEvent = 'binding_confirmed' | 'withdrawal_report_accepted' | 'review_published' | 'complaint_resolved';
export type PointsRef = 'binding' | 'withdrawal_report' | 'review' | 'complaint';

/** 等级门槛（与迁移 0007 触发器一致）：Lv1 0 · Lv2 500 · Lv3 1500 · Lv4 3000 · Lv5 6000 */
export const LEVEL_THRESHOLDS = [0, 500, 1500, 3000, 6000] as const;

/** 下一级门槛与差额；已满级为 null */
export function nextLevel(points: number): { level: number; at: number; gap: number } | null {
  const i = LEVEL_THRESHOLDS.findIndex((t) => points < t);
  return i === -1 ? null : { level: i + 1, at: LEVEL_THRESHOLDS[i]!, gap: LEVEL_THRESHOLDS[i]! - points };
}

/** 发分：返回实际记入的分值；已发过 / 规则停用 → 0 */
export async function awardPoints(
  db: Exec,
  p: { userId: string; event: PointsEvent; refType: PointsRef; refId: string; dedupeKey: string },
): Promise<number> {
  const rows = (await db.execute(
    sql`insert into ${schema.pointsEvents} ("id", "userId", "event", "points", "refType", "refId", "dedupeKey")
        select ${`pe_${randomUUID().replaceAll('-', '')}`}, ${p.userId}, ${p.event}, 1, ${p.refType}, ${p.refId}, ${p.dedupeKey}
        where exists (select 1 from ${schema.pointsRules} r where r."event" = ${p.event} and r."active")
        on conflict ("dedupeKey") do nothing
        returning "points"`,
  )) as unknown as { points: number }[];
  return rows[0]?.points ?? 0;
}
