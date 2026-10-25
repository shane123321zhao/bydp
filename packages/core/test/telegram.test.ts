import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { telegramCheckString, verifyTelegramLogin } from '../src/identity/telegram';

const TOKEN = '123456:TEST-token-not-real';
const NOW = 1_790_000_000;
const base = { id: 424242, first_name: 'A', username: 'am_test', photo_url: 'https://t.me/i/userpic/320/x.jpg', auth_date: NOW - 30 };

/** 按官方文档逐字实现的独立算法（不经被测模块），用于生成期望 hash */
function sign(fields: Record<string, string | number>) {
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  return createHmac('sha256', createHash('sha256').update(TOKEN).digest()).update(dcs).digest('hex');
}

describe('verifyTelegramLogin（A-009）', () => {
  it('官方算法：字典序 key=value 以 \\n 连接，hash 不参与', () => {
    expect(telegramCheckString({ username: 'u', id: '1', hash: 'x', auth_date: '9' })).toBe('auth_date=9\nid=1\nusername=u');
  });

  it('签名正确且在时间窗内 → 通过（数字 / 字符串字段均可，hash 大小写不敏感）', () => {
    const r = verifyTelegramLogin({ ...base, hash: sign(base).toUpperCase() }, TOKEN, { nowSec: NOW });
    expect(r).toEqual({ ok: true, user: { id: '424242', username: 'am_test', firstName: 'A' } });
    const s = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, String(v)]));
    expect(verifyTelegramLogin({ ...s, hash: sign(s) }, TOKEN, { nowSec: NOW }).ok).toBe(true);
  });

  it('篡改任一字段 / 增加字段 / 换 bot token → bad_hash', () => {
    const hash = sign(base);
    expect(verifyTelegramLogin({ ...base, id: 424243, hash }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'bad_hash' });
    expect(verifyTelegramLogin({ ...base, username: 'admin', hash }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'bad_hash' });
    expect(verifyTelegramLogin({ ...base, is_admin: 1, hash }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'bad_hash' });
    expect(verifyTelegramLogin({ ...base, hash }, '999:other', { nowSec: NOW })).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('auth_date 超过 10 分钟 → expired；来自未来（超 60s 容差）→ future；边界内通过', () => {
    const at = (d: number) => ({ ...base, auth_date: d });
    expect(verifyTelegramLogin({ ...at(NOW - 601), hash: sign(at(NOW - 601)) }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyTelegramLogin({ ...at(NOW + 61), hash: sign(at(NOW + 61)) }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'future' });
    expect(verifyTelegramLogin({ ...at(NOW - 600), hash: sign(at(NOW - 600)) }, TOKEN, { nowSec: NOW }).ok).toBe(true);
  });

  it('畸形输入 → malformed（缺 hash / id 非数字 / 非法 key / 嵌套值）；未配置 token 直接报错', () => {
    expect(verifyTelegramLogin({ ...base }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyTelegramLogin({ ...base, id: 'x1', hash: sign({ ...base, id: 'x1' }) }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyTelegramLogin({ ...base, 'a\nid': '1', hash: sign(base) }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyTelegramLogin({ ...base, extra: { x: 1 }, hash: sign(base) }, TOKEN, { nowSec: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(() => verifyTelegramLogin({ ...base, hash: sign(base) }, '')).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
