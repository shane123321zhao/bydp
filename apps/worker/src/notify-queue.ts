/**
 * 通知推送队列（M2 notifications）：api / worker 在投诉状态变更的事务提交后，按 notificationId 入队；此处消费并推送（TG / 邮件）。
 * 队列名 / 任务参数见 @bydp/core/notify/queue（api 与 worker 共用）。TG 屏蔽 / 无联系方式属正常跳过，不重试。
 */
import { DELIVER_JOB, NOTIFY_QUEUE, notifyJobs } from '@bydp/core/notify/queue';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export { NOTIFY_QUEUE };

export async function enqueueNotifications(queue: Queue, ids: string[]) {
  if (ids.length) await queue.addBulk(notifyJobs(ids));
}

export function createNotifyWorker<R>(connection: ConnectionOptions, deliver: (notificationId: string) => Promise<R>, queueName = NOTIFY_QUEUE) {
  return new Worker(
    queueName,
    async (job) => {
      if (job.name !== DELIVER_JOB || typeof job.data?.notificationId !== 'string') return undefined;
      return deliver(job.data.notificationId);
    },
    { connection, concurrency: 4 },
  );
}
