/**
 * D-022 登录类旅程的辅助：
 * - 测试账号 = PO #26 专用 Gmail 的「+uat<run><端><角色>」别名，每次运行全新（自我排除不可撤销，不能复用）；
 * - emailLogin：走真实邮箱登录（Resend 投递 → IMAP 取信，mail_link.py 只把链接交回本进程，不打印）——W2#012 起每轮只用 1 次（桌面旅程 3，证明收信链路）；
 * - sessionLogin / loginAs：测试站专用 CLI（api uat-session.ts）为 +uat 账号直接签发会话，令牌只放进浏览器 Cookie，不打印（Resend 免费档每日 100 封）；
 * - server：经 SSH 在测试站容器内执行固定的几类命令（查 userId / 授收角色 / 建 UAT 品牌 / 只读 SQL），参数先过白名单正则。
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { devices, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { gateStorageState } from './gate';

const run = promisify(execFile);
export const RUN = (process.env.UAT_RUN ?? '').toLowerCase();
if (RUN && !/^[a-z0-9]{4,12}$/.test(RUN)) throw new Error('UAT_RUN 格式不对');

/** 测试邮箱别名：角色字母 a=普通用户 b=第二用户 / 仲裁员 x=自我排除 m=管理员 */
export function uatEmail(project: string, role: 'a' | 'b' | 'x' | 'm') {
  const user = process.env.UAT_IMAP_USER ?? '';
  const [local, domain] = user.split('@');
  if (!local || domain !== 'gmail.com' || !RUN) throw new Error('缺 UAT_IMAP_USER（gmail）或 UAT_RUN：请用 scripts/uat.sh 运行');
  return `${local}+uat${RUN}${project === '手机' ? 'p' : 'd'}${role}@gmail.com`;
}

/** 与 playwright.config 一致的上下文参数（新开账号上下文时用） */
export function contextOptions(project: string) {
  const base = project === '手机' ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } : { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };
  const baseURL = process.env.UAT_BASE ?? 'https://staging.northx.vip';
  const gate = gateStorageState(baseURL);
  return {
    ...base,
    baseURL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Singapore',
    ...(gate ? { storageState: gate } : {}),
  };
}

/** 页面控制台 error / 未捕获异常收集（旅程 13） */
export function watchConsole(page: Page, sink: string[]) {
  page.on('console', (m) => {
    if (m.type() === 'error') sink.push(`${m.text().slice(0, 160)} @ ${page.url()}`);
  });
  page.on('pageerror', (e) => sink.push(`未捕获异常 ${e.message.slice(0, 160)} @ ${page.url()}`));
}

/** 在当前页（登录页或会跳到登录页的入口）完成邮箱登录，返回后停在回跳页 */
export async function emailLogin(page: Page, email: string) {
  await expect(page).toHaveURL(/\/login/);
  await page.locator('#login-email').fill(email);
  const since = Math.floor(Date.now() / 1000);
  await page.getByRole('button', { name: '发送登录链接' }).click();
  await expect(page.getByText('请查收邮件')).toBeVisible();
  // 「网络：」前缀 = 纯网络原因（W2#006 口径：该轮作废重跑，报告单列，不算功能失败）
  const { stdout } = await run('python3', ['-I', 'e2e/uat/mail_link.py', email, String(since)], { timeout: 210_000, env: process.env }).catch(() => {
    throw new Error('网络：取信超时，180 秒内未收到登录信');
  });
  if (!/^https:\/\/\S+$/.test(stdout)) throw new Error('未取到登录链接');
  await page.goto(stdout);
  await expect(page).not.toHaveURL(/\/login/);
}

/** 不收信登录：测试站签发该测试账号的会话，放进本上下文的会话 Cookie（与真实登录同名同属性） */
export async function sessionLogin(ctx: BrowserContext, email: string) {
  const { token } = await server.session(email);
  const { hostname } = new URL(process.env.UAT_BASE ?? 'https://staging.northx.vip');
  await ctx.addCookies([{ name: '__Secure-authjs.session-token', value: token, domain: hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
}

/** 新开一个上下文并以该测试账号登录（落在 startPath）；W2#012 起不收信 */
export async function loginAs(browser: Browser, info: TestInfo, email: string, startPath = '/me', sink?: string[]): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(contextOptions(info.project.name));
  await sessionLogin(ctx, email);
  const page = await ctx.newPage();
  if (sink) watchConsole(page, sink);
  await page.goto(startPath);
  await expect(page).not.toHaveURL(/\/login/);
  return { ctx, page };
}

// D-030：测试站地址与 SSH 密钥路径由 scripts/uat.sh 从 .env.local 传入，不写死
const HOST = `ubuntu@${process.env.UAT_SSH_HOST ?? ''}`;
const DC = 'cd ~/bydp/deploy && sudo docker compose -f compose.prod.yml --env-file .env.prod';
async function ssh(remote: string, input?: string): Promise<string> {
  // SSH 连接被断（经 VPN / sshd 并发限流，退出码 255）时重试至多 2 次；这里的远程命令均为幂等或只读（W3#090 第 15 轮）
  for (let attempt = 0; ; attempt++) {
    const p = run('ssh', ['-p', '2222', '-i', process.env.UAT_SSH_KEY ?? '', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, remote], { timeout: 180_000 });
    if (input !== undefined) p.child.stdin?.end(input);
    try {
      return (await p).stdout.trim();
    } catch (e) {
      if ((e as { code?: number }).code !== 255 || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

export const server = {
  /** 测试站签发会话（api 容器 uat-session.ts）；令牌只返回给调用方，不打印 */
  async session(email: string): Promise<{ userId: string; token: string }> {
    if (!/^[a-z0-9.]+\+uat[a-z0-9]+@gmail\.com$/.test(email)) throw new Error('非测试邮箱');
    const out = (await ssh(`${DC} exec -T api ./node_modules/.bin/tsx src/cli/uat-session.ts ${email}`)).split('\n').pop() ?? '';
    const r = JSON.parse(out) as { userId?: string; token?: string };
    if (!r.userId || !/^u_[A-Za-z0-9_]+$/.test(r.userId) || !r.token) throw new Error('未取到测试会话');
    return { userId: r.userId, token: r.token };
  },
  async userId(email: string) {
    if (!/^[a-z0-9.]+\+uat[a-z0-9]+@gmail\.com$/.test(email)) throw new Error('非测试邮箱');
    const id = (await ssh(`${DC} exec -T worker ./node_modules/.bin/tsx src/cli/uat-user.ts ${email}`)).split('\n').pop() ?? '';
    if (!/^u_[A-Za-z0-9_]+$/.test(id)) throw new Error('未取到 userId');
    return id;
  },
  /** 授予后台角色；记录到 e2e/.out/granted.txt，scripts/uat.sh 结束时统一收回 */
  async grant(userId: string, role: 'admin' | 'arbitrator') {
    if (!/^u_[A-Za-z0-9_]+$/.test(userId)) throw new Error('userId 格式不对');
    mkdirSync('e2e/.out', { recursive: true });
    appendFileSync('e2e/.out/granted.txt', `${userId} ${role}\n`);
    await ssh(`${DC} run --rm --no-deps migrate ./node_modules/.bin/tsx scripts/grant-role.ts ${userId} ${role}`);
  },
  async uatBrand() {
    return ssh(`${DC} run --rm --no-deps migrate ./node_modules/.bin/tsx scripts/uat-brand.ts ${RUN}`).then((o) => o.split('\n').pop() ?? '');
  },
  /** 只读查询（psql -At，经标准输入传 SQL；调用方只拼接已校验的 id） */
  async sql(query: string) {
    if (!/^\s*select\b/i.test(query)) throw new Error('只允许 select');
    return ssh(`${DC} exec -T postgres psql -U bydp_owner -d bydp -At -v ON_ERROR_STOP=1`, query);
  },
};
