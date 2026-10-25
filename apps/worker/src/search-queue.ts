/**
 * 搜索索引增量同步（D-019）：api 在品牌状态变更 / 审核台落地 / 案件公开后按对象入队，此处写入 Meilisearch。
 * 队列约定见 @bydp/core/search/queue；Meili 未配置时不启动消费者（任务留在队列，配置后补做；每日全量重建兜底）。
 */
import { SEARCH_QUEUE, SEARCH_SYNC_JOB, type SearchJob } from '@bydp/core/search/queue';
import { type ConnectionOptions, Worker } from 'bullmq';

export { SEARCH_QUEUE };

export function createSearchWorker<R>(connection: ConnectionOptions, sync: (job: SearchJob) => Promise<R>, queueName = SEARCH_QUEUE) {
  return new Worker(
    queueName,
    async (job) => {
      const d = job.data as Partial<SearchJob> | undefined;
      if (job.name !== SEARCH_SYNC_JOB || (d?.kind !== 'brand' && d?.kind !== 'case') || !Array.isArray(d.ids)) return undefined;
      return sync({ kind: d.kind, ids: d.ids.filter((x): x is string => typeof x === 'string') });
    },
    { connection, concurrency: 1 },
  );
}
