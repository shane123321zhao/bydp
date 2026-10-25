import { createHmac } from 'node:crypto';

/**
 * 运营商账号盲索引（§7 v1.3 / R3）：HMAC-SHA256(key, 规范化账号) → 64 位小写十六进制。
 * key 只来自环境变量 BINDING_HMAC_KEY；不提供默认值，缺失即报错（避免生产误用弱密钥）。
 * 规范化：去首尾空白。大小写保持原样（运营商账号是否大小写敏感待 M2 接入时按运营商确认）。
 */
export function hashOperatorAccountId(operatorAccountId: string, key: string): string {
  if (!key || key.length < 32) throw new Error('BINDING_HMAC_KEY 缺失或过短（至少 32 字符）');
  return createHmac('sha256', key).update(operatorAccountId.trim()).digest('hex');
}

/**
 * 账号规范化（审查 #11）：NFKC（全角 → 半角）+ 去除全部空白。绑定写入（core createBinding）与转化回传（tracking）
 * 必须用同一函数，否则盲索引对不上（A-007 G4）。大小写是否敏感待 M2 接入运营商时确认，暂保留原样。
 */
export function normalizeOperatorAccountId(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

export function bindingHmacKeyFromEnv(): string {
  const key = process.env.BINDING_HMAC_KEY;
  if (!key) throw new Error('BINDING_HMAC_KEY 未设置');
  return key;
}
