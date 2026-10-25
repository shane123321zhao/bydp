/** safe-fetch：SSRF 防护（审核 A-017 条件 1）。本机测试服务器监听 127.0.0.1，测试注入解析 / 端口 / 地址判定以便连到它；生产一律用默认值 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress, SAFE_FETCH_LIMITS, safeFetch, SafeFetchError, safeFetchWithTestHooks, type SafeFetchOptions, type SafeFetchTestHooks } from '../src/safe-fetch';

describe('isBlockedAddress：私网 / 回环 / 链路本地 / 组播 / 保留（v4 + v6，含内嵌 v4）', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:0:7f00:1', '64:ff9b:1::a9fe:a9fe', '64:ff9b:1:abcd::1', '5f00::1', '3fff::1', '168.63.129.16', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::127.0.0.1',
    'not-an-ip', '',
  ])('拒绝 %s', (a) => expect(isBlockedAddress(a)).toBe(true));
  it.each(['93.184.216.34', '1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:93.184.216.34'])(
    '放行公网 %s',
    (a) => expect(isBlockedAddress(a)).toBe(false),
  );
});

describe('safeFetch：URL / 端口 / 解析 / 重定向 / 大小 / 超时', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') return res.end('hello');
      if (req.url === '/to-meta') return res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
      if (req.url === '/to-internal-host') return res.writeHead(301, { Location: 'http://internal.test/admin' }).end();
      if (req.url === '/bad-location') return res.writeHead(302, { Location: 'http://[::1' }).end();
      if (req.url === '/to-ftp') return res.writeHead(302, { Location: 'ftp://public.test/x' }).end();
      if (req.url?.startsWith('/loop')) return res.writeHead(302, { Location: `/loop${(req.url.length % 7) + 1}` }).end();
      if (req.url === '/hop') return res.writeHead(301, { Location: `http://public.test:${port}/ok` }).end();
      if (req.url === '/big') {
        res.writeHead(200);
        const chunk = Buffer.alloc(256 * 1024, 97);
        for (let i = 0; i < 12; i++) res.write(chunk);
        return res.end();
      }
      if (req.url === '/slow') return setTimeout(() => res.end('late'), 2_000);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // 测试环境：public.test → 127.0.0.1（视为公网，仅本测试）；internal.test → 10.0.0.5；meta.test → 169.254.169.254；mixed.test 含一个私网结果
  const resolve = async (h: string) =>
    ({ 'public.test': ['127.0.0.1'], 'internal.test': ['10.0.0.5'], 'meta.test': ['169.254.169.254'], 'mixed.test': ['93.184.216.34', '192.168.0.10'] })[h] ??
    Promise.reject(new Error('NXDOMAIN'));
  const hooks = (): SafeFetchTestHooks => ({ resolve, allowedPorts: [80, 443, port], isBlocked: (a: string) => (a === '127.0.0.1' ? false : isBlockedAddress(a)) });
  const viaHooks = (u: string, o: SafeFetchOptions = {}, h: SafeFetchTestHooks = hooks()) => safeFetchWithTestHooks(u, o, h);
  const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof SafeFetchError ? e.reason : `other:${(e as Error).message}`));

  it('默认策略：localhost / 127.0.0.1 / 169.254.169.254 / 10.x / [::1] / 十进制 IP 一律拒绝（不注入任何放行）', async () => {
    expect(await reason(safeFetch('http://127.0.0.1/'))).toBe('blocked_address');
    expect(await reason(safeFetch('http://169.254.169.254/latest/meta-data/'))).toBe('blocked_address');
    expect(await reason(safeFetch('http://10.0.0.1/'))).toBe('blocked_address');
    expect(await reason(safeFetch('http://[::1]/'))).toBe('blocked_address');
    expect(await reason(safeFetch('http://2130706433/'))).toBe('blocked_address'); // 127.0.0.1 的十进制写法（URL 规范化为 127.0.0.1）
    expect(await reason(safeFetch('http://0x7f.1/'))).toBe('blocked_address');
    expect(await reason(safeFetch('http://localhost/'))).toBe('blocked_address'); // 系统解析到回环
  });
  it('只允许 http / https、80 / 443，拒绝 URL 中的用户名密码', async () => {
    expect(await reason(safeFetch('ftp://example.com/'))).toBe('protocol');
    expect(await reason(safeFetch('file:///etc/passwd'))).toBe('protocol');
    expect(await reason(safeFetch('http://example.com:8080/'))).toBe('port');
    expect(await reason(safeFetch('http://example.com:6379/'))).toBe('port');
    expect(await reason(safeFetch('http://user:pass@example.com/'))).toBe('credentials');
  });
  it('解析结果中只要有一个非公网地址即拒绝；解析失败拒绝', async () => {
    expect(await reason(viaHooks('http://mixed.test/', {}, { resolve }))).toBe('blocked_address');
    expect(await reason(viaHooks('http://meta.test/', {}, { resolve }))).toBe('blocked_address');
    expect(await reason(viaHooks('http://nx.test/', {}, { resolve }))).toBe('dns');
  });
  it('正常抓取：返回状态、正文哈希、跳转链', async () => {
    const r = await viaHooks(`http://public.test:${port}/hop`);
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('hello');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.hops.map((h) => h.status)).toEqual([301, 200]);
  });
  it('重定向每跳重校验：到 169.254.169.254 / 到解析为内网的主机 / 到非 http 协议 → 拒绝；超过 3 跳 → 拒绝', async () => {
    expect(await reason(viaHooks(`http://public.test:${port}/to-meta`))).toBe('blocked_address');
    expect(await reason(viaHooks(`http://public.test:${port}/to-internal-host`))).toBe('blocked_address');
    expect(await reason(viaHooks(`http://public.test:${port}/to-ftp`))).toBe('protocol');
    expect(await reason(viaHooks(`http://public.test:${port}/bad-location`))).toBe('protocol');
    expect(await reason(viaHooks(`http://public.test:${port}/loop`))).toBe('too_many_redirects');
    expect(SAFE_FETCH_LIMITS.maxRedirects).toBe(3);
  });
  it('DNS 解析也受总时限约束', async () => {
    const slowDns = () => new Promise<string[]>(() => {});
    expect(await reason(viaHooks('http://slow.test/', { timeoutMs: 200 }, { resolve: slowDns }))).toBe('timeout');
  });
  it('响应超过 2MB 中止；超时中止；上限不可被调大', async () => {
    expect(await reason(viaHooks(`http://public.test:${port}/big`))).toBe('too_large');
    expect(await reason(viaHooks(`http://public.test:${port}/slow`, { timeoutMs: 300 }))).toBe('timeout');
    expect(await reason(viaHooks(`http://public.test:${port}/big`, { maxBytes: 50 * 1024 * 1024 }))).toBe('too_large');
  });
});

describe('测试注入不能在生产生效（审核 D-016 第 1 轮 ②）', () => {
  it('公开 safeFetch 忽略多传的 resolve / isBlocked / allowedPorts；非 test 环境调用测试入口抛错', async () => {
    const sneaky = { resolve: async () => ['93.184.216.34'], isBlocked: () => false, allowedPorts: [6379] } as never;
    const r = await safeFetch('http://169.254.169.254/latest/meta-data/', sneaky).then(() => 'fetched', (e: unknown) => (e as SafeFetchError).reason);
    expect(r).toBe('blocked_address');
    const env = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      expect(() => safeFetchWithTestHooks('http://x/', {}, { isBlocked: () => false })).toThrow(/只能在测试中使用/);
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.VITEST !== undefined) process.env.VITEST = env.VITEST;
    }
  });
});
