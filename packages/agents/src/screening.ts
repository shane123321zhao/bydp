/**
 * 投诉初筛（D-016 第 4 项 · §13 v1.12 ②：规则基线）：新投诉进入「待初筛」后跑规则，产出 accept / reject / needs_info 建议，
 * **只写 review_item，不改案件状态**；仲裁台案件详情显示建议。只读结构化字段（bydp_agent 读不到标题 / 原文，审核 A-017 Q1）。
 * 规则：24h 内同用户同品牌重复投诉 → reject；与另一账号共用设备且该账号投诉过同品牌 → needs_info；金额为 0 → needs_info；
 * 品牌在黑名单 → accept（受理后可直接曝光，§9.2）；品牌在观察名单 → 附注。LLM 补充意见仅 AGENT_LLM_ENABLED=1 时（本轮未接入）。
 */
import { sql } from '@bydp/db';
import { AGENT_SOURCES, ComplaintScreeningProposal, expectedSubject } from './schemas';
import { proposeReviewItem, type AgentDb } from './db';

const q = <T>(db: AgentDb, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

type Row = { id: string; userId: string; brandId: string; amountUsdt: string; createdAt: Date; brandStatus: string | null };

export async function screenComplaint(db: AgentDb, c: Row): Promise<ComplaintScreeningProposal> {
  const rules: ComplaintScreeningProposal['rules'] = [];
  const [dup] = await q<{ id: string }>(
    db,
    sql`select "id" from "complaint" where "userId" = ${c.userId} and "brandId" = ${c.brandId} and "id" <> ${c.id}
          and "createdAt" between ${c.createdAt}::timestamptz - interval '24 hours' and ${c.createdAt}::timestamptz order by "createdAt" desc limit 1`,
  );
  if (dup) rules.push({ rule: 'duplicate_24h', note: `24 小时内同一用户对同一品牌已有投诉 ${dup.id}` });
  const shared = await q<{ userId: string }>(
    db,
    sql`select distinct o."userId" from "device" mine join "device" o on o."fingerprint" = mine."fingerprint" and o."userId" <> mine."userId"
        join "complaint" oc on oc."userId" = o."userId" and oc."brandId" = ${c.brandId} and oc."createdAt" > ${c.createdAt}::timestamptz - interval '30 days'
        where mine."userId" = ${c.userId} limit 5`,
  );
  if (shared.length) rules.push({ rule: 'same_device_multi_account', note: `与 ${shared.length} 个其他账号共用设备，且其近 30 天投诉过同一品牌` });
  if (!(Number(c.amountUsdt) > 0)) rules.push({ rule: 'missing_amount', note: '涉及金额为 0 或缺失' });
  if (c.brandStatus === null) rules.push({ rule: 'brand_missing', note: '投诉对象品牌不存在' });
  else if (c.brandStatus === 'blacklist') rules.push({ rule: 'brand_blacklisted', note: '品牌在黑名单：受理后可直接曝光（§9.2）' });
  else if (c.brandStatus === 'watch') rules.push({ rule: 'brand_watch', note: '品牌在观察名单' });
  const has = (r: string) => rules.some((x) => x.rule === r);
  const suggest = has('duplicate_24h') ? 'reject' : has('same_device_multi_account') || has('missing_amount') || has('brand_missing') ? 'needs_info' : 'accept';
  return ComplaintScreeningProposal.parse({ complaintId: c.id, suggest, rules });
}

/** 扫描待初筛且尚无初筛提议的投诉（任意状态的提议都算已初筛，避免驳回后反复提议） */
export async function runScreening(db: AgentDb, limit = 50): Promise<{ screened: number; proposed: number }> {
  const rows = await q<Row>(
    db,
    sql`select c."id", c."userId", c."brandId", c."amountUsdt", c."createdAt", b."status" as "brandStatus"
        from "complaint" c left join "brand" b on b."id" = c."brandId"
        where c."status" = 'screening'
          and not exists (select 1 from "review_item" r where r."kind" = 'complaint_screening' and r."subject" = c."id")
        order by c."createdAt" limit ${limit}`,
  );
  let proposed = 0;
  for (const c of rows) {
    const p = await screenComplaint(db, c);
    if (await proposeReviewItem(db, { kind: 'complaint_screening', subject: expectedSubject('complaint_screening', p)!, proposal: p, source: AGENT_SOURCES.screening })) proposed++;
  }
  return { screened: rows.length, proposed };
}
