/**
 * W2#010（D-026）：测试站门禁由 Caddy Basic Auth 改为 Cookie 门禁——Basic Auth 下 React 偶发 #418（本地 9/600，无认证 0/900），
 * 正式站没有门禁，用户不受影响。
 * - Caddy（deploy/site-mode.staging.caddy 的 env_gate）：请求不带 `bydp_gate=<STAGING_GATE_TOKEN>` → 改写到 `GET /internal/gate`（口令页，401）；
 *   `POST /__gate` → 改写到 `POST /internal/gate`（校验口令）。/internal/* 只在 compose 内网可达（主站 Caddy 只转发 /v1/*）。
 * - 口令正确：Set-Cookie（HttpOnly · Secure · SameSite=Lax · 30 天）并 303 回原地址；原地址只收站内相对路径。
 * - 防暴力：每 IP 每分钟 ≤ 10 次提交（共享计数器）；计数器故障时拒绝（失败即关，门禁不是记账）。
 * - 口令与 Cookie 值只在 .env.prod（bootstrap 生成），不进日志；正式环境（BYDP_ENV=production）不注册。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { RateCounter } from '@bydp/core/identity/auth';

export const GATE_COOKIE = 'bydp_gate';
export const GATE_NEXT_HEADER = 'X-Bydp-Gate-Next';
const MAX_PER_MINUTE = 10;
const MAX_AGE = 30 * 24 * 3600;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;

export type GateConfig = { password: string; token: string };

export function gateConfigFromEnv(env: Record<string, string | undefined> = process.env): GateConfig | null {
  if (env.BYDP_ENV === 'production') return null;
  const password = env.STAGING_GATE_PASSWORD?.trim();
  const token = env.STAGING_GATE_TOKEN?.trim();
  if (!password || !token) return null;
  // Caddy 用正则匹配 Cookie 值：只允许十六进制，避免正则元字符
  if (!/^[a-f0-9]{32,128}$/.test(token)) throw new Error('STAGING_GATE_TOKEN 须为 32–128 位小写十六进制');
  return { password, token };
}

/** 回跳地址只收站内相对路径（防开放跳转）；否则回首页 */
export function safeNext(raw: string | undefined | null): string {
  if (!raw || raw.length > 2000) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/__gate')) return '/';
  return [...raw].some((ch) => ch.charCodeAt(0) < 0x20) ? '/' : raw;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function page(next: string, msg = '') {
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>测试环境</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:360px;margin:18vh auto;padding:0 16px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;margin-top:8px}p.e{font-weight:700}</style></head>
<body><h1 style="font-size:18px">测试环境</h1><p>请输入访问口令。</p>${msg ? `<p class="e" role="alert">${esc(msg)}</p>` : ''}
<form method="post" action="/__gate"><input type="hidden" name="next" value="${esc(next)}"><input type="password" name="password" autocomplete="current-password" aria-label="访问口令" required autofocus><button type="submit">进入</button></form></body></html>`;
}

const html = (c: Context, body: string, status: 401 | 429) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.html(body, status);
};

const socketAddr = (c: Context): string | undefined =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;

export function registerStagingGate(app: Hono, cfg: GateConfig | null, counter: RateCounter, opts: { trustProxy?: boolean } = {}) {
  if (!cfg) return;
  const clientIp = (c: Context) => {
    const ip = (opts.trustProxy ? c.req.header('CF-Connecting-IP') : undefined) ?? socketAddr(c);
    return ip && IP.test(ip) ? ip : 'unknown';
  };

  app.get('/internal/gate', (c) => html(c, page(safeNext(c.req.header(GATE_NEXT_HEADER))), 401));

  app.post('/internal/gate', async (c) => {
    let n: number;
    try {
      n = await counter.hit(`gate:${clientIp(c)}`, 60);
    } catch {
      return html(c, page('/', '暂时无法验证，请稍后再试'), 429);
    }
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const next = safeNext(typeof form.next === 'string' ? form.next : '/');
    if (n > MAX_PER_MINUTE) return html(c, page(next, '尝试次数过多，请 1 分钟后再试'), 429);
    // W2#017：复制口令常带尾部空格 / 换行；服务端口令本身已 trim，两边同口径
    const pw = typeof form.password === 'string' ? form.password.trim() : '';
    if (!pw || pw.length > 256 || !same(pw, cfg.password)) return html(c, page(next, '口令不正确'), 401);
    c.header('Set-Cookie', `${GATE_COOKIE}=${cfg.token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
    c.header('Cache-Control', 'no-store');
    return c.redirect(next, 303);
  });
}
