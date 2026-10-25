/** 礼貌抓取：robots 解析与匹配、robots 不可得时的保守口径、同主机 ≥ 10 秒间隔（假时钟，不真等待） */
import { describe, expect, it } from 'vitest';
import { createPoliteFetcher, parseRobots, POLITE, RobotsDisallowedError, robotsAllows, RobotsUnavailableError } from '../src/polite';
import { SafeFetchError } from '../src/safe-fetch';
import type { SafeResponse } from '../src/safe-fetch';

const resp = (status: number, body = ''): SafeResponse => ({ status, url: 'x', hops: [], headers: {}, body: Buffer.from(body), sha256: '' });

describe('robots.txt', () => {
  const txt = `# comment
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Disallow:

User-agent: bydp-agent
Disallow: /no-bydp
`;
  it('专属组优先于 *；最长匹配；等长 Allow 优先；* 与 $ 通配', () => {
    const mine = parseRobots(txt);
    expect(robotsAllows(mine, '/no-bydp/x')).toBe(false);
    expect(robotsAllows(mine, '/private')).toBe(true); // 专属组不含 /private 规则
    const star = parseRobots(txt, 'other-bot');
    expect(robotsAllows(star, '/private/x')).toBe(false);
    expect(robotsAllows(star, '/private/public/x')).toBe(true);
    expect(robotsAllows(star, '/doc/a.pdf')).toBe(false);
    expect(robotsAllows(star, '/doc/a.pdf?x=1')).toBe(true);
    expect(robotsAllows(star, '/')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nAllow: /a\nDisallow: /a'), '/a')).toBe(true);
  });
  it('User-agent 按产品 token 完整匹配：空值忽略，子串（bydp / agent）不算本组', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n\nUser-agent:\nDisallow: /tmp'), '/')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: agent\nAllow: /'), '/x')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: BYDP-Agent\nAllow: /'), '/x')).toBe(true);
  });
  it('路径百分号解码后比较（UTF-8 规则拦得住编码后的请求）', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /条款'), '/%E6%9D%A1%E6%AC%BE')).toBe(false);
  });
});

describe('createPoliteFetcher', () => {
  const make = (robots: SafeResponse | Error) => {
    let t = 0;
    const calls: { url: string; at: number }[] = [];
    const slept: number[] = [];
    const fetcher = async (url: string) => {
      calls.push({ url, at: t });
      if (url.endsWith('/robots.txt')) {
        if (robots instanceof Error) throw robots;
        return robots;
      }
      return resp(200, 'ok');
    };
    const politeFetch = createPoliteFetcher({ fetcher, now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) });
    return { politeFetch, calls, slept, tick: (ms: number) => (t += ms) };
  };

  it('robots 允许则抓取；禁止路径抛 RobotsDisallowedError；同主机两次请求间隔 ≥ 10 秒；robots 只取一次', async () => {
    const m = make(resp(200, 'User-agent: *\nDisallow: /admin'));
    await m.politeFetch('https://a.test/');
    await m.politeFetch('https://a.test/terms');
    await expect(m.politeFetch('https://a.test/admin/x')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(m.calls.map((c) => c.url)).toEqual(['https://a.test/robots.txt', 'https://a.test/', 'https://a.test/terms']);
    const gaps = m.calls.slice(1).map((c, i) => c.at - m.calls[i]!.at);
    expect(gaps.every((g) => g >= POLITE.minHostIntervalMs)).toBe(true);
  });
  it('不同主机互不等待', async () => {
    const m = make(resp(404));
    await m.politeFetch('https://a.test/');
    await m.politeFetch('https://b.test/');
    expect(m.calls.find((c) => c.url === 'https://b.test/robots.txt')!.at).toBe(m.calls.find((c) => c.url === 'https://a.test/')!.at);
  });
  it('robots.txt 4xx → 无限制；429 / 5xx → RobotsUnavailableError；网络失败 → 原样抛出（站点不可达，不当作 robots 禁止）', async () => {
    await expect(make(resp(404)).politeFetch('https://a.test/x')).resolves.toMatchObject({ status: 200 });
    await expect(make(resp(503)).politeFetch('https://a.test/x')).rejects.toBeInstanceOf(RobotsUnavailableError);
    await expect(make(resp(429)).politeFetch('https://a.test/x')).rejects.toBeInstanceOf(RobotsUnavailableError);
    await expect(make(new SafeFetchError('dns', 'nx')).politeFetch('https://a.test/x')).rejects.toMatchObject({ name: 'SafeFetchError', reason: 'dns' });
  });
  it('重定向逐跳：跳到另一主机时先查该主机的 robots 并遵守间隔；被禁止的落地路径不抓', async () => {
    let t = 0;
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url === 'https://a.test/robots.txt') return resp(404);
      if (url === 'https://pay.test/robots.txt') return resp(200, 'User-agent: *\nDisallow: /secret');
      if (url === 'https://a.test/deposit') return { ...resp(302), headers: { location: 'https://pay.test/secret/x' } };
      if (url === 'https://a.test/ok') return { ...resp(301), headers: { location: 'https://pay.test/public' } };
      return resp(200, 'ok');
    };
    const politeFetch = createPoliteFetcher({ fetcher, now: () => t, sleep: async (ms) => void (t += ms) });
    await expect(politeFetch('https://a.test/deposit')).rejects.toBeInstanceOf(RobotsDisallowedError);
    const r = await politeFetch('https://a.test/ok');
    expect(r.hops.map((h) => h.status)).toEqual([301, 200]);
    expect(calls).toEqual(['https://a.test/robots.txt', 'https://a.test/deposit', 'https://pay.test/robots.txt', 'https://a.test/ok', 'https://pay.test/public']);
  });
});
