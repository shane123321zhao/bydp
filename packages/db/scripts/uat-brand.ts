/**
 * D-022 UAT 一次性测试品牌（**仅测试站**）：旅程 10「品牌转黑名单 → 前台该品牌 Offer 全部下线」需要一个可被拉黑而不污染演示数据的品牌。
 * 用法（测试站 migrate 容器内，由 scripts/uat.sh 调用）：tsx scripts/uat-brand.ts <runId>
 * 建：运营商 op_uat_<runId>（非关联方）· 品牌 br_uat_<runId>（slug uat-<runId>，观察库）· 1 条在效 Offer + 优惠码。已存在则跳过。
 * 只在 BYDP_ENV=staging 运行；正式环境 / 本机未设 BYDP_ENV 一律拒绝。输出一行 slug。
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../src/index';
import { TABLES } from '../src/seed/tables';

if (process.env.BYDP_ENV !== 'staging') {
  console.error('拒绝执行：UAT 测试品牌只允许在测试站（BYDP_ENV=staging）创建');
  process.exit(1);
}
const run = process.argv[2] ?? '';
if (!/^[a-z0-9]{4,16}$/.test(run)) {
  console.error('用法：uat-brand.ts <runId（小写字母数字 4–16 位）>');
  process.exit(2);
}
const today = new Date().toISOString().slice(0, 10);
const { db, client } = createDb();
try {
  const [exists] = (await db.execute(sql`select 1 from "brand" where "id" = ${`br_uat_${run}`}`)) as unknown as unknown[];
  if (!exists) {
    await db.transaction(async (tx) => {
      await tx.insert(TABLES.operator!).values({ id: `op_uat_${run}`, legalName: `UAT Operator ${run}`, jurisdiction: 'PH', foundedYear: 2020, relatedParty: false } as never);
      await tx.insert(TABLES.brand!).values({
        id: `br_uat_${run}`,
        operatorId: `op_uat_${run}`,
        slug: `uat-${run}`,
        name: { zhHans: `UAT 测试品牌 ${run}`, zhHant: `UAT 測試品牌 ${run}`, en: `UAT Brand ${run}` },
        status: 'watch',
        statusSince: today,
        markets: ['MY'],
        hasActiveExposure: false,
        logoUrl: null,
      } as never);
      await tx.insert(TABLES.offer!).values({
        id: `of_uat_${run}`,
        brandId: `br_uat_${run}`,
        title: `UAT 测试优惠 ${run}`,
        type: 'first_deposit_match',
        matchPercent: 50,
        maxBonusUsdt: 100,
        minDepositUsdt: 20,
        terms: { rolloverMultiple: 10, rolloverBase: 'deposit_plus_bonus', maxWithdrawalUsdt: 1000, validDays: 7, restrictedGames: [], eligibleGames: ['老虎机'] },
        // D-029：tv-1 公式结果（core computeTrueValue 同参数复算，db 脚本不依赖 core 故写定值）
        trueValue: { exampleDepositUsdt: 200, bonusUsdt: 100, requiredTurnoverUsdt: 3000, expectedCostAtRtp96Usdt: 120, netExpectedValueUsdt: -20, verdict: 'negative', verdictText: '按 96% RTP 老虎机打满流水，期望净值约 -20 USDT；奖励实为流水补贴，不是净收益', methodVersion: 'tv-1' },
        exclusive: false,
        sponsored: false,
        riskLabel: null,
        compensationEligible: false,
        validUntil: null,
      } as never);
      await tx.insert(TABLES.promo_code!).values({ id: `pc_uat_${run}`, offerId: `of_uat_${run}`, code: `UAT-${run.toUpperCase()}`, channel: 'web', claimedCount: 0, activeUntil: null } as never);
    });
  }
  console.log(`uat-${run}`);
} finally {
  await client.end();
}
