/**
 * postback 验签（A-007 §2）：HMAC-SHA256(secret, `${timestamp}.${rawBody}`)，十六进制，常量时间比较；
 * |now − timestamp| ≤ timeWindowSec。密钥本体只在环境变量 / KMS，库里只存引用名（operator_integration.postbackSecretRef）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from '@bydp/db';
import { POSTBACK_SECRET_MIN_LENGTH } from './params';
import { rows, type Exec } from './rows';

export type IntegrationLookup =
  | { ok: true; secret: string; windowSec: number }
  | { ok: false; reason: 'no_integration' | 'secret_ref_invalid' | 'secret_missing' };

/** 引用名只能落在 POSTBACK_SECRET_ 命名空间：防止对接配置指向 BINDING_HMAC_KEY / DATABASE_URL 等其他环境变量 */
const SECRET_REF = /^POSTBACK_SECRET_[A-Z0-9_]{1,48}$/;

export async function loadPostbackIntegration(
  db: Exec,
  brandId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<IntegrationLookup> {
  const [row] = await rows<{ ref: string; windowSec: number }>(
    db,
    sql`select "postbackSecretRef" as "ref", "timeWindowSec" as "windowSec"
        from "operator_integration" where "brandId" = ${brandId} and "status" = 'active'`,
  );
  if (!row) return { ok: false, reason: 'no_integration' };
  if (!SECRET_REF.test(row.ref)) return { ok: false, reason: 'secret_ref_invalid' };
  const secret = env[row.ref];
  if (!secret || secret.length < POSTBACK_SECRET_MIN_LENGTH) return { ok: false, reason: 'secret_missing' };
  return { ok: true, secret, windowSec: row.windowSec };
}

export function signPostback(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'bad_signature' };

export function verifyPostbackSignature(p: {
  secret: string;
  /** Unix 秒 */
  timestamp: string | null | undefined;
  /** 64 位十六进制，可带 `sha256=` 前缀 */
  signature: string | null | undefined;
  rawBody: string;
  windowSec: number;
  nowMs?: number;
}): SignatureCheck {
  const ts = p.timestamp ?? '';
  const sig = (p.signature ?? '').replace(/^sha256=/, '').toLowerCase();
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'malformed' };
  if (Math.abs((p.nowMs ?? Date.now()) / 1000 - Number(ts)) > p.windowSec) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signPostback(p.secret, ts, p.rawBody), 'hex');
  return timingSafeEqual(expected, Buffer.from(sig, 'hex')) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
