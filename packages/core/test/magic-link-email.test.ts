/** magic link 登录信：注入发送函数，不发真实邮件 */
import { describe, expect, it } from 'vitest';
import { magicLinkEmail, resendSender, sendMagicLink } from '../src/identity/magic-link-email';

const URL_OK = 'https://northx.vip/api/auth/callback/resend?token=abc&email=x';

describe('magic link 登录信（A-009）', () => {
  it('文案：含链接、15 分钟 / 一次性提示、大陆排除声明；不含禁用词', () => {
    const m = magicLinkEmail(URL_OK);
    for (const s of [m.text, m.html]) {
      expect(s).toContain('15 分钟');
      expect(s).toContain('不向中国大陆居民提供服务');
      expect(s).not.toMatch(/保险|留存率/);
    }
    expect(m.text).toContain(URL_OK);
    expect(m.html).toContain('token=abc&amp;email=x');
  });

  it('非 https 链接拒绝（localhost 开发除外）；链接里的引号不破坏 HTML', () => {
    expect(() => magicLinkEmail('http://northx.vip/x')).toThrow(/https/);
    expect(() => magicLinkEmail('javascript:alert(1)')).toThrow();
    expect(magicLinkEmail('http://localhost:3000/cb').text).toContain('localhost');
    expect(magicLinkEmail('https://northx.vip/cb?a="><script>').html).not.toContain('"><script>');
  });

  it('经 Resend API 发送：POST /emails、Bearer key、from = EMAIL_FROM；非 2xx 抛错且不回显收件人', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await sendMagicLink({ to: 'ke.li@gmail.com', url: URL_OK, from: 'BYDP <no-reply@mail.northx.vip>', send: resendSender('re_test_key', fake) });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ from: 'BYDP <no-reply@mail.northx.vip>', to: 'ke.li@gmail.com' });

    const failing = (async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    const err = await sendMagicLink({ to: 'ke.li@gmail.com', url: URL_OK, from: 'x@y.z', send: resendSender('re_test_key', failing) }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 422/);
    expect(String(err)).not.toContain('ke.li');
    expect(() => resendSender('')).toThrow(/RESEND_API_KEY/);
  });

  it('429（每秒上限）按 Retry-After 重试至多 2 次后成功；连续 429 第 3 次抛错；422 不重试', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const seq = (codes: number[], headers: Record<string, string> = {}) => {
      let i = 0;
      return { fetch: (async () => new Response('{}', { status: codes[i++] ?? 200, headers })) as unknown as typeof fetch, calls: () => i };
    };
    const ok = seq([429, 429, 200], { 'retry-after': '1' });
    await resendSender('re_test_key', ok.fetch, sleep)({ from: 'x@y.z', to: 'a@b.c', subject: 's', text: 't', html: 'h' });
    expect(ok.calls()).toBe(3);
    expect(waits).toEqual([1000, 1000]);

    waits.length = 0;
    const no = seq([429, 429, 429, 200]);
    const err = await resendSender('re_test_key', no.fetch, sleep)({ from: 'x@y.z', to: 'a@b.c', subject: 's', text: 't', html: 'h' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 429/);
    expect(no.calls()).toBe(3);
    expect(waits).toEqual([600, 1200]);

    const bad = seq([422, 200]);
    await resendSender('re_test_key', bad.fetch, sleep)({ from: 'x@y.z', to: 'a@b.c', subject: 's', text: 't', html: 'h' }).catch(() => {});
    expect(bad.calls()).toBe(1);
  });
});
