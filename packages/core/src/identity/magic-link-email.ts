/**
 * 邮箱 magic link 登录信（A-009 §1）：经 Resend HTTP API 发送。
 * 文案口径：大陆排除声明常驻（CLAUDE.md 对外文案）；不写收件邮箱明文到日志；链接 15 分钟有效、一次性。
 * send 可注入（测试不发真实邮件）。
 */
export const MAGIC_LINK_MAX_AGE_SEC = 15 * 60;
const EXCLUSION = '不向中国大陆居民提供服务。';

export function magicLinkEmail(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('magic link 须为 https');
  const subject = 'BYDP 博弈点评 · 登录链接（15 分钟内有效）';
  const text = [
    '点击下面的链接登录 BYDP 博弈点评：',
    u.href,
    '',
    '链接 15 分钟内有效，只能使用一次。如果不是你本人操作，忽略这封邮件即可，你的账号不会有任何变化。',
    '',
    EXCLUSION,
  ].join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html lang="zh-Hans"><body style="font-family:system-ui,sans-serif;line-height:1.6">
<p>点击下面的按钮登录 BYDP 博弈点评：</p>
<p><a href="${esc(u.href)}" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none">登录</a></p>
<p style="font-size:13px">链接 15 分钟内有效，只能使用一次。如果不是你本人操作，忽略这封邮件即可，你的账号不会有任何变化。</p>
<p style="font-size:12px;color:#666">${EXCLUSION}</p>
</body></html>`;
  return { subject, text, html };
}

export type SendEmail = (msg: { from: string; to: string; subject: string; text: string; html: string }) => Promise<void>;

const RETRIES_ON_429 = 2;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resend HTTP API（仅发送权限的 key 即可）。失败抛错，不回显收件人。
 * 429（Resend 每秒请求上限；两人同一秒申请登录即可触发，W3#088 UAT 实测）：按 Retry-After（≤ 3 秒）或递增退避重试至多 2 次；其他错误不重试。
 */
export function resendSender(apiKey = process.env.RESEND_API_KEY, fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = sleepMs): SendEmail {
  if (!apiKey) throw new Error('RESEND_API_KEY 未设置');
  return async (msg) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (res.ok) return;
      if (res.status !== 429 || attempt >= RETRIES_ON_429) throw new Error(`Resend 发送失败：HTTP ${res.status}`);
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 3) * 1000 : 600 * (attempt + 1));
    }
  };
}

export async function sendMagicLink(p: { to: string; url: string; from?: string; send: SendEmail }) {
  const from = p.from ?? process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM 未设置');
  await p.send({ from, to: p.to, ...magicLinkEmail(p.url) });
}
