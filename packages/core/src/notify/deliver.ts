/**
 * 通知推送（worker 消费 notify 队列时调用）：按用户最早的登录身份选渠道——TG 用户经 Bot 私信，邮箱用户经 Resend。
 * 联系方式只在此处解密，不落日志。TG 用户若从未与 Bot 对话，Telegram 拒绝私信（403）→ 记为 skipped、不重试；
 * 其他发送失败抛错，由队列重试。站内通知始终保留，不依赖推送成功。
 * A-010：推送成功后回写 notification.deliveredAt / channel（成对，CHECK 约束）；已回写的不再重发（队列重试 / 重复入队幂等）。
 * A-012（#19）：跳过（TG 已屏蔽 Bot / 无联系方式）回写 skippedAt / skipReason，补推扫描据此排除；已跳过的不再重试。
 * W2#023：测试站 UAT 测试账号（isTestEmail 命中）的邮箱不作为推送联系方式——记 no_contact 跳过、不发信（站内通知照常保留；登录信不经此处，不受影响）。
 *   Resend 免费档每日 100 封，UAT 的判定 / 投诉 / 数据请求通知曾占满额度（24 小时 282 封全部发往 +uat 测试账号）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { getNotifyTarget, type AuthKeys } from '../identity/auth';
import type { SendEmail } from '../identity/magic-link-email';

const EXCLUSION = '不向中国大陆居民提供服务。';

export type SendTelegram = (chatId: string, text: string) => Promise<'ok' | 'blocked'>;

/** Telegram Bot API sendMessage；403（用户未启动 / 已屏蔽 Bot）→ blocked；其他非 2xx 抛错（不回显 token） */
export function telegramSender(botToken = process.env.TELEGRAM_BOT_TOKEN, fetchImpl: typeof fetch = fetch): SendTelegram {
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN 未设置');
  return async (chatId, text) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (res.status === 403) return 'blocked';
    if (!res.ok) throw new Error(`Telegram 发送失败：HTTP ${res.status}`);
    return 'ok';
  };
}

export type DeliverResult =
  | { status: 'sent'; channel: 'telegram' | 'email' }
  | { status: 'skipped'; reason: 'not_found' | 'no_contact' | 'tg_blocked' | 'already_delivered' | 'already_skipped' };

async function markSkipped(db: Pick<Db, 'execute'>, id: string, reason: 'tg_blocked' | 'no_contact'): Promise<DeliverResult> {
  await db.execute(sql`update ${schema.notifications} set "skippedAt" = now(), "skipReason" = ${reason} where "id" = ${id} and "deliveredAt" is null and "skippedAt" is null`);
  return { status: 'skipped', reason };
}

async function markDelivered(db: Pick<Db, 'execute'>, id: string, channel: 'telegram' | 'email'): Promise<DeliverResult> {
  await db.execute(sql`update ${schema.notifications} set "deliveredAt" = now(), "channel" = ${channel} where "id" = ${id} and "deliveredAt" is null`);
  return { status: 'sent', channel };
}

export async function deliverNotification(
  db: Pick<Db, 'execute'>,
  notificationId: string,
  d: { keys: AuthKeys; telegram: () => SendTelegram; email: () => SendEmail; emailFrom: () => string | undefined; isTestEmail?: (email: string) => boolean },
): Promise<DeliverResult> {
  const [n] = (await db.execute(
    sql`select "userId", "title", "body", "deliveredAt" is not null as "delivered", "skippedAt" is not null as "skipped" from ${schema.notifications} where "id" = ${notificationId}`,
  )) as unknown as { userId: string; title: string; body: string | null; delivered: boolean; skipped: boolean }[];
  if (!n) return { status: 'skipped', reason: 'not_found' };
  if (n.delivered) return { status: 'skipped', reason: 'already_delivered' };
  if (n.skipped) return { status: 'skipped', reason: 'already_skipped' };
  const target = await getNotifyTarget(db, n.userId, d.keys);
  if (!target) return markSkipped(db, notificationId, 'no_contact');
  const text = [n.title, n.body ?? '', '', EXCLUSION].join('\n').replace(/\n{3,}/g, '\n\n');
  if (target.provider === 'telegram') {
    return (await d.telegram()(target.contact, text)) === 'blocked' ? markSkipped(db, notificationId, 'tg_blocked') : markDelivered(db, notificationId, 'telegram');
  }
  if (d.isTestEmail?.(target.contact)) return markSkipped(db, notificationId, 'no_contact');
  const from = d.emailFrom();
  if (!from) throw new Error('EMAIL_FROM 未设置');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await d.email()({
    from,
    to: target.contact,
    subject: `BYDP 博弈点评 · ${n.title}`,
    text,
    html: `<!doctype html><html lang="zh-Hans"><body style="font-family:system-ui,sans-serif;line-height:1.6"><p><b>${esc(n.title)}</b></p><p>${esc(n.body ?? '')}</p><p style="font-size:12px;color:#666">${EXCLUSION}</p></body></html>`,
  });
  return markDelivered(db, notificationId, 'email');
}

/**
 * 补推扫描（D-016 第 7 项 · A-010「至少一次」）：未成功推送（deliveredAt 空）且未被跳过（skippedAt 空）的通知，
 * 发出 15 分钟后、7 天内的重新入队；推送本身幂等（已回写 deliveredAt 的不再发）。
 */
export async function listUndeliveredNotifications(db: Pick<Db, 'execute'>, limit = 500): Promise<string[]> {
  const rows = (await db.execute(
    sql`select "id" from ${schema.notifications}
        where "deliveredAt" is null and "skippedAt" is null and "sentAt" < now() - interval '15 minutes' and "sentAt" > now() - interval '7 days'
        order by "sentAt" desc limit ${limit}`, // 新的优先：积压的坏通知不会把新失败的挤出补推（自检 I6）
  )) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * W2#023：测试站 UAT 测试账号邮箱识别（与 UAT 工具同一口径：PO #26 测试邮箱本地部分 + 「+uat」别名）。只在 BYDP_ENV=staging 生效，其他环境返回 undefined（不压任何邮件）。
 * 失败即关：测试站未配置 UAT_MAILBOX_LOCALPART 时，任何 Gmail「+uat」别名都视为测试账号（宁可多压，不让测试流量占满发信额度）。
 */
export function uatTestEmailMatcher(env: Record<string, string | undefined> = process.env): ((email: string) => boolean) | undefined {
  if (env.BYDP_ENV !== 'staging') return undefined;
  const local = (env.UAT_MAILBOX_LOCALPART ?? '').trim().toLowerCase();
  const re = /^[a-z0-9.]{1,64}$/.test(local) ? new RegExp(`^${local.replaceAll('.', '\\.')}\\+uat[a-z0-9]{1,24}@gmail\\.com$`) : /\+uat[a-z0-9]{1,24}@gmail\.com$/;
  return (email) => re.test(email.trim().toLowerCase());
}
