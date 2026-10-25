/**
 * D-022 公开旅程（无需登录）：1 查验 · 2 品牌页 · 11 法务页 · 12 地区与语言 · 13 视觉巡检（夹具贯穿）。
 * 数据口径：测试站为演示库（seed:demo），用例与 apps/web/scripts/smoke.mjs 的五个查验用例一致。
 */
import { expect, noHorizontalScroll, test } from './fixtures';

const VERDICTS = /别存。|可以存。|这是假的。|谨慎。|先别存。/;

test.describe('旅程 1 · 查验', () => {
  test('首页搜索已收录域名 → 判定语 + 证据入口 + 可收录', async ({ visit, page }) => {
    await visit('/');
    await page.locator('input#q').fill('jinlong88.com');
    await page.locator('input#q').press('Enter');
    await page.waitForURL(/\/check\/jinlong88\.com$/);
    await noHorizontalScroll(page);
    await expect(page.getByText('可以存。').first()).toBeVisible();
    await expect(page.locator('main')).toContainText(VERDICTS);
    await expect(page.locator('a[href="/brand/jinlong"]').first()).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  });

  test('未收录近似域名 → 先别存 + 你是不是要找 + noindex', async ({ visit, page }) => {
    await visit('/check/jinlong99.com');
    await expect(page.getByText('先别存。').first()).toBeVisible();
    await expect(page.getByText('你是不是要找')).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(1);
  });

  test('五个查验用例判定语', async ({ visit, page }) => {
    test.setTimeout(120_000); // 多页连访：部署后冷启动首个请求可达 7–9 秒（见 W3#072），只放宽时限、不放宽断言
    const cases: Record<string, string> = { 'cs-poker.net': '别存。', 'jinlong88.com': '可以存。', 'jin1ong88.com': '这是假的。', 'winner-sport.co': '谨慎。', 'lucky777-my.com': '先别存。' };
    for (const [q, verdict] of Object.entries(cases)) {
      await visit(`/check/${q}`);
      await expect(page.getByText(verdict, { exact: true }).first(), q).toBeVisible();
    }
  });
});

test.describe('旅程 2 · 品牌页', () => {
  test('认证品牌：评分 · 认证徽章 · 前往官网 · 出款 / 投诉子页', async ({ visit, page }) => {
    test.setTimeout(120_000);
    await visit('/brand/jinlong');
    await expect(page.locator('main .badge', { hasText: '认证' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /前往官网/ })).toBeVisible();
    for (const sub of ['withdrawal', 'complaints', 'domains', 'bonus']) await visit(`/brand/jinlong/${sub}`);
  });

  test('黑名单品牌：实底红徽章，无优惠 / 前往官网 / 领码', async ({ visit, page }) => {
    await visit('/brand/caishen-poker');
    const badge = page.locator('main .badge', { hasText: '黑名单' }).first();
    await expect(badge).toBeVisible();
    const bg = await badge.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b, a = 1] = (bg.match(/[\d.]+/g) ?? []).map(Number);
    expect(a, `徽章应为实底（${bg}）`).toBeGreaterThan(0.9);
    expect(r! > g! + 40 && r! > b! + 40, `徽章底色应为红（${bg}）`).toBe(true);
    await expect(page.getByText('前往官网')).toHaveCount(0);
    await expect(page.getByText('专属优惠')).toHaveCount(0);
    await visit('/brand/caishen-poker/bonus');
    await expect(page.getByRole('button', { name: /领码/ })).toHaveCount(0);
  });
});

test.describe('旅程 11 · 法务页', () => {
  test('/terms 与 /privacy-policy 可达，#cookies 锚点可跳', async ({ visit, page }) => {
    await visit('/terms');
    await expect(page.getByText('草稿，上线前补全').first()).toBeVisible();
    await visit('/privacy-policy#cookies');
    await expect(page.locator('#cookies')).toBeInViewport();
  });

  test('登录页隐私政策链接可点', async ({ visit, page }) => {
    await visit('/login');
    await page.locator('a[href="/privacy-policy"]').first().click();
    await page.waitForURL(/\/privacy-policy/);
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });
});

test.describe('旅程 12 · 地区与语言', () => {
  test('/zh-hant 与 /en 可访问且 noindex', async ({ visit, page }) => {
    for (const p of ['/zh-hant', '/en']) {
      await visit(p);
      await expect(page.locator('meta[name="robots"][content*="noindex"]'), p).toHaveCount(1);
    }
  });

  test('外部伪造 CF-IPCountry: CN 不生效（测试站不在 Cloudflare 后，Caddy 丢弃该头）', async ({ request }) => {
    const res = await request.get('/brand/jinlong', { headers: { 'CF-IPCountry': 'CN' } });
    expect(res.status()).toBe(200);
  });
  // 451 文案本身由 scripts/uat.sh 在服务器内直连 web 容器验证（外部无法伪造国家头）
});

test.describe('旅程 3 · 领码（未登录段）', () => {
  test('优惠列表未登录点「登录领码」→ 跳登录页并带回跳地址', async ({ visit, page }) => {
    await visit('/offers');
    const cta = page.getByText('登录领码').first();
    await expect(cta).toBeVisible();
    await cta.click();
    await page.waitForURL(/\/login\?callbackUrl=/, { timeout: 5_000 });
  });
});

test.describe('SEO 绝对地址（D-025 发现：canonical 曾落到 localhost）', () => {
  test('canonical / hreflang 指向本站域名（动态页 + 构建期静态页）', async ({ visit, page, baseURL }) => {
    for (const p of ['/brand/jinlong', '/methodology', '/privacy-policy']) {
      await visit(p);
      await expect(page.locator('link[rel="canonical"]'), p).toHaveAttribute('href', `${baseURL}${p}`);
      for (const h of await page.locator('link[rel="alternate"][hreflang]').evaluateAll((ls) => ls.map((l) => l.getAttribute('href'))))
        expect(h, `${p} hreflang`).toMatch(new RegExp(`^${baseURL!.replace(/[.]/g, '\\.')}/`));
    }
  });
});
