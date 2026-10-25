import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptContact, encryptContact, identityBlindIndex, identityKeysFromEnv, InvalidEmailError, maskEmail, maskTelegram, normalizeEmail } from '../src/identity/pii';

const K1 = randomBytes(32);
const K2 = randomBytes(32);

describe('身份个人数据（A-009 §2）', () => {
  it('A-009 签核条件 5：规范化口径写死 = NFKC → 去首尾空白 → 全小写；不去 Gmail 点号、不去 + 后缀', () => {
    expect(normalizeEmail('Ke.Li+promo@Gmail.com')).toBe('ke.li+promo@gmail.com');
    expect(identityBlindIndex('email', 'keli@gmail.com', K1)).not.toBe(identityBlindIndex('email', 'ke.li@gmail.com', K1));
    expect(identityBlindIndex('email', 'ke.li+a@gmail.com', K1)).not.toBe(identityBlindIndex('email', 'ke.li@gmail.com', K1));
  });

  it('自检阻塞 3：规范化后严格校验——多收件人 / 显示名 / 引号 / 多个 @ / 非 ASCII 域名 / 超长 一律拒绝（不回显输入）', () => {
    for (const bad of ['victim@x.com,attacker@evil.com', 'x <victim@x.com>', '"a@evil.com"@victim.com', 'a@b@c.com', 'a b@c.com', 'a@localhost', '@x.com', 'a@例子.公司', `${'a'.repeat(65)}@x.com`, `a@${'b'.repeat(250)}.com`])
      expect(() => normalizeEmail(bad), bad).toThrow(InvalidEmailError);
    expect(() => normalizeEmail('x <victim@x.com>')).toThrow(/^邮箱格式不合法$/);
    expect(() => identityBlindIndex('email', 'a@x.com,b@y.com', K1)).toThrow(InvalidEmailError);
    expect(normalizeEmail("o'brien+tag@sub.example.co.uk")).toBe("o'brien+tag@sub.example.co.uk");
  });

  it('邮箱规范化：全角 / 大小写 / 首尾空白 → 同一盲索引；64 位 hex；不同密钥不同索引', () => {
    expect(normalizeEmail('  Ｋｅ.Li@Gmail.COM ')).toBe('ke.li@gmail.com');
    const a = identityBlindIndex('email', 'Ke.Li@gmail.com', K1);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(identityBlindIndex('email', ' ke.li@GMAIL.com', K1)).toBe(a);
    expect(identityBlindIndex('email', 'ke.li@gmail.com', K2)).not.toBe(a);
  });

  it('provider 前缀隔离：同一串值在 TG / 邮箱下索引不同；TG id 须为数字', () => {
    // 邮箱侧已严格校验，纯数字不再是合法邮箱；这里直接断言 provider 前缀参与了 HMAC
    expect(identityBlindIndex('telegram', '424242', K1)).toBe(createHmac('sha256', K1).update('telegram:424242').digest('hex'));
    expect(identityBlindIndex('telegram', '424242', K1)).not.toBe(createHmac('sha256', K1).update('424242').digest('hex'));
    expect(() => identityBlindIndex('telegram', 'am_test', K1)).toThrow(/数字/);
  });

  it('联系方式 AES-256-GCM：往返一致、每次密文不同、密文不含明文；篡改或换密钥解密失败', () => {
    const s1 = encryptContact('ke.li@gmail.com', K1, 'idn_a');
    const s2 = encryptContact('ke.li@gmail.com', K1, 'idn_a');
    expect(s1).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(s1).not.toBe(s2);
    expect(s1).not.toContain('gmail');
    expect(decryptContact(s1, K1, 'idn_a')).toBe('ke.li@gmail.com');
    const [v, iv, ct, tag] = s1.split(':');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0]! ^= 1;
    expect(() => decryptContact([v, iv, flipped.toString('base64'), tag].join(':'), K1, 'idn_a')).toThrow();
    expect(() => decryptContact(s1, K2, 'idn_a')).toThrow();
  });

  it('A-009 签核条件 2：密文绑定 identity.id——把 A 行的密文挪到 B 行，解密失败', () => {
    const sealedForA = encryptContact('attacker@evil.com', K1, 'idn_a');
    expect(() => decryptContact(sealedForA, K1, 'idn_b')).toThrow();
    expect(() => encryptContact('x@y.z', K1, 'not-an-id')).toThrow(/identityId/);
  });

  it('密钥须为 32 字节 base64，缺失直接报错', () => {
    expect(() => identityKeysFromEnv({})).toThrow(/IDENTITY_HMAC_KEY/);
    expect(() => identityKeysFromEnv({ IDENTITY_HMAC_KEY: K1.toString('base64'), AUTH_PII_KEY: 'c2hvcnQ=' })).toThrow(/AUTH_PII_KEY/);
    expect(identityKeysFromEnv({ IDENTITY_HMAC_KEY: K1.toString('base64'), AUTH_PII_KEY: K2.toString('base64') }).piiKey.equals(K2)).toBe(true);
  });

  it('掩码句柄与 seed 同口径', () => {
    expect(maskEmail('Kevin@Gmail.com')).toBe('ke***@g***.com');
    expect(maskTelegram('am_test', '424242')).toBe('@am***');
    expect(maskTelegram(null, '424242')).toBe('TG ***42');
  });
});
