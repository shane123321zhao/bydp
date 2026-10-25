/**
 * 维护队列：每小时清理过期的 magic link 令牌（A-009：verification_token 取出即删，未使用的过期令牌由此清理）；
 * 每小时第 5 分做答辩期提醒与标记（§9.2 v1.7：只读，结果供 M3 仲裁台与管理员告警，不自动曝光）；
 * 每日 03:41 证据对象删除对账（审核 admin 第 2 轮（下）：已删 / 已替换的原文若仍在 R2 则重删）；
 * 每日 04:13 清理注销满 180 天的设备行（§9.2 v1.11）；
 * D-016：每 10 分钟投诉初筛、每日 05:37 本地化初稿、每小时第 47 分站点监控（一批）、每日 06:09 品牌属性采集（Agent，bydp_agent 连接）；
 * 每小时第 23 分通知补推扫描；每日 04:29 清理过期的站点监控记录（90 天）与去刷计数（30 天）；
 * D-019：每日 04:51 搜索索引全量重建（Meilisearch 已配置时注册）；
 * D-020 #4：每日 01:07 运维巡检（磁盘可用 < 25GB / 数据库时区非 UTC / #7 超过 26 小时无成功备份 → 告警推送 admin）。
 * 与评分队列分开，互不阻塞。
 */
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const MAINTENANCE_QUEUE = 'maintenance';
export const PURGE_TOKENS_ID = 'purge-verification-tokens';
/** §9.2 v1.7：答辩期提醒与标记（只读，不改状态、不曝光） */
export const REPLY_WINDOW_ID = 'reply-window-watch';
export const RECONCILE_OBJECTS_ID = 'reconcile-deleted-objects';
export const PURGE_DEVICES_ID = 'purge-anonymized-devices';

/** D-016：Agent 任务（以 bydp_agent 连接运行）与通知补推 */
export const SCREENING_ID = 'agent-complaint-screening';
export const LOCALIZATION_ID = 'agent-localization';
export const NOTIFY_RETRY_ID = 'notify-retry-scan';
export const SITE_MONITOR_ID = 'agent-site-monitor';
export const COLLECTOR_ID = 'agent-brand-collector';
export const PURGE_AGENT_DATA_ID = 'purge-agent-data';
export const SEARCH_REBUILD_ID = 'search-rebuild';
export const OPS_HEALTH_ID = 'ops-health';

/** 任务名 → 调度表达式（全部在维护队列，串行执行） */
export const MAINTENANCE_SCHEDULE: Record<string, string> = {
  [PURGE_TOKENS_ID]: '17 * * * *',
  [REPLY_WINDOW_ID]: '5 * * * *',
  [RECONCILE_OBJECTS_ID]: '41 3 * * *',
  [PURGE_DEVICES_ID]: '13 4 * * *',
  [SCREENING_ID]: '*/10 * * * *',
  [LOCALIZATION_ID]: '37 5 * * *',
  [NOTIFY_RETRY_ID]: '23 * * * *',
  [SITE_MONITOR_ID]: '47 * * * *',
  [COLLECTOR_ID]: '9 6 * * *',
  [PURGE_AGENT_DATA_ID]: '29 4 * * *',
  [SEARCH_REBUILD_ID]: '51 4 * * *',
  [OPS_HEALTH_ID]: '7 1 * * *',
};

export async function scheduleMaintenance(queue: Queue, names: string[] = Object.keys(MAINTENANCE_SCHEDULE)) {
  for (const name of names) await queue.upsertJobScheduler(name, { pattern: MAINTENANCE_SCHEDULE[name]! }, { name });
  // 本次未注册的任务（如未配置 Agent 连接）删除其调度器，免得旧调度在 Redis 里空跑、静默「完成」（自检 S4）
  for (const name of Object.keys(MAINTENANCE_SCHEDULE)) if (!names.includes(name)) await queue.removeJobScheduler(name);
}

/** 任务名 → 处理函数；未注册的任务名忽略（如 Agent 连接未配置时不注册 Agent 任务） */
export function createMaintenanceWorker(connection: ConnectionOptions, handlers: Record<string, () => Promise<unknown>>, queueName = MAINTENANCE_QUEUE) {
  return new Worker(
    queueName,
    async (job) => {
      const h = handlers[job.name];
      if (!h) throw new Error(`维护任务 ${job.name} 未注册处理函数`);
      return h();
    },
    { connection, concurrency: 1 },
  );
}
