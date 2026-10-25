import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 运营商账号字段级加密（A-011 · §7 v1.8）：AES-256-GCM(AUTH_PII_KEY)，AAD = `bydp-binding-account-v1:<binding.id>`，
 * 格式与 identity.contactEnc 相同 `v1:iv:ct:tag`（base64）。与盲索引同放 @bydp/db：core 写绑定、seed、存量回填脚本共用同一实现。
 * 对外只用写入时计算的掩码（operatorAccountIdMasked）；解密只在仲裁 / 赔付核对时进行（M3）。
 */
const aad = (bindingId: string) => {
  if (!/^ubb_[A-Za-z0-9_-]{1,64}$/.test(bindingId)) throw new Error('bindingId 格式不识别');
  return Buffer.from(`bydp-binding-account-v1:${bindingId}`);
};

/** AUTH_PII_KEY：32 字节 base64；缺失即报错（不提供默认值） */
export function bindingPiiKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const b64 = env.AUTH_PII_KEY;
  const k = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
  if (k.length !== 32) throw new Error('AUTH_PII_KEY 缺失或不是 32 字节 base64');
  return k;
}

export function encryptOperatorAccountId(plain: string, key: Buffer, bindingId: string): string {
  if (key.length !== 32) throw new Error('AUTH_PII_KEY 须为 32 字节');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(bindingId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join(':');
}

export function decryptOperatorAccountId(sealed: string, key: Buffer, bindingId: string): string {
  const [v, iv, ct, tag] = sealed.split(':');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('operatorAccountIdEnc 格式不识别');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(aad(bindingId));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/**
 * 对外唯一展示形态（上线前置 #18 定稿，A-012）：露出位数 = min(5, ⌊长度 / 3⌋)，前段取一半（向上取整、≤ 3 位）、其余在后段，
 * 中间以 * 补齐原长度；长度 < 3 全遮。例：12 位 → ab********yz；15 位 → abc**********yz。
 * 掩码列只写一次：本口径只对 A-012 之后的新写入生效（测试站存量不回改）。
 */
export function maskOperatorAccount(s: string): string {
  const chars = [...s];
  const reveal = Math.min(5, Math.floor(chars.length / 3));
  if (reveal === 0) return '*'.repeat(Math.max(chars.length, 3));
  const front = Math.min(3, Math.ceil(reveal / 2));
  const back = reveal - front;
  return chars.slice(0, front).join('') + '*'.repeat(chars.length - reveal) + (back ? chars.slice(-back).join('') : '');
}
