/**
 * 宿主脚本（backup.sh 等）发告警的入口（D-020 #7）：在 worker 容器内执行，复用 core createAlerter（推送 admin 的 TG，同口径不含用户数据）。
 * 用法：docker compose exec -T worker ./node_modules/.bin/tsx src/cli/alert.ts <事件名> <说明>
 *       docker compose exec -T worker ./node_modules/.bin/tsx src/cli/alert.ts --check   # 只自检告警通道（不发送）：打印可收到 TG 告警的 admin 数
 * 事件名只允许 [a-z0-9_:-]，说明截断 300 字；推送失败不影响退出码（告警本身不能让调用方再失败一次）。
 */
import { connect } from '@bydp/core/runtime';
import { createAlerter } from '@bydp/core/ops';
import { countAdminTelegramTargets } from '@bydp/core/identity/auth';
import { identityKeysFromEnv } from '@bydp/core/identity/pii';
import { telegramSender } from '@bydp/core/notify/deliver';

const [evt = '', detail = ''] = process.argv.slice(2);
if (evt === '--check') {
  // 告警通道自检（go-live-check 用）：Bot 令牌已配置 + 至少 1 个 admin 绑定了 TG（只计数，不解密联系方式、不发送）
  const { db, client } = connect();
  try {
    console.log(JSON.stringify({ botToken: !!process.env.TELEGRAM_BOT_TOKEN, adminTelegram: await countAdminTelegramTargets(db) }));
  } finally {
    await client.end();
  }
  process.exit(0);
}
if (!/^[a-z0-9_:-]{1,64}$/.test(evt)) {
  console.error('用法：alert.ts <事件名 [a-z0-9_:-]> <说明>');
  process.exit(2);
}
const { db, client } = connect();
try {
  const alert = createAlerter({ db, keys: () => identityKeysFromEnv(), send: () => (process.env.TELEGRAM_BOT_TOKEN ? telegramSender() : null), env: process.env.BYDP_ENV });
  await alert(evt, detail.slice(0, 300));
} finally {
  await client.end();
}
process.exit(0);
