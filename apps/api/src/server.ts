import { serve } from '@hono/node-server';
import { connect } from '@bydp/core/runtime';
import { R2Client, r2ConfigFromEnv, r2EvidenceStore } from '@bydp/core/storage/r2';
import { createApp } from './app';
import { bullmqNotifier, bullmqSearchSync, noNotify, noSearchSync } from './notify';
import { adminSessionFromEnv, sessionFromEnv } from './session';
import { sharedRateCounter } from './rate';
import { assertDbUtc, createAlerter } from '@bydp/core/ops';
import { identityKeysFromEnv } from '@bydp/core/identity/pii';
import { telegramSender } from '@bydp/core/notify/deliver';
import type { PostbackLog } from './routes/postback';

const { db } = connect();
// D-020 #4：启动检查——数据库会话时区必须 UTC，不符拒绝启动
await assertDbUtc(db);
// alert 级日志 → 推送 admin（TG，同事件 10 分钟一次）
const alert = createAlerter({ db, keys: () => identityKeysFromEnv(), send: () => (process.env.TELEGRAM_BOT_TOKEN ? telegramSender() : null), env: process.env.BYDP_ENV });
const postbackLog = (e: PostbackLog) => {
  (e.level === 'alert' ? console.error : e.level === 'info' ? console.info : console.warn)(JSON.stringify(e));
  if (e.evt === 'postback_rejected' && e.level === 'alert') void alert(`postback_${e.reason.split(':')[0]}`, `品牌 ${e.brandId} · HTTP ${e.status} · ${e.reason}`);
};
const port = Number(process.env.PORT ?? 8787);
// BYDP_TRUST_PROXY=1：部署在可信反代（Caddy 用真实对端覆盖 CF-Connecting-IP / 正式环境为 Cloudflare）之后，postback 限流按真实来源 IP
const notify = process.env.REDIS_URL ? bullmqNotifier(process.env.REDIS_URL) : noNotify;
const searchSync = process.env.REDIS_URL ? bullmqSearchSync(process.env.REDIS_URL) : noSearchSync;
// 证据原文存 R2（未配置时文件上传返回 503，交易哈希类证据不受影响）
const r2 = r2ConfigFromEnv();
const evidenceStore = r2 ? r2EvidenceStore(new R2Client(r2), process.env.R2_BUCKET_EVIDENCE ?? 'bydp-evidence') : undefined;
serve({ fetch: createApp(db, { resolveUser: sessionFromEnv(), resolveAdminUser: adminSessionFromEnv(), notify, searchSync, evidenceStore, counter: sharedRateCounter(), postback: { trustProxy: process.env.BYDP_TRUST_PROXY === '1', log: postbackLog } }).fetch, port });
console.log(`bydp api on :${port} (/v1/openapi.json)`);
