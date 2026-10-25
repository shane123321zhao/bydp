/**
 * 通知入队（与 apps/api/src/notify.ts 同口径）：写路径事务提交后按 notificationId 入 BullMQ notify 队列，由 worker 推送。
 * 入队失败不影响请求结果（站内通知已写入），只记日志；未配置 REDIS_URL 时不入队。
 */
import { NOTIFY_QUEUE, notifyJobs } from '@bydp/core/notify/queue';
import { Queue } from 'bullmq';

let queue: Queue | null | undefined;

export async function enqueueNotifications(ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (queue === undefined) queue = process.env.REDIS_URL ? new Queue(NOTIFY_QUEUE, { connection: { url: process.env.REDIS_URL } }) : null;
  if (!queue) return;
  await queue.addBulk(notifyJobs(ids)).catch((e: Error) => console.error(JSON.stringify({ evt: 'notify_enqueue_failed', count: ids.length, error: e.message })));
}
