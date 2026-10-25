/**
 * D-022 登录类旅程 3–10（串行，每端一套全新测试账号；后台操作只在桌面端做）。
 * 账号：A 普通用户 · B 第二用户（桌面端兼仲裁员）· X 自我排除 · M 管理员（桌面端）。
 * 高风险后台操作须 10 分钟内登录过：M 在后台段开始时才登录，后台段集中执行。
 */
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { checkConsole, noHorizontalScroll } from './fixtures';
import { emailLogin, loginAs, RUN, server, sessionLogin, uatEmail, watchConsole } from './session';

test.describe.configure({ mode: 'serial', timeout: 360_000 });

const errors: string[] = [];
let A: { ctx: BrowserContext; page: Page };
let A2: BrowserContext; // A 的第二个设备（验证「退出所有设备」）
let userA = '';
let boundAt = 0; // 旅程 5 绑定时刻（旅程 7 申请提款时间须晚于绑定）
let caseNotice = ''; // 走「两次通知」的案件
let caseExpose = ''; // 走「直接曝光 + 公开」的案件（黑名单品牌）
let caseOpen = ''; // 始终不结案（旅程 9：有未结案投诉时注销被拒）
let exportReq = false;
const tag = () => `${RUN}${test.info().project.name === '手机' ? 'p' : 'd'}`;
/** 纯字母标记（公开接口会把含数字的长串当账号脱敏，标记须不含数字） */
const mark = () => tag().replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!).toUpperCase();
const desktop = () => test.info().project.name === '桌面';
const PNG = readFileSync('e2e/uat/assets/evidence.png');

test.afterEach(async () => {
  await checkConsole(errors.splice(0));
});
test.afterAll(async () => {
  await A?.ctx.close();
  await A2?.close();
});

async function go(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  expect(res?.status(), `${path} 状态码`).toBeLessThan(400);
  await noHorizontalScroll(page);
}

test('旅程 3+4 · 未登录领码 → 邮箱登录 → 回到优惠页领码，Click 入库', async ({ browser }) => {
  const ctx = await browser.newContext((await import('./session')).contextOptions(test.info().project.name));
  const page = await ctx.newPage();
  watchConsole(page, errors);
  await go(page, '/offers');
  await page.getByRole('link', { name: /登录领码/ }).first().click();
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Foffers/);
  // W2#012：每轮只保留 1 条真实邮箱登录（桌面，证明 Resend 投递 → 收信 → 回跳）；手机端改为测试站签发会话后按回跳地址返回
  if (test.info().project.name === '桌面') await emailLogin(page, uatEmail('桌面', 'a'));
  else {
    await sessionLogin(ctx, uatEmail(test.info().project.name, 'a'));
    await page.goto(decodeURIComponent(new URL(page.url()).searchParams.get('callbackUrl') ?? '/'));
  }
  await expect(page).toHaveURL(/\/offers$/);
  A = { ctx, page };
  userA = await server.userId(uatEmail(test.info().project.name, 'a'));
  const before = Number(await server.sql(`select count(*) from "click" where "userId" = '${userA}'`));
  // 认证品牌金龙的优惠：显示专属码；「前往官网」若有则必须是 https 跟踪链接，没有则显示「官网链接待核验」（与 TG Bot 口径一致）
  const card = page.locator('article', { hasText: '金龙娱乐城' }).first();
  await card.getByRole('button', { name: '领码' }).click();
  await expect(card.getByTestId('claimed-code')).toBeVisible();
  const go2 = card.getByRole('link', { name: /前往官网/ });
  if (await go2.count()) await expect(go2).toHaveAttribute('href', /^https:\/\//);
  else await expect(card.getByText('官网链接待核验')).toBeVisible();
  await noHorizontalScroll(page);
  expect(Number(await server.sql(`select count(*) from "click" where "userId" = '${userA}'`)), 'Click 入库').toBe(before + 1);
});

test('旅程 4 · 「我的」显示邮箱登录身份', async () => {
  await go(A.page, '/me');
  await expect(A.page.getByText(/邮箱 登录|Email 登录|邮箱登录/).first()).toBeVisible();
  await expect(A.page.getByText('领过的码')).toBeVisible();
  // 第二个设备：复制当前会话，稍后验证「退出所有设备」使其失效
  A2 = await browser().newContext({ ...(await import('./session')).contextOptions(test.info().project.name), storageState: await A.ctx.storageState() });
  const p2 = await A2.newPage();
  await p2.goto('/me', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(p2).toHaveURL(/\/me$/);
});

test('旅程 5 · 绑定：认证品牌 → 自报级；同一账号第二个用户被拒', async ({ browser }) => {
  const account = `UAT${tag().toUpperCase()}01`;
  await go(A.page, '/me/bind');
  await A.page.getByRole('radio', { name: /金龙娱乐城/ }).click();
  await A.page.locator('#bind-account').fill(account);
  await A.page.getByRole('button', { name: '已有账号手动绑定' }).click();
  await A.page.getByRole('button', { name: '提交绑定' }).click();
  await expect(A.page.getByText('已提交 · 自报级')).toBeVisible();
  boundAt = Date.now();
  const B = await loginAs(browser, test.info(), uatEmail(test.info().project.name, 'b'), '/me/bind', errors);
  await B.page.getByRole('radio', { name: /金龙娱乐城/ }).click();
  await B.page.locator('#bind-account').fill(account);
  await B.page.getByRole('button', { name: '已有账号手动绑定' }).click();
  await B.page.getByRole('button', { name: '提交绑定' }).click();
  await expect(B.page.getByText('该运营商账号已被绑定（同一账号只能被一个 BYDP 用户绑定）')).toBeVisible();
  await expect(B.page.locator('#bind-account'), '报错后保留已填账号（D-025 F5）').toHaveValue(account);
  if (desktop()) await server.grant(await server.userId(uatEmail('桌面', 'b')), 'arbitrator'); // 旅程 10：B 兼仲裁员
  await B.ctx.close();
});

async function fileComplaint(page: Page, slug: string, desc: string) {
  await go(page, `/complaint?b=${slug}`);
  await page.getByRole('radiogroup', { name: '投诉类型' }).getByRole('radio', { name: '提款延迟' }).click();
  await page.locator('#cp-amount').fill('100');
  await page.locator('#cp-date').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#cp-desc').fill(desc);
  await page.getByRole('radiogroup', { name: '证据类型' }).getByRole('radio', { name: '截图' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /选择文件/ }).click();
  await (await chooser).setFiles({ name: 'uat-evidence.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: '下一步 · 确认' }).click();
  await expect(page.getByText('确认提交')).toBeVisible();
  await page.getByRole('button', { name: '提交投诉 · 进入初筛' }).click();
  await page.waitForURL(/\/me\/complaints\/cp_[A-Za-z0-9]+$/);
  await expect(page.getByText('待初筛').first()).toBeVisible();
  await noHorizontalScroll(page);
  return page.url().split('/').pop()!;
}

test('旅程 6 · 投诉提交（含证据上传）三件', async () => {
  caseNotice = await fileComplaint(A.page, 'caishen-poker', `UAT ${tag()} 两次通知与答辩案件，仅用于测试站验收`);
  caseExpose = await fileComplaint(A.page, 'caishen-poker', `UAT ${tag()} 私密经过 SECRET${mark()}，不应公开`);
  caseOpen = await fileComplaint(A.page, 'jinlong', `UAT ${tag()} 保持未结案，仅用于测试站验收`);
  expect(Number(await server.sql(`select count(*) from "evidence" where "complaintId" in ('${caseNotice}','${caseExpose}','${caseOpen}')`)), '证据入库').toBe(3);
});

test('旅程 9 · 申请导出与注销（10 分钟内登录）', async () => {
  await go(A.page, '/me/privacy');
  await A.page.getByRole('button', { name: /导出我的数据/ }).click();
  await A.page.getByRole('button', { name: '确认提交' }).click();
  await expect(A.page.getByText(/已提交「导出我的数据」/)).toBeVisible();
  await A.page.reload();
  await A.page.getByRole('button', { name: '申请注销' }).click();
  await A.page.getByRole('button', { name: '确认申请注销' }).click();
  await expect(A.page.getByText(/已提交「注销账号/)).toBeVisible();
  exportReq = true;
});

/** 新加坡本地时间（上下文 timezoneId = Asia/Singapore）的 datetime-local 字符串 */
const sgNow = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);
async function submitWithdrawal(page: Page, amount: string) {
  await go(page, '/me/withdrawal-report?b=jinlong');
  await page.getByRole('radiogroup', { name: '选择平台' }).getByRole('radio', { name: /金龙娱乐城/ }).click();
  await page.locator('#wr-amount').fill(amount);
  await page.locator('#wr-requested').fill(sgNow());
  await page.getByRole('radiogroup', { name: '出款结果' }).getByRole('radio', { name: '已到账' }).click();
  await page.locator('#wr-received').fill(sgNow());
  await page.locator('input[type="file"][name="file"]').setInputFiles({ name: 'uat-payout.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: /提交出款凭证/ }).click();
}

test('旅程 7 · 出款凭证（含截图）与评价提交 → 待审；同绑定第 4 份被拒；未绑定用户须先绑定', async () => {
  // 申请提款时间须晚于绑定（库触发器 binding_after_request）；datetime-local 精度到分钟，等过绑定那一分钟
  const wait = boundAt + 61_000 - Date.now();
  if (wait > 0) await A.page.waitForTimeout(wait);
  await submitWithdrawal(A.page, '200');
  await expect(A.page.getByText('已提交 · 待审核')).toBeVisible();
  expect(await server.sql(`select status || '/' || (select count(*) from "submission_evidence" se where se."withdrawalReportId" = w."id") from "withdrawal_report" w where w."userId" = '${userA}' order by w."createdAt" desc limit 1`)).toBe('pending/1');
  if (desktop()) {
    // 写入端限额（A-005 口径）：同一绑定前后 30 天内第 4 份被拒，提示中文原因
    await submitWithdrawal(A.page, '201');
    await expect(A.page.getByText('已提交 · 待审核')).toBeVisible();
    await submitWithdrawal(A.page, '202');
    await expect(A.page.getByText('已提交 · 待审核')).toBeVisible();
    await submitWithdrawal(A.page, '203');
    await expect(A.page.getByText('同一绑定账号 30 天内最多提交 3 份出款凭证')).toBeVisible();
  }
  await go(A.page, '/me/review?b=jinlong');
  await A.page.getByRole('radiogroup', { name: '评分' }).getByRole('radio', { name: '4 星' }).click();
  await A.page.locator('#rv-text').fill(`UAT ${tag()} 出款稳定，评价文字不公开`);
  await A.page.getByRole('button', { name: '提交评价' }).click();
  await expect(A.page.getByText('已提交 · 待审核')).toBeVisible();
  expect(await server.sql(`select status || '/' || "trustWeight" from "review" where "userId" = '${userA}' and "brandId" = 'br_jinlong'`)).toBe('pending/0.20');
  // 同品牌第二条被拒
  await go(A.page, '/me/review?b=jinlong');
  await A.page.getByRole('radiogroup', { name: '评分' }).getByRole('radio', { name: '5 星' }).click();
  await A.page.getByRole('button', { name: '提交评价' }).click();
  await expect(A.page.getByText('你已评价过该平台')).toBeVisible();
  // 品牌页入口：行动区「提交出款凭证」·「玩家评价」行「写评价」· 出款子页「提交凭证」
  await go(A.page, '/brand/jinlong');
  await expect(A.page.getByRole('link', { name: /提交出款凭证/ })).toHaveAttribute('href', '/me/withdrawal-report?b=jinlong');
  // W2#005 收尾 4：行动区「写评价」常显（评分因子行内的入口在 dense 折叠里，保留）
  await expect(A.page.locator('main > section.rise').getByRole('link', { name: /写评价/ })).toHaveAttribute('href', '/me/review?b=jinlong');
  await go(A.page, '/brand/jinlong/withdrawal');
  await expect(A.page.getByRole('link', { name: /提交凭证/ })).toHaveAttribute('href', '/me/withdrawal-report?b=jinlong');
});

test('旅程 8 · 自我排除 30 天 → 优惠 / 领码 / 前往官网隐藏，查验与投诉可用', async ({ browser }) => {
  const X = await loginAs(browser, test.info(), uatEmail(test.info().project.name, 'x'), '/me/rg', errors);
  await X.page.getByRole('radiogroup', { name: '排除时长' }).getByRole('radio', { name: '30 天' }).click();
  await X.page.getByRole('button', { name: '确认自我排除' }).click();
  await expect(X.page.getByText(/已自我排除，至/).first()).toBeVisible();
  await go(X.page, '/offers');
  await expect(X.page.getByText('你处于自我排除期')).toBeVisible();
  await expect(X.page.getByRole('button', { name: '领码' })).toHaveCount(0);
  await go(X.page, '/brand/jinlong');
  await expect(X.page.getByRole('link', { name: /前往官网/ })).toHaveCount(0);
  await expect(X.page.getByText(/你处于自我排除期/)).toBeVisible();
  await go(X.page, '/brand/jinlong/bonus');
  await expect(X.page.getByRole('button', { name: '领码' })).toHaveCount(0);
  await go(X.page, '/check/jinlong88.com');
  await expect(X.page.getByText('可以存。').first()).toBeVisible();
  await go(X.page, '/complaint?b=jinlong');
  await expect(X.page.getByRole('radiogroup', { name: '投诉类型' })).toBeVisible();
  // 旅程 7 反例：未绑定用户写评价 / 提交凭证 → 提示先绑定（自我排除期仍可进入，属非商业动作）
  await go(X.page, '/me/review?b=jinlong');
  await expect(X.page.getByText('你还没有绑定该平台的账号')).toBeVisible();
  await go(X.page, '/me/withdrawal-report?b=jinlong');
  await expect(X.page.getByText('你还没有绑定该平台的账号')).toBeVisible();
  await X.ctx.close();
});

test.describe('后台段（桌面端）', () => {
  let M: { ctx: BrowserContext; page: Page };
  let slug = '';
  test.beforeAll(async ({ browser }, info) => {
    if (info.project.name !== '桌面') return;
    test.setTimeout(360_000); // 钩子不继承 describe.configure 的超时：邮箱登录（收信 ≤180s）+ SSH 授权，经 VPN 时 60s 不够
    slug = await server.uatBrand();
    // M 先登录一次建号 → 授 admin → 再用同一会话操作（角色每次请求从库里读）
    M = await loginAs(browser, info, uatEmail('桌面', 'm'), '/me', errors);
    await server.grant(await server.userId(uatEmail('桌面', 'm')), 'admin');
  });
  test.afterAll(async () => M?.ctx.close());
  test.beforeEach(() => test.skip(!desktop(), '后台只在桌面端验收'));

  test('旅程 6 · 受理 → 两次通知（投诉人收到通知）→ 未满答辩期不可曝光', async () => {
    await go(M.page, `/admin/complaints/${caseNotice}`);
    await M.page.getByRole('button', { name: '受理' }).click();
    await M.page.locator('input[name="channel"]').fill('UAT 认领邮箱');
    await M.page.getByRole('button', { name: '记录通知' }).click();
    await expect(M.page.getByText('已记录首次通知')).toBeVisible();
    await M.page.locator('input[name="channel"]').fill('UAT 官方 TG');
    await M.page.getByRole('button', { name: '记录通知' }).click();
    await expect(M.page.getByText('已记录二次通知')).toBeVisible();
    await M.page.locator('input[name="reason"]').first().fill('UAT 尝试提前曝光');
    await M.page.getByRole('button', { name: '确认曝光' }).click();
    await expect(M.page.getByText(/未满足失联条件/)).toBeVisible();
    const n = await server.sql(`select count(*) from "notification" where "userId" = '${userA}' and "title" = '投诉 #${caseNotice} 已通知运营商'`);
    expect(Number(n), '投诉人收到「已通知运营商」').toBe(1);
    const n2 = await server.sql(`select "body" from "notification" where "userId" = '${userA}' and "title" = '投诉 #${caseNotice} 已再次通知运营商'`);
    expect(n2, '投诉人收到二次通知（D-025）').toMatch(/^已再次通知运营商，答辩期剩 7 天/);
    await go(A.page, `/me/complaints/${caseNotice}`);
    await expect(A.page.getByText('待答辩').first()).toBeVisible();
  });

  test('旅程 6 · 记录运营商答辩 → 仲裁中 → 结案「已解决」→ 脱敏公开（D-025）', async () => {
    await go(M.page, `/admin/complaints/${caseNotice}`);
    await M.page.locator('textarea[name="summary"]').fill('运营商称已补发出款（UAT）');
    await M.page.getByRole('button', { name: '记录运营商答辩' }).click();
    await expect(M.page.getByText('已记录运营商答辩，案件进入仲裁')).toBeVisible();
    await M.page.locator('select[name="to"]').selectOption('resolved');
    await M.page.locator('form', { has: M.page.locator('select[name="to"]') }).locator('input[name="reason"]').fill('运营商已出款，投诉人确认（UAT）');
    await M.page.getByRole('button', { name: '提交', exact: true }).click();
    await expect(M.page.getByText('已流转：已解决')).toBeVisible();
    await M.page.locator('input[name="title"]').fill(`UAT ${tag()} 提款延迟已解决`);
    await M.page.locator('textarea[name="publicDescription"]').fill(`UAT 公开摘要 RESOLVED${mark()}`);
    for (const n of ['noPersonalNames', 'noContactInfo', 'noAccountIds', 'noImagesWithFaces']) await M.page.locator(`input[name="${n}"]`).check();
    await M.page.getByRole('button', { name: '确认公开' }).click();
    await expect(M.page.getByText('已公开（脱敏文本已保存）')).toBeVisible();
    const titles = await server.sql(`select string_agg("title", '|' order by "sentAt") from "notification" where "userId" = '${userA}' and "title" like '投诉 #${caseNotice} %'`);
    expect(titles, '投诉人依次收到进入仲裁、已解决').toMatch(/进入仲裁.*已解决/);
    expect(await server.sql(`select count(*) from "points_event" where "dedupeKey" = 'complaint_resolved:${caseNotice}'`), '投诉解决 +100 积分').toBe('1');
    await go(A.page, `/brand/caishen-poker/complaints?q=RESOLVED${mark()}`);
    await expect(A.page.getByText(`#${caseNotice}`)).toBeVisible();
  });

  test('旅程 6 · 黑名单品牌案件：受理 → 直接曝光 → 脱敏公开，公开页只显示公开描述', async () => {
    await go(M.page, `/admin/complaints/${caseExpose}`);
    await M.page.getByRole('button', { name: '受理' }).click();
    await M.page.locator('form', { has: M.page.getByRole('button', { name: '确认曝光' }) }).locator('input[name="reason"]').fill('品牌已为黑名单，受理后直接曝光（UAT）');
    await M.page.getByRole('button', { name: '确认曝光' }).click();
    await expect(M.page.getByText('已确认转曝光')).toBeVisible();
    await M.page.locator('input[name="title"]').fill(`UAT ${tag()} 提款延迟`);
    await M.page.locator('textarea[name="publicDescription"]').fill(`UAT ${tag()} 公开摘要 PUBLIC${mark()}`);
    for (const n of ['noPersonalNames', 'noContactInfo', 'noAccountIds', 'noImagesWithFaces']) await M.page.locator(`input[name="${n}"]`).check();
    await M.page.getByRole('button', { name: '确认公开' }).click();
    await expect(M.page.getByText('已公开（脱敏文本已保存）')).toBeVisible();
    await go(A.page, `/brand/caishen-poker/complaints?q=PUBLIC${mark()}`);
    await expect(A.page.getByText(`#${caseExpose}`)).toBeVisible();
    await go(A.page, `/brand/caishen-poker/complaints?q=SECRET${mark()}`);
    await expect(A.page.getByText(`#${caseExpose}`)).toHaveCount(0);
    const api = await A.page.request.get(`/v1/cases/${caseExpose}`);
    const body = await api.text();
    expect(api.status()).toBe(200);
    expect(body).toContain(`PUBLIC${mark()}`);
    expect(body, '公开接口不得含私密经过').not.toContain(`SECRET${mark()}`);
  });

  test('旅程 9 · 后台完成导出 → 用户可下载；有未结案投诉时执行注销被拒', async () => {
    expect(exportReq).toBe(true);
    // 只操作 A 本人的请求（按申请人 userId 定位，绝不点到别人的请求）
    const mine = () => M.page.locator('section.panel').filter({ hasText: userA });
    await go(M.page, '/admin/data-requests');
    await mine().filter({ has: M.page.getByRole('button', { name: /完成（生成导出包并通知）/ }) }).getByRole('button', { name: /完成（生成导出包并通知）/ }).click();
    await expect(M.page.getByText('已完成并通知申请人')).toBeVisible();
    await go(A.page, '/me/privacy');
    const dl = A.page.getByRole('link', { name: '下载' }).first();
    await expect(dl).toBeVisible();
    const res = await A.page.request.get((await dl.getAttribute('href'))!, { maxRedirects: 0 });
    expect(res.status(), '下载跳转到预签名链接').toBe(302);
    await go(M.page, '/admin/data-requests');
    const anon = () => mine().filter({ has: M.page.getByRole('button', { name: /执行注销/ }) });
    await expect(anon()).toHaveCount(1);
    if (await anon().getByRole('button', { name: '记录联系确认' }).count()) {
      await anon().locator('select[name="channel"]').selectOption('email');
      await anon().getByRole('button', { name: '记录联系确认' }).click();
      // 等动作完成（动作自身重定向回本页并带提示）；点完立即导航会取消表单提交，联系确认未落库 → 无「不可撤销」勾选框（W3#086 第 2 轮）
      await expect(M.page.getByText('已记录联系确认')).toBeVisible();
    }
    await anon().locator('input[name="irreversible"]').check();
    await anon().getByRole('button', { name: /执行注销/ }).click();
    await expect(M.page.getByText(/未结案投诉/).first()).toBeVisible();
    expect(await server.sql(`select "status" from "data_request" where "userId" = '${userA}' and "kind" = 'anonymize'`), '注销申请仍待处理（未执行）').toBe('pending');
  });

  test('旅程 7 · 后台采纳凭证（看得到截图）/ 发布评价 → 积分入账、通知本人', async () => {
    await go(M.page, '/admin/submissions?type=withdrawal');
    const mine = M.page.locator('section.panel').filter({ hasText: userA }).filter({ hasText: '200 USDT' });
    // 截图是懒加载：待审列表累积后本人那条可能在首屏之外，先滚到可见区再断言「真的加载出图」（W3#087：第 3/5/6 轮因此失败）
    const shot = mine.locator('img').first();
    await shot.scrollIntoViewIfNeeded();
    await expect(shot).toBeVisible();
    await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: '凭证截图加载成功' }).toBe(true);
    await mine.getByRole('button', { name: '采纳' }).click();
    await expect(M.page.getByText('凭证已采纳')).toBeVisible();
    await go(M.page, '/admin/submissions?type=review');
    await M.page.locator('section.panel').filter({ hasText: userA }).getByRole('button', { name: '发布' }).click();
    await expect(M.page.getByText('评价已发布')).toBeVisible();
    expect(await server.sql(`select string_agg("event", ',' order by "event") from "points_event" where "userId" = '${userA}' and "event" in ('withdrawal_report_accepted', 'review_published')`)).toBe(
      'review_published,withdrawal_report_accepted',
    );
    expect(Number(await server.sql(`select count(*) from "notification" where "userId" = '${userA}' and "type" = 'submission_decision'`))).toBe(2);
  });

  test('旅程 10 · 品牌转黑名单 → 前台 Offer 全部下线；关联方认证被拒；仲裁员不见 Offer 操作', async ({ browser }) => {
    await go(A.page, `/brand/${slug}/bonus`);
    await expect(A.page.getByRole('button', { name: '领码' })).toHaveCount(1);
    await go(M.page, `/admin/brands?q=${slug}`);
    await M.page.locator('select[name="to"]').selectOption({ label: '黑名单' });
    await M.page.locator('textarea[name="reason"]').fill('UAT 验收：测试品牌转黑名单');
    await M.page.getByLabel('已确认连带后果，原因不含个人信息').check();
    await M.page.getByRole('button', { name: '确认变更' }).click();
    await expect(M.page.getByText('品牌状态已变更为「黑名单」')).toBeVisible();
    await go(A.page, `/brand/${slug}`);
    await expect(A.page.locator('main .badge', { hasText: '黑名单' }).first()).toBeVisible();
    await go(A.page, `/brand/${slug}/bonus`);
    await expect(A.page.getByRole('button', { name: '领码' })).toHaveCount(0);
    await go(A.page, '/offers');
    await expect(A.page.getByText(`UAT 测试优惠 ${RUN}`)).toHaveCount(0);
    expect(await server.sql(`select "status" from "offer" where "id" = 'of_uat_${RUN}'`)).toBe('offline');
    // 关联方品牌（演示库 crown，op_004 关联方）转认证 → 拒绝
    await go(M.page, '/admin/brands?q=crown');
    await M.page.locator('select[name="to"]').selectOption({ label: '平台认证' });
    await M.page.locator('textarea[name="reason"]').fill('UAT 验收：关联方认证应被拒');
    await M.page.getByLabel('已确认连带后果，原因不含个人信息').check();
    await M.page.getByRole('button', { name: '确认变更' }).click();
    await expect(M.page.getByText(/关联方品牌不能认证/)).toBeVisible();
    // 仲裁员 B：品牌页可见状态变更，但 Offer 没有上下线操作（offer.status.write 仅 admin；接口 403 由 api 单测覆盖）
    const B = await browser.newContext((await import('./session')).contextOptions('桌面'));
    const bp = await B.newPage();
    watchConsole(bp, errors);
    await sessionLogin(B, uatEmail('桌面', 'b'));
    await bp.goto('/admin/brands?q=jinlong');
    await expect(bp.getByText('金龙娱乐城').first()).toBeVisible();
    await expect(bp.getByRole('columnheader', { name: '操作' })).toHaveCount(0);
    await expect(bp.getByRole('button', { name: /^(上线|下线)$/ })).toHaveCount(0);
    await B.close();
  });
});

test('旅程 4 · 退出所有设备 → 另一设备会话失效', async () => {
  await go(A.page, '/me');
  await A.page.getByRole('button', { name: '退出所有设备' }).click();
  await expect(A.page).toHaveURL(/\/login/); // 等服务端作废全部会话并跳回登录页，再看另一设备
  const p2 = await A2.newPage();
  await p2.goto('/me', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(p2).toHaveURL(/\/login/);
});

function browser() {
  const b = A.ctx.browser();
  if (!b) throw new Error('no browser');
  return b;
}
