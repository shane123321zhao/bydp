/**
 * Redis 联调（D-008「Redis 联调（等 Docker）」）：真实 Redis + BullMQ——调度器触发的任务带计划槽位（自检 B1 在真实 BullMQ 上成立），
 * 消费者跑通一次评分重算（事务内执行后回滚）。需 REDIS_URL；另需 DATABASE_URL + DATABASE_URL_SCORING_RO 才跑重算部分。
 * 每次用独立队列名，结束时 obliterate，不影响生产队列 `scoring`。
 */
import { Queue, QueueEvents } from 'bullmq';
import { connect } from '@bydp/core/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { runDailyScoring } from '../src/jobs/daily-scoring';
import { createMaintenanceWorker, NOTIFY_RETRY_ID, PURGE_DEVICES_ID, PURGE_TOKENS_ID, RECONCILE_OBJECTS_ID, REPLY_WINDOW_ID, SCREENING_ID, scheduleMaintenance } from '../src/maintenance-queue';
import { createNotifyWorker, enqueueNotifications } from '../src/notify-queue';
import { createScoringWorker, DAILY_SCHEDULER_ID, scheduleDailyScoring, scoringConnection } from '../src/scoring-queue';

const redis = process.env.REDIS_URL;
const url = process.env.DATABASE_URL;
const ro = process.env.DATABASE_URL_SCORING_RO;
const conn = redis && url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());

async function withQueue<T>(fn: (name: string, queue: Queue) => Promise<T>) {
  const name = `scoring-test-${process.pid}-${Date.now()}`;
  const connection = scoringConnection(redis);
  const queue = new Queue(name, { connection });
  try {
    return await fn(name, queue);
  } finally {
    await queue.obliterate({ force: true });
    await queue.close();
  }
}

describe.skipIf(!redis)('Redis 联调：BullMQ 调度 + 消费', () => {
  it('每日调度默认关闭：enabled=false 时移除调度器；开启后注册 02:00 cron', async () => {
    await withQueue(async (_name, queue) => {
      expect(await scheduleDailyScoring(queue, true, 'Asia/Shanghai')).toBe(true);
      const s = await queue.getJobScheduler(DAILY_SCHEDULER_ID);
      expect(s).toMatchObject({ key: DAILY_SCHEDULER_ID, pattern: '0 2 * * *', tz: 'Asia/Shanghai' });
      expect(await scheduleDailyScoring(queue, false)).toBe(false);
      expect(await queue.getJobScheduler(DAILY_SCHEDULER_ID)).toBeFalsy();
    });
  });

  it.skipIf(!url || !ro)('调度器触发的任务 → 消费者拿到计划槽位（整秒对齐）并完成一次重算（回滚）', async () => {
    const out = await withQueue(async (name, queue) => {
      const connection = scoringConnection(redis);
      const events = new QueueEvents(name, { connection });
      await events.waitUntilReady();
      const seen: Date[] = [];
      const worker = createScoringWorker(
        connection,
        async (scheduledAt) => {
          seen.push(scheduledAt);
          let r: Awaited<ReturnType<typeof runDailyScoring>> | undefined;
          await conn!.db
            .transaction(async (tx) => {
              r = await runDailyScoring(tx as never, scheduledAt, ro);
              tx.rollback();
            })
            .catch((e: Error) => {
              if (!/rollback/i.test(e.message)) throw e;
            });
          return r;
        },
        name,
      );
      try {
        const done = new Promise<unknown>((resolve, reject) => {
          events.on('completed', ({ returnvalue }) => resolve(returnvalue));
          events.on('failed', ({ failedReason }) => reject(new Error(failedReason)));
        });
        const t0 = Date.now();
        await queue.upsertJobScheduler('t', { every: 60_000 }, { name: 't' });
        const result = (await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20_000))])) as {
          brands: number;
          inserted: number;
        };
        return { result, seen, t0 };
      } finally {
        await worker.close();
        await events.close();
      }
    });
    expect(out.seen).toHaveLength(1);
    // every 调度的槽位对齐到窗口边界：在触发前后一个周期内
    expect(Math.abs(out.seen[0]!.getTime() - out.t0)).toBeLessThan(60_000);
    expect(out.result).toMatchObject({ brands: 8, inserted: 8 });
  }, 30_000);

  it('维护队列：每小时第 17 分清理过期登录令牌；消费者只处理该任务名', async () => {
    await withQueue(async (name, queue) => {
      await scheduleMaintenance(queue);
      expect(await queue.getJobScheduler(PURGE_TOKENS_ID)).toMatchObject({ key: PURGE_TOKENS_ID, pattern: '17 * * * *' });
      expect(await queue.getJobScheduler(REPLY_WINDOW_ID)).toMatchObject({ key: REPLY_WINDOW_ID, pattern: '5 * * * *' });
      expect(await queue.getJobScheduler(RECONCILE_OBJECTS_ID)).toMatchObject({ key: RECONCILE_OBJECTS_ID, pattern: '41 3 * * *' });
      expect(await queue.getJobScheduler(PURGE_DEVICES_ID)).toMatchObject({ key: PURGE_DEVICES_ID, pattern: '13 4 * * *' });
      expect(await queue.getJobScheduler(SCREENING_ID)).toMatchObject({ key: SCREENING_ID, pattern: '*/10 * * * *' });
      expect(await queue.getJobScheduler(NOTIFY_RETRY_ID)).toMatchObject({ key: NOTIFY_RETRY_ID, pattern: '23 * * * *' });
      const connection = scoringConnection(redis);
      const events = new QueueEvents(name, { connection });
      await events.waitUntilReady();
      let purged = 0;
      const worker = createMaintenanceWorker(connection, { [PURGE_TOKENS_ID]: async () => ++purged }, name);
      try {
        const done = new Promise((resolve) => events.on('completed', resolve));
        await queue.add(PURGE_TOKENS_ID, {});
        await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000))]);
        expect(purged).toBe(1);
      } finally {
        await worker.close();
        await events.close();
      }
    });
  }, 30_000);

  it('通知队列：按 notificationId 入队（同 id 重复入队去重），消费者逐条推送', async () => {
    await withQueue(async (name, queue) => {
      const connection = scoringConnection(redis);
      const events = new QueueEvents(name, { connection });
      await events.waitUntilReady();
      const seen: string[] = [];
      const worker = createNotifyWorker(connection, async (id) => void seen.push(id), name);
      try {
        let done = 0;
        const all = new Promise<void>((resolve) => events.on('completed', () => ++done === 2 && resolve()));
        await enqueueNotifications(queue, ['nt_a', 'nt_b']);
        await enqueueNotifications(queue, ['nt_a']); // 去重
        await Promise.race([all, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000))]);
        expect(seen.sort()).toEqual(['nt_a', 'nt_b']);
        expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({ waiting: 0, active: 0, delayed: 0 });
      } finally {
        await worker.close();
        await events.close();
      }
    });
  }, 30_000);
});
