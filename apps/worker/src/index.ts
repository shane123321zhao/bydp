/**
 * apps/worker：BullMQ 消费者。M1 只注册每日评分任务；采集 / 监控 / 初筛 / 通知属 M3。
 * 时区：SCORING_TZ（默认 Asia/Shanghai，首发市场 UTC+7~+8；部署时须与 DB 时区口径一起定，见 A-001 签核备注 6）。
 */
import { Queue } from 'bullmq';
import { replyWindowWatch } from '@bydp/core/complaint/arbitration';
import { purgeExpiredVerificationTokens } from '@bydp/core/identity/auth';
import { resendSender } from '@bydp/core/identity/magic-link-email';
import { purgeAnonymizedDevices } from '@bydp/core/identity/device';
import { identityKeysFromEnv } from '@bydp/core/identity/pii';
import { deliverNotification, listUndeliveredNotifications, telegramSender, uatTestEmailMatcher } from '@bydp/core/notify/deliver';
import { NOTIFY_QUEUE, retryJobs } from '@bydp/core/notify/queue';
import { connectAgent } from '@bydp/agents/db';
import { runLocalization } from '@bydp/agents/localization';
import { runScreening } from '@bydp/agents/screening';
import { runSiteMonitor } from '@bydp/agents/site-monitor';
import { runCollector } from '@bydp/agents/collector';
import { purgeCandidateQueries, purgeSiteChecks } from '@bydp/core/trust/candidate-queries';
import { reconcileDeletedObjects } from '@bydp/core/admin/object-reconcile';
import { connect } from '@bydp/core/runtime';
import { assertDbUtc, createAlerter, diskAvailableGb, DISK_ALERT_GB, errorSummary } from '@bydp/core/ops';
import { R2Client, r2ConfigFromEnv, r2EvidenceStore } from '@bydp/core/storage/r2';
import { runDailyScoring } from './jobs/daily-scoring';
import {
  createMaintenanceWorker,
  LOCALIZATION_ID,
  MAINTENANCE_QUEUE,
  NOTIFY_RETRY_ID,
  PURGE_DEVICES_ID,
  PURGE_TOKENS_ID,
  RECONCILE_OBJECTS_ID,
  PURGE_AGENT_DATA_ID,
  REPLY_WINDOW_ID,
  scheduleMaintenance,
  SCREENING_ID,
  SITE_MONITOR_ID,
  COLLECTOR_ID,
  SEARCH_REBUILD_ID,
  OPS_HEALTH_ID,
} from './maintenance-queue';
import { createNotifyWorker } from './notify-queue';
import { createSearchWorker } from './search-queue';
import { meiliFromEnv } from '@bydp/core/search/meili';
import { rebuildSearchIndexes, syncSearchDocs } from '@bydp/core/search/indexer';
import { createScoringWorker, scheduleDailyScoring, SCORING_QUEUE, scoringConnection } from './scoring-queue';

async function main() {
  const connection = scoringConnection();
  const { db } = connect();
  // D-020 #4：启动检查——数据库会话时区必须 UTC（日期字段依赖），不符拒绝启动
  await assertDbUtc(db);
  const alert = createAlerter({
    db,
    keys: () => identityKeysFromEnv(),
    send: () => (process.env.TELEGRAM_BOT_TOKEN ? telegramSender() : null),
    env: process.env.BYDP_ENV,
  });
  // A-009：维护任务（清理过期登录令牌）始终开启，与评分开关无关
  const notifyQueue = new Queue(NOTIFY_QUEUE, { connection });
  const handlers: Record<string, () => Promise<unknown>> = {
    [PURGE_TOKENS_ID]: async () => {
      const n = await purgeExpiredVerificationTokens(db);
      console.log(`[maintenance] purged verification_token=${n}`);
      return n;
    },
    [REPLY_WINDOW_ID]: async () => {
      const w = await replyWindowWatch(db);
      console.log(JSON.stringify({ evt: 'reply_window_watch', secondNoticeDue: w.secondNoticeDue.map((x) => x.id), pendingExposureDecision: w.pendingExposureDecision.map((x) => x.id) }));
      return { secondNoticeDue: w.secondNoticeDue.length, pendingExposureDecision: w.pendingExposureDecision.length };
    },
    [RECONCILE_OBJECTS_ID]: async () => {
      // 证据对象删除对账：R2 未配置时跳过（不报错）
      const r2 = r2ConfigFromEnv();
      if (!r2) return { skipped: 'r2_not_configured' };
      const r = await reconcileDeletedObjects(db, r2EvidenceStore(new R2Client(r2), process.env.R2_BUCKET_EVIDENCE ?? 'bydp-evidence'));
      console.log(JSON.stringify({ evt: 'evidence_object_reconcile', ...r }));
      return r;
    },
    [PURGE_DEVICES_ID]: async () => {
      const n = await purgeAnonymizedDevices(db);
      console.log(JSON.stringify({ evt: 'purge_anonymized_devices', deleted: n }));
      return { deleted: n };
    },
    // D-016 第 7 项：补推（bydp_app；推送本身幂等）
    [NOTIFY_RETRY_ID]: async () => {
      const ids = await listUndeliveredNotifications(db);
      if (ids.length) await notifyQueue.addBulk(retryJobs(ids));
      console.log(JSON.stringify({ evt: 'notify_retry_scan', requeued: ids.length }));
      return { requeued: ids.length };
    },
    [PURGE_AGENT_DATA_ID]: async () => {
      const r = { siteChecks: await purgeSiteChecks(db), candidateQueries: await purgeCandidateQueries(db) };
      console.log(JSON.stringify({ evt: 'purge_agent_data', ...r }));
      return r;
    },
  };
  // D-019 搜索：Meili 已配置（worker 持 master key）才注册全量重建与增量消费者。
  // 重建期间暂停增量消费者（避免增量写进即将被 swap 换掉的旧索引），恢复后排队任务按最新数据重放；启动先重建一次，失败按退避重试
  const meili = meiliFromEnv(process.env, 'write');
  if (meili) {
    const searchWorker = createSearchWorker(connection, async (job) => {
      const r = await syncSearchDocs(db, meili, job);
      console.log(JSON.stringify({ evt: 'search_sync', kind: job.kind, ...r }));
      return r;
    });
    const rebuild = async () => {
      await searchWorker.pause();
      try {
        const r = await rebuildSearchIndexes(db, meili);
        console.log(JSON.stringify({ evt: 'search_rebuild', ...r }));
        return r;
      } finally {
        searchWorker.resume();
      }
    };
    handlers[SEARCH_REBUILD_ID] = rebuild;
    void (async () => {
      for (let i = 0, wait = 5_000; i < 8; i++, wait = Math.min(wait * 2, 300_000)) {
        try {
          return await rebuild();
        } catch (e) {
          console.error(JSON.stringify({ evt: 'search_rebuild_failed', attempt: i + 1, error: (e as Error).message }));
          if (i === 7) await alert('search_rebuild_failed', `启动时搜索索引重建 8 次均失败（查询已自动降级 Postgres）：${errorSummary(e)}`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    })();
  } else console.log('搜索索引未启用（MEILI_URL / MEILI_MASTER_KEY 未设置），查询走 Postgres');
  // D-016 Agent 任务：只以 bydp_agent 连接运行（§13 v1.12 ①）；未配置连接串时不注册（不回落到 bydp_app）
  if (process.env.DATABASE_URL_AGENT) {
    const agent = connectAgent().db;
    handlers[SCREENING_ID] = async () => {
      const r = await runScreening(agent);
      console.log(JSON.stringify({ evt: 'agent_screening', ...r }));
      return r;
    };
    // 出网抓取类（站点监控 / 品牌属性采集）另需 AGENT_CRAWL_ENABLED=1：演示库的品牌是虚构的，其域名可能属于无关的真实网站，
    // 默认不对其发起抓取；有真实品牌数据后由 PO 决定开启（测试站验收用一次性脚本对指定测试标识运行）
    if (process.env.AGENT_CRAWL_ENABLED === '1') {
      handlers[SITE_MONITOR_ID] = async () => {
        const r = await runSiteMonitor(agent);
        console.log(JSON.stringify({ evt: 'agent_site_monitor', ...r }));
        return r;
      };
      handlers[COLLECTOR_ID] = async () => {
        const r = await runCollector(agent);
        console.log(JSON.stringify({ evt: 'agent_collector', ...r }));
        return r;
      };
    } else console.log('Agent 抓取任务未启用（AGENT_CRAWL_ENABLED≠1）');
    handlers[LOCALIZATION_ID] = async () => {
      const r = await runLocalization(agent);
      console.log(JSON.stringify({ evt: 'agent_localization', ...r }));
      return r;
    };
  } else console.log('Agent 任务未启用（DATABASE_URL_AGENT 未设置）');
  // D-020 #4：每日运维巡检（磁盘 / 时区），异常推送 admin
  handlers[OPS_HEALTH_ID] = async () => {
    const gb = await diskAvailableGb('/');
    // 阈值可由 DISK_ALERT_GB 覆盖（测试站临时 15GB，正式环境默认 25GB · 协调官 D-020 裁定）
    const min = Number(process.env.DISK_ALERT_GB) > 0 ? Number(process.env.DISK_ALERT_GB) : DISK_ALERT_GB;
    if (gb < min) await alert('disk_low', `服务器磁盘可用 ${gb}GB（< ${min}GB）：清理构建缓存 docker builder prune -af 或扩容`);
    await assertDbUtc(db).catch((e: Error) => alert('db_timezone', e.name === 'DbTimezoneError' ? e.message : errorSummary(e)));
    // D-020 #7：备份新鲜度——backup.sh 成功后写 Redis bydp:backup:last（UTC 秒）；超过 26 小时无成功备份即告警（worker 不持备份桶令牌）
    if (process.env.BACKUP_EXPECTED === '1') {
      const last = Number(await (await notifyQueue.client).get('bydp:backup:last'));
      const hours = last > 0 ? (Date.now() / 1000 - last) / 3600 : Infinity;
      if (hours > 26) await alert('backup_stale', last > 0 ? `最近一次成功备份在 ${Math.floor(hours)} 小时前（应每日一次）` : '没有成功备份记录（检查 crontab 与 ~/bydp-backup.log）');
    }
    console.log(JSON.stringify({ evt: 'ops_health', diskAvailableGb: gb }));
    return { diskAvailableGb: gb };
  };
  await scheduleMaintenance(new Queue(MAINTENANCE_QUEUE, { connection }), Object.keys(handlers));
  const maint = createMaintenanceWorker(connection, handlers);
  // 维护任务失败（重试耗尽前每次都会触发）→ 告警（同一任务 10 分钟内只推一次）
  maint.on('failed', (job, e) => void alert(`maintenance_failed:${job?.name ?? '?'}`, `维护任务失败：${errorSummary(e)}（详见 worker 日志）`));
  // M2 通知推送：始终开启；联系方式只在推送时解密，结果只记渠道 / 跳过原因（不记收件人）
  const keys = identityKeysFromEnv();
  // W2#023：测试站 UAT 测试账号不收通知邮件（只写站内）；正式环境为 undefined
  const isTestEmail = uatTestEmailMatcher();
  createNotifyWorker(connection, async (id) => {
    const r = await deliverNotification(db, id, { keys, telegram: () => telegramSender(), email: () => resendSender(), emailFrom: () => process.env.EMAIL_FROM, isTestEmail });
    console.log(`[notify] ${id} ${r.status}${'channel' in r ? ` ${r.channel}` : ` ${r.reason}`}`);
    return r;
  });
  const queue = new Queue(SCORING_QUEUE, { connection });
  // D-004：每日评分任务默认关闭，须显式 SCORING_DAILY_ENABLED=true 才注册（演示库重算核对通过前一律停用）
  if (!(await scheduleDailyScoring(queue, process.env.SCORING_DAILY_ENABLED === 'true'))) {
    console.log('daily-scoring 未启用（SCORING_DAILY_ENABLED≠true）');
    return;
  }
  createScoringWorker(connection, async (scheduledAt) => {
    const r = await runDailyScoring(db, scheduledAt);
    console.log(`[scoring] ${r.computedAt.toISOString()} brands=${r.brands} inserted=${r.inserted} skipped=${r.skipped}`);
    return r;
  });
  console.log('bydp worker started (queue: scoring, 02:00 daily)');
}
void main();
