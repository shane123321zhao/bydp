/**
 * 评分队列（BullMQ）：调度注册与消费者创建分离出来，供 index.ts 与 Redis 联调测试共用。
 * 处理函数只拿到计划时刻（scheduledSlot，自检 B1），不接触 job 其他字段。
 */
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { scheduledSlot } from './jobs/daily-scoring';

export const SCORING_QUEUE = 'scoring';
export const DAILY_SCHEDULER_ID = 'daily-scoring';

export function scoringConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): ConnectionOptions {
  return { url };
}

/** 每日 02:00（SCORING_TZ）重算；enabled=false 时移除调度（D-004：默认关闭） */
export async function scheduleDailyScoring(queue: Queue, enabled: boolean, tz = process.env.SCORING_TZ ?? 'Asia/Shanghai') {
  if (!enabled) {
    await queue.removeJobScheduler(DAILY_SCHEDULER_ID);
    return false;
  }
  await queue.upsertJobScheduler(DAILY_SCHEDULER_ID, { pattern: '0 2 * * *', tz }, { name: DAILY_SCHEDULER_ID });
  return true;
}

export function createScoringWorker<R>(connection: ConnectionOptions, handle: (scheduledAt: Date) => Promise<R>, queueName = SCORING_QUEUE) {
  return new Worker(queueName, async (job) => handle(scheduledSlot(job as unknown as Parameters<typeof scheduledSlot>[0])), { connection, concurrency: 1 });
}
