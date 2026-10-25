// 担保域（P3，架构 v1.2 §7 / ADR-0001 / ADR-0002）：Deposit · Claim · Payout
// P1 只建表埋数据位，不上业务；金额、上限、冷却期 N 待 P3 前定稿。
import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt, usdt } from './_shared';
import { brands } from './operator';
import { complaints } from './trust';
import { userBrandBindings } from './user';

/** ADR-0002：用户赔付准备金 与 超额部分 两账目分离；用户赔付绝对优先 */
export const depositAccount = pgEnum('deposit_account', ['user_reserve', 'excess']);

export const deposits = pgTable(
  'deposit',
  {
    id: pk('dp'),
    brandId: text('brandId')
      .notNull()
      .references(() => brands.id),
    account: depositAccount('account').notNull(),
    amountUsdt: usdt('amountUsdt').notNull(),
    chain: text('chain'),
    txHash: text('txHash'),
    createdAt: createdAt(),
  },
  (t) => [index('deposit_brand_idx').on(t.brandId, t.account)],
);

export const claimStatus = pgEnum('claim_status', ['submitted', 'risk_review', 'approved', 'rejected', 'paid']);

/** 赔付申请：必须关联 Complaint + Binding（§7） */
export const claims = pgTable(
  'claim',
  {
    id: pk('cl'),
    complaintId: text('complaintId')
      .notNull()
      .references(() => complaints.id),
    bindingId: text('bindingId')
      .notNull()
      .references(() => userBrandBindings.id),
    amountUsdt: usdt('amountUsdt').notNull(),
    status: claimStatus('status').notNull().default('submitted'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('claim_amount_nonneg', sql`${t.amountUsdt} >= 0`)],
);

/** 赔付：存链上交易哈希（ADR-0001） */
export const payouts = pgTable('payout', {
  id: pk('po'),
  claimId: text('claimId')
    .notNull()
    .references(() => claims.id),
  amountUsdt: usdt('amountUsdt').notNull(),
  chain: text('chain'),
  txHash: text('txHash'),
  paidAt: tsz('paidAt'),
  createdAt: createdAt(),
});
