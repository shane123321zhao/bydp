/**
 * apps/tg-bot 进程（D-017）：Webhook 模式。Caddy 把 `/tg/webhook` 转到本进程（不经测试站门禁，由 secret token 鉴别）。
 * - Telegram 每次请求携带 `X-Telegram-Bot-Api-Secret-Token`，与 TG_WEBHOOK_SECRET 不符一律 401（grammY 校验）；
 * - 启动时若配置了 TG_WEBHOOK_URL 则调用 setWebhook（只收 message / callback_query）；令牌与密钥只从环境变量读取，不打印；
 * - 只以 bydp_app 连接数据库（DATABASE_URL）；Redis 用于命令限流。
 */
import http from 'node:http';
import { RedisRateCounter } from '@bydp/core/identity/auth';
import { identityHmacKeyFromEnv } from '@bydp/core/identity/pii';
import { connect } from '@bydp/core/runtime';
import { assertDbUtc } from '@bydp/core/ops';
import { webhookCallback } from 'grammy';
import Redis from 'ioredis';
import { createBot } from './bot';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} 未设置`);
  return v;
};

async function main() {
  const token = need('TELEGRAM_BOT_TOKEN');
  const secret = need('TG_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('TG_WEBHOOK_SECRET 须为 32–256 位 [A-Za-z0-9_-]');
  const { db } = connect();
  await assertDbUtc(db); // D-020 #4：数据库会话时区必须 UTC
  const bot = createBot({ db, hmacKey: identityHmacKeyFromEnv(), counter: new RedisRateCounter(new Redis(need('REDIS_URL'))), siteUrl: need('AUTH_URL'), token });
  await bot.init();
  const handle = webhookCallback(bot, 'http', { secretToken: secret });
  const port = Number(process.env.PORT ?? 3300);
  http
    .createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') return void res.writeHead(200).end('ok');
      if (req.method === 'POST' && req.url === '/tg/webhook') {
        // 请求体上限 1MB（Telegram 更新远小于此）
        const len = Number(req.headers['content-length'] ?? 0);
        if (len > 1024 * 1024) return void res.writeHead(413).end();
        return void handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
        });
      }
      res.writeHead(404).end();
    })
    .listen(port, () => console.log(`bydp tg-bot listening on ${port}`));
  const url = process.env.TG_WEBHOOK_URL;
  if (url) {
    await bot.api.setWebhook(url, { secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
    console.log(JSON.stringify({ evt: 'tg_webhook_set', host: new URL(url).host }));
  } else console.log('TG_WEBHOOK_URL 未设置：不注册 webhook');
}
void main().catch((e) => {
  console.error(JSON.stringify({ evt: 'tg_bot_start_failed', message: (e as Error).message.slice(0, 200) }));
  process.exit(1);
});
