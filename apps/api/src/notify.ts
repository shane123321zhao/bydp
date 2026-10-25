/**
 * 通知入队（M2）：写路径事务提交后按 notificationId 入 BullMQ notify 队列，由 worker 推送。
 * 入队失败不影响请求结果（站内通知已写入），只记日志；未配置 REDIS_URL 时不入队。
 */
import { NOTIFY_QUEUE, notifyJobs } from '@bydp/core/notify/queue';
import { SEARCH_QUEUE, searchJobs, type SearchJob } from '@bydp/core/search/queue';
import { Queue } from 'bullmq';

export type Notify = (ids: string[]) => Promise<void>;
export const noNotify: Notify = async () => {};

export function bullmqNotifier(redisUrl: string): Notify {
  const queue = new Queue(NOTIFY_QUEUE, { connection: { url: redisUrl } });
  return async (ids) => {
    if (ids.length) await queue.addBulk(notifyJobs(ids));
  };
}

/** D-019：搜索索引增量同步入队（worker 消费）；失败不影响请求结果（每日全量重建兜底） */
export type SearchSync = (jobs: SearchJob[]) => Promise<void>;
export const noSearchSync: SearchSync = async () => {};
export function bullmqSearchSync(redisUrl: string): SearchSync {
  const queue = new Queue(SEARCH_QUEUE, { connection: { url: redisUrl } });
  return async (jobs) => {
    const j = searchJobs(jobs);
    if (j.length) await queue.addBulk(j);
  };
}
