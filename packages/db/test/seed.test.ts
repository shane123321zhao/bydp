import { describe, expect, it } from 'vitest';
import { decryptOperatorAccountId, maskOperatorAccount } from '../src/binding-crypto';
import { buildSeed, fixtureCounts, SEED_PII_KEY } from '../src/seed/build';
import { loadFixtures } from '../src/seed/load';
import { TABLES, assertColumns } from '../src/seed/tables';

const fx = loadFixtures();
const plan = buildSeed(fx);

describe('fixtures → seed', () => {
  it('schema 覆盖架构 §7 全部实体：42 + v1.5 CommissionTerm / OperatorIntegration + 实现表 commission_event（A-007 坑 2）+ verification_token（A-009）+ points_event（A-010）+ self_exclusion / user_preference / data_request（A-011）+ review_item（A-014）+ identity_block（A-016）+ candidate_query / site_check（A-017）+ submission_evidence（A-019）= 55', () => {
    expect(Object.keys(TABLES)).toHaveLength(55);
  });
  it('每行字段都是对应表的列（字段名一致）', () => {
    for (const { table, rows } of plan.tables) expect(() => assertColumns(table, rows)).not.toThrow();
  });
  it('seed 行数 + 跳过行数 = fixtures 条数（无静默丢弃）', () => {
    const counts = fixtureCounts(fx);
    for (const { table, rows } of plan.tables) {
      const skipped = plan.skipped.filter((s) => s.table === table).length;
      expect(rows.length + skipped, table).toBe(counts[table]);
    }
  });
  it('无跳过行（PO 裁定后 fixtures 已补齐）', () => {
    expect(plan.skipped).toEqual([]);
  });
  it('告警只剩非实体聚合块 homeFeed', () => {
    expect(plan.warnings).toEqual(['commerce-users.json.homeFeed 不是 §7 实体（首页聚合 mock），未入库']);
  });
  it('绑定盲索引：64 位十六进制、同品牌不重复', () => {
    const rows = plan.tables.find((t) => t.table === 'user_brand_binding')!.rows;
    const keys = rows.map((r) => `${String(r.brandId)}/${String(r.operatorAccountIdHash)}`);
    for (const r of rows) expect(String(r.operatorAccountIdHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('A-011 T9：绑定明文不入库；密文按 binding.id 解回 fixtures 原值；掩码与原值一致', () => {
    const rows = plan.tables.find((t) => t.table === 'user_brand_binding')!.rows;
    const src = new Map(((fx.commerceUsers.userBrandBindings as Record<string, unknown>[]) ?? []).map((r) => [String(r.id), String(r.operatorAccountId)]));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toHaveProperty('operatorAccountId');
      const plain = src.get(String(r.id))!;
      expect(decryptOperatorAccountId(String(r.operatorAccountIdEnc), SEED_PII_KEY, String(r.id))).toBe(plain);
      expect(r.operatorAccountIdMasked).toBe(maskOperatorAccount(plain));
    }
    expect(() => decryptOperatorAccountId(String(rows[0]!.operatorAccountIdEnc), SEED_PII_KEY, 'ubb_other')).toThrow();
  });
});
