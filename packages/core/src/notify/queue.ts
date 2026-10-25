/**
 * 通知推送队列约定（api 入队、worker 消费共用；纯常量，core 不依赖 bullmq）。
 * jobId = notificationId（重复入队去重）；失败指数退避重试 5 次，首次 1 分钟。
 */
export const NOTIFY_QUEUE = 'notify';
export const DELIVER_JOB = 'deliver';

export function notifyJobs(ids: string[]) {
  return ids.map((id) => ({
    name: DELIVER_JOB,
    data: { notificationId: id },
    opts: { jobId: id, attempts: 5, backoff: { type: 'exponential' as const, delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
  }));
}

/**
 * 补推（D-016 第 7 项）：jobId 带 6 小时桶——同一窗口内重复扫描不重复入队；每次补推只尝试 1 次（不再叠加 5 次退避）。
 * 一条推不出去的通知在 7 天窗口内最多被补推 28 次（自检 I6），之后不再扫描。
 */
export const RETRY_WINDOW_HOURS = 6;
export function retryBucket(now = new Date()): string {
  const h = Math.floor(now.getTime() / 3_600_000 / RETRY_WINDOW_HOURS);
  return String(h);
}
export function retryJobs(ids: string[], bucket = retryBucket()) {
  return notifyJobs(ids).map((j) => ({ ...j, opts: { ...j.opts, jobId: `${j.data.notificationId}#r${bucket}`, attempts: 1 } }));
}
