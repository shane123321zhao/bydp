/**
 * Telegram Login Widget 回调校验（A-009 §1；算法见 core.telegram.org/widgets/login#checking-authorization）：
 *   data_check_string = 除 hash 外全部字段按 key 字典序、`key=value` 以 \n 连接（字段按收到的原样参与，未来新增字段也覆盖）
 *   secret_key = SHA256(bot_token)；hash 须等于 hex(HMAC-SHA256(secret_key, data_check_string))，常量时间比较
 *   auth_date 须在 [now − maxAgeSec, now + 60s 时钟容差] 内
 * 纯函数，不连 DB；bot token 由调用方从环境变量传入，本模块不读取、不记录。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TELEGRAM_LOGIN_MAX_AGE_SEC = 600;
const CLOCK_SKEW_SEC = 60;

export type TelegramLoginResult =
  | { ok: true; user: { id: string; username: string | null; firstName: string | null } }
  | { ok: false; reason: 'malformed' | 'bad_hash' | 'expired' | 'future' };

export function telegramCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
}

export function verifyTelegramLogin(
  raw: Record<string, unknown>,
  botToken: string,
  opts: { nowSec?: number; maxAgeSec?: number } = {},
): TelegramLoginResult {
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN 未设置');
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, reason: 'malformed' };
    if (!/^[a-z_]{1,32}$/.test(k)) return { ok: false, reason: 'malformed' };
    fields[k] = String(v);
  }
  const hash = (fields.hash ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash) || !/^\d{1,20}$/.test(fields.id ?? '') || !/^\d{1,12}$/.test(fields.auth_date ?? ''))
    return { ok: false, reason: 'malformed' };

  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(telegramCheckString(fields)).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'bad_hash' };

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const authDate = Number(fields.auth_date);
  if (authDate > now + CLOCK_SKEW_SEC) return { ok: false, reason: 'future' };
  if (now - authDate > (opts.maxAgeSec ?? TELEGRAM_LOGIN_MAX_AGE_SEC)) return { ok: false, reason: 'expired' };
  return { ok: true, user: { id: fields.id!, username: fields.username ?? null, firstName: fields.first_name ?? null } };
}
