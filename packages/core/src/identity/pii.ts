/**
 * 登录身份的个人数据处理（A-009 §2）。纯函数，不连 DB；密钥只经参数或环境变量传入，本模块不记录。
 * - 盲索引：identity.providerAccountId / verification_token.identifierHash = HMAC-SHA256(IDENTITY_HMAC_KEY, `${provider}:${规范化值}`)，64 位 hex。
 *   带 provider 前缀，避免 TG 数字 id 与邮箱在索引空间里相撞。
 * - 联系方式：identity.contactEnc = AES-256-GCM(AUTH_PII_KEY)，格式 `v1:iv:ciphertext:tag`（base64）；
 *   AAD = `bydp-identity-contact-v1:${identity.id}`——密文与行绑定，挪到别的行上解密失败（A-009 签核条件 2）。只在发通知时解密。
 * - 掩码句柄：identity.handle 的展示形态（与 seed 同口径：`@am***`、`ke***@g***.com`）。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export type IdentityProvider = 'telegram' | 'email';

const aad = (identityId: string) => {
  if (!/^idn_[A-Za-z0-9_]{1,64}$/.test(identityId)) throw new Error('identityId 格式不识别');
  return Buffer.from(`bydp-identity-contact-v1:${identityId}`);
};

/**
 * 邮箱规范化（A-009 签核条件 5 口径写死）：NFKC → 去首尾空白 → 全部小写；不去 Gmail 点号、不去 + 后缀。
 * 规范化后严格校验（自检阻塞 3：自定义 normalizeIdentifier 会绕过 Auth.js 默认校验）：恰好一个 @、无引号 / 逗号 / 空白 / 尖括号、
 * 长度 ≤ 254（本地部分 ≤ 64）、域名为 ASCII 且含点。不合格抛错——`a@x.com,b@y.com`、`x <v@x.com>` 这类不会进入盲索引或收件人。
 */
export function normalizeEmail(email: string): string {
  const e = email.normalize('NFKC').trim().toLowerCase();
  const at = e.indexOf('@');
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (
    e.length > 254 ||
    at < 1 ||
    at !== e.lastIndexOf('@') ||
    local.length > 64 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
    !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)
  )
    throw new InvalidEmailError();
  return e;
}

export class InvalidEmailError extends Error {
  constructor() {
    super('邮箱格式不合法'); // 不回显输入
    this.name = 'InvalidEmailError';
  }
}

function normalize(provider: IdentityProvider, value: string) {
  if (provider === 'email') return normalizeEmail(value);
  const id = value.trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('telegram id 须为数字');
  return id;
}

function keyBytes(b64: string | undefined, name: string): Buffer {
  const k = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
  if (k.length !== 32) throw new Error(`${name} 缺失或不是 32 字节 base64`);
  return k;
}

/** 只取盲索引密钥（Candidate 去刷计数等只需 HMAC 的场景，不要求 PII 加密密钥） */
export function identityHmacKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  return keyBytes(env.IDENTITY_HMAC_KEY, 'IDENTITY_HMAC_KEY');
}

export function identityKeysFromEnv(env: Record<string, string | undefined> = process.env) {
  return { hmacKey: keyBytes(env.IDENTITY_HMAC_KEY, 'IDENTITY_HMAC_KEY'), piiKey: keyBytes(env.AUTH_PII_KEY, 'AUTH_PII_KEY') };
}

export function identityBlindIndex(provider: IdentityProvider, value: string, hmacKey: Buffer): string {
  if (hmacKey.length !== 32) throw new Error('IDENTITY_HMAC_KEY 须为 32 字节');
  return createHmac('sha256', hmacKey).update(`${provider}:${normalize(provider, value)}`).digest('hex');
}

export function encryptContact(plain: string, piiKey: Buffer, identityId: string): string {
  if (piiKey.length !== 32) throw new Error('AUTH_PII_KEY 须为 32 字节');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', piiKey, iv);
  c.setAAD(aad(identityId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join(':');
}

export function decryptContact(sealed: string, piiKey: Buffer, identityId: string): string {
  const [v, iv, ct, tag] = sealed.split(':');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('contactEnc 格式不识别');
  const d = createDecipheriv('aes-256-gcm', piiKey, Buffer.from(iv, 'base64'));
  d.setAAD(aad(identityId));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = normalizeEmail(email).split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 2)}***@${domain.slice(0, 1)}***${tld}`;
}

export function maskTelegram(username: string | null, id: string): string {
  return username ? `@${username.slice(0, 2)}***` : `TG ***${id.slice(-2)}`;
}
