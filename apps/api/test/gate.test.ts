/** W2#010：测试站 Cookie 门禁（Caddy 改写到 /internal/gate）。口令 / Cookie 值为测试常量，不连库、不出网。 */
import { Hono } from 'hono';
import { MemoryRateCounter, type RateCounter } from '@bydp/core/identity/auth';
import { describe, expect, it } from 'vitest';
import { GATE_NEXT_HEADER, gateConfigFromEnv, registerStagingGate, safeNext } from '../src/gate';

const CFG = { password: 'test-gate-password', token: 'ab'.repeat(16) };

function setup(counter: RateCounter = new MemoryRateCounter()) {
  const app = new Hono();
  registerStagingGate(app as never, CFG, counter, { trustProxy: true });
  const submit = (password: string, next = '/offers', ip = '203.0.113.7') =>
    app.request('/internal/gate', {
      method: 'POST',
      body: new URLSearchParams({ password, next }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
    });
  return { app, submit };
}

describe('测试站 Cookie 门禁', () => {
  it('口令页：401、noindex、不缓存，回跳地址转义后放进表单', async () => {
    const { app } = setup();
    const r = await app.request('/internal/gate', { headers: { [GATE_NEXT_HEADER]: '/check/a"><script>x</script>' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    expect(html).toContain('action="/__gate"');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('口令正确 → 303 回原地址 + HttpOnly / Secure / SameSite=Lax / 30 天 Cookie；口令错误 → 401 无 Cookie', async () => {
    const { submit } = setup();
    const ok = await submit(CFG.password);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/offers');
    const ck = ok.headers.get('set-cookie')!;
    expect(ck).toContain(`bydp_gate=${CFG.token}`);
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${30 * 24 * 3600}`, 'Path=/']) expect(ck).toContain(a);
    // W2#017：复制时带上的首尾空格 / 换行不影响
    expect((await submit(`  ${CFG.password} \n`)).status).toBe(303);
    const bad = await submit('wrong');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect(await bad.text()).toContain('口令不正确');
  });

  it('回跳只收站内相对路径（防开放跳转）', async () => {
    for (const x of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/__gate', '', '/a\nb'])
      expect(safeNext(x)).toBe('/');
    expect(safeNext('/brand/jinlong?x=1#y')).toBe('/brand/jinlong?x=1#y');
    const { submit } = setup();
    expect((await submit(CFG.password, 'https://evil.example')).headers.get('location')).toBe('/');
  });

  it('每 IP 每分钟 ≤ 10 次提交：第 11 次 429（即使口令正确）；其他 IP 不受影响；计数器故障 → 拒绝', async () => {
    const { submit } = setup();
    for (let i = 0; i < 10; i++) expect((await submit('wrong')).status).toBe(401);
    const locked = await submit(CFG.password);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('set-cookie')).toBeNull();
    expect((await submit(CFG.password, '/', '198.51.100.9')).status).toBe(303);
    const broken: RateCounter = { hit: () => Promise.reject(new Error('redis down')), add: () => Promise.reject(new Error('x')), peek: () => Promise.reject(new Error('x')) };
    expect((await setup(broken).submit(CFG.password)).status).toBe(429);
  });

  it('配置：正式环境 / 缺值不注册；Cookie 值须为十六进制（Caddy 正则匹配）', async () => {
    expect(gateConfigFromEnv({ BYDP_ENV: 'production', STAGING_GATE_PASSWORD: 'p', STAGING_GATE_TOKEN: CFG.token })).toBeNull();
    expect(gateConfigFromEnv({ BYDP_ENV: 'staging', STAGING_GATE_PASSWORD: 'p' })).toBeNull();
    expect(gateConfigFromEnv({ BYDP_ENV: 'staging', STAGING_GATE_PASSWORD: 'p', STAGING_GATE_TOKEN: CFG.token })).toEqual({ password: 'p', token: CFG.token });
    expect(() => gateConfigFromEnv({ BYDP_ENV: 'staging', STAGING_GATE_PASSWORD: 'p', STAGING_GATE_TOKEN: 'a.*'.repeat(12) })).toThrow();
    const app = new Hono();
    registerStagingGate(app as never, null, new MemoryRateCounter());
    expect((await app.request('/internal/gate')).status).toBe(404);
  });
});
