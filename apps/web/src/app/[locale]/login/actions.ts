'use server';
/**
 * 登录页服务端动作（D-010 / design-system §15）：邮箱 magic link。
 * 顺序：地区（451 口径）→ 格式（core 严格校验）→ 限流只读预判（「发送太频繁」提示）→ Auth.js 发信。
 * 真正的限流拦截在发信时（core magicLinkAllowed），这里的预判只为给出提示；不论邮箱是否已注册，成功文案一致。
 */
import { magicLinkWouldAllow } from '@bydp/core/identity/auth';
import { identityKeysFromEnv, InvalidEmailError, maskEmail, normalizeEmail } from '@bydp/core/identity/pii';
import { headers } from 'next/headers';
import { signIn } from '../../../auth';
import { clientIp, rateCounter } from '../../../lib/rate-counter';
import { safeCallback } from '../../../lib/safe-callback';

export type MagicLinkState = { step: 'form'; error?: 'format' | 'rate' | 'region' | 'send'; email?: string } | { step: 'sent'; masked: string };

const BLOCKED = new Set((process.env.GEO_BLOCK_COUNTRIES ?? 'CN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

export async function requestMagicLink(_prev: MagicLinkState, form: FormData): Promise<MagicLinkState> {
  const h = await headers();
  if (BLOCKED.has((h.get('cf-ipcountry') ?? '').toUpperCase())) return { step: 'form', error: 'region' };
  const raw = String(form.get('email') ?? '');
  let email: string;
  try {
    email = normalizeEmail(raw);
  } catch (e) {
    if (e instanceof InvalidEmailError) return { step: 'form', error: 'format', email: raw.slice(0, 254) };
    throw e;
  }
  const req = new Request('https://internal/', { headers: h });
  if (!(await magicLinkWouldAllow(rateCounter(), { email, ip: clientIp(req) }, identityKeysFromEnv()))) return { step: 'form', error: 'rate', email: raw };
  // Auth.js v5 的 signIn(redirect:false) 在发信失败时不抛错，只返回带 ?error= 的地址——两种情况都要当作失败
  let failed = false;
  try {
    const url = await signIn('resend', { email, redirect: false, redirectTo: safeCallback(String(form.get('callbackUrl') ?? '')) });
    failed = typeof url === 'string' && /[?&]error=/.test(url);
  } catch {
    failed = true;
  }
  if (failed) {
    // 发信服务异常（Resend 故障 / 配置缺失）：行内提示，不暴露细节；日志不含邮箱
    console.error(JSON.stringify({ evt: 'magic_link_send_failed' }));
    return { step: 'form', error: 'send', email: raw };
  }
  return { step: 'sent', masked: maskEmail(email) };
}
