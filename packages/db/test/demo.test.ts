/** 演示数据（方案 A）纯函数断言：不连库 */
import { describe, expect, it } from 'vitest';
import { buildDemo, DEMO_CLAIMS } from '../src/seed/demo';
import { loadFixtures } from '../src/seed/load';
import { assertColumns } from '../src/seed/tables';

const plan = buildDemo();
const rows = (t: string) => plan.tables.find((x) => x.table === t)?.rows ?? [];

describe('demo 点击（D-007：已领码 = Click 计数）', () => {
  const clicks = rows('click');

  it('每个专属码的点击数 = fixtures 公开的 claimedCount', () => {
    const fx = loadFixtures().commerceUsers as unknown as { promoCodes: { id: string; claimedCount: number }[] };
    for (const c of DEMO_CLAIMS) {
      const want = fx.promoCodes.find((p) => p.id === c.promoCodeId)!.claimedCount;
      expect(clicks.filter((r) => r.promoCodeId === c.promoCodeId)).toHaveLength(want);
    }
  });

  it('24h 同用户去重：同一用户同一 offer 的相邻两次点击间隔 > 24h；id 带 demo 前缀、用户均为 demo 用户', () => {
    const byKey = new Map<string, number[]>();
    for (const r of clicks) {
      expect(String(r.id)).toMatch(/^clk_demo_/);
      expect(String(r.userId)).toMatch(/^u_demo_/);
      const k = `${String(r.userId)}|${String(r.offerId)}`;
      byKey.set(k, [...(byKey.get(k) ?? []), (r.createdAt as Date).getTime()]);
    }
    for (const ts of byKey.values()) {
      ts.sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThan(24 * 3_600_000);
    }
  });

  it('点击引用的用户都在 demo 用户表内；字段均为 schema 列', () => {
    const users = new Set(rows('app_user').map((u) => u.id));
    for (const r of clicks) expect(users.has(r.userId)).toBe(true);
    expect(() => assertColumns('click', clicks)).not.toThrow();
  });
});
