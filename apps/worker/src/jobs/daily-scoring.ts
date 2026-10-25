/**
 * 每日评分任务（架构 §5：每日 02:00 重算）：scoring 以只读角色算 → core 以 bydp_app 写快照。
 * computedAt 取任务的计划时刻（整分），保证同一次调度重跑结果一致、写入幂等（A-003 C5）。
 */
import { writeScoreSnapshots } from '@bydp/core/usecases';
import type { CoreDb } from '@bydp/core/runtime';
import { computeAll } from '@bydp/scoring';

/**
 * BullMQ 定时任务的计划时刻（自检 B1）：job.opts.timestamp 是任务「创建」时刻（约为前一次运行时），
 * 计划槽位在 opts.prevMillis（job-scheduler 写入的 nextMillis）；缺失时退回 timestamp + delay。
 */
export function scheduledSlot(job: { timestamp: number; opts: { prevMillis?: number; delay?: number } }): Date {
  return new Date(job.opts.prevMillis ?? job.timestamp + (job.opts.delay ?? 0));
}

export async function runDailyScoring(db: CoreDb, scheduledAt: Date, roUrl = process.env.DATABASE_URL_SCORING_RO) {
  const computedAt = new Date(Math.floor(scheduledAt.getTime() / 60_000) * 60_000);
  const snaps = await computeAll(computedAt, roUrl);
  const r = await writeScoreSnapshots(db, snaps);
  return { computedAt, brands: snaps.length, ...r };
}
