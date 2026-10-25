/**
 * 搜索索引增量同步队列约定（D-019；api / web 入队、worker 消费共用；纯常量，core 不依赖 bullmq）。
 * 事件：品牌状态变更、品牌名 / 标识变更（审核台落地）、案件公开与修订。
 * 不设自定义 jobId：每次事件都处理（同一对象短时间内两次修订不能被已完成的旧任务去重吞掉）；同步本身幂等。
 */
export const SEARCH_QUEUE = 'search';
export const SEARCH_SYNC_JOB = 'sync';
export type SearchJob = { kind: 'brand' | 'case'; ids: string[] };

export function searchJobs(jobs: SearchJob[]) {
  return jobs
    .filter((j) => j.ids.length)
    .map((j) => ({
      name: SEARCH_SYNC_JOB,
      data: j,
      opts: { attempts: 5, backoff: { type: 'exponential' as const, delay: 30_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    }));
}
