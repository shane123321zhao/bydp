/**
 * UAT 公共夹具：旅程 13 视觉巡检贯穿全部用例——
 * - 页面控制台 error / 未捕获异常 计为失败（用例结束时断言）；W2#019：唯一例外是 React #418（已知 F6，手机端低频残留）——
 *   单列为附件「known-f6」由报告汇总，不判该用例失败；一轮内 ≥ 3 次由报告判整轮失败。只认 #418 这一个错误码，不做通配。
 * - visit() 打开页面后检查手机 / 桌面宽度下无横向滚动、正文无溢出。
 */
import { expect, test as base, type Page } from '@playwright/test';

type Fixtures = { consoleErrors: string[]; visit: (path: string) => Promise<Page> };

export const test = base.extend<Fixtures>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${m.text().slice(0, 160)} @ ${page.url()}`);
    });
    page.on('pageerror', (e) => errors.push(`未捕获异常 ${e.message.slice(0, 160)} @ ${page.url()}`));
    await use(errors);
    await checkConsole(errors);
  },
  visit: async ({ page, consoleErrors }, use) => {
    void consoleErrors; // 确保控制台监听先于导航挂上
    await use(async (path: string) => {
      const res = await page.goto(path, { waitUntil: 'networkidle' });
      expect(res?.status(), `${path} 状态码`).toBeLessThan(400);
      await noHorizontalScroll(page);
      return page;
    });
  },
});

const KNOWN_F6 = /Minified React error #418[;\s]/;
/** 控制台断言（W2#019）：#418 单列附件 known-f6（报告计数），其余任何错误判失败 */
export async function checkConsole(errors: string[]) {
  const f6 = errors.filter((e) => KNOWN_F6.test(e));
  if (f6.length) await base.info().attach('known-f6', { body: f6.map((e) => e.split(' @ ').pop()).join('\n'), contentType: 'text/plain' });
  expect(errors.filter((e) => !KNOWN_F6.test(e)), '控制台不应有错误').toEqual([]);
}

/** 旅程 13：页面宽度不超过视口（容许 1px 舍入），且没有元素右缘越出视口 */
export async function noHorizontalScroll(page: Page) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sw = document.scrollingElement?.scrollWidth ?? 0;
    const over: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('body *'))) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      // 自身或祖先可横向滚动 / 裁剪的（表格容器、横滑标签）不算溢出
      let p: HTMLElement | null = el.parentElement;
      let clipped = false;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') {
          clipped = true;
          break;
        }
        p = p.parentElement;
      }
      if (!clipped && b.right > vw + 1 && getComputedStyle(el).position !== 'fixed') over.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);
      if (over.length >= 3) break;
    }
    return { vw, sw, over };
  });
  expect(r.sw, `页面横向滚动（内容宽 ${r.sw} > 视口 ${r.vw}）：${r.over.join(', ')}`).toBeLessThanOrEqual(r.vw + 1);
  expect(r.over, '元素越出视口').toEqual([]);
}

export { expect };
