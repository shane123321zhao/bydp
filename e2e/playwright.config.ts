/**
 * D-022 测试站全链路验收（UAT）：真浏览器 · 真测试站 · 用户视角。入口 `bash scripts/uat.sh`（读取门禁 Cookie 后调用本配置，W2#010）。
 * 桌面 1280 宽 + 手机 390 宽各跑一遍；失败自动截图到 e2e/.out/。
 */
import { defineConfig, devices } from '@playwright/test';
import { gateStorageState } from './uat/gate';

const baseURL = process.env.UAT_BASE ?? 'https://staging.northx.vip';
const gate = gateStorageState(baseURL);

export default defineConfig({
  testDir: './uat',
  outputDir: './.out/results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['./uat-reporter.ts']],
  use: {
    baseURL,
    ...(gate ? { storageState: gate } : {}),
    locale: 'zh-CN',
    timezoneId: 'Asia/Singapore',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    { name: '桌面', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: '手机', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
