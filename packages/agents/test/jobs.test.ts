/** Agent 任务（需 DATABASE_URL：已迁移 + seed 的库，owner 连接）：每例事务内 SET LOCAL ROLE bydp_agent 后执行，最后回滚——同时验证 Agent 角色权限够用且不越权 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { runLocalization, makeHansToHant } from '../src/localization';
import { runScreening } from '../src/screening';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url, { max: 1 }) : undefined;
afterAll(async () => conn?.client.end());
const ROLLBACK = new Error('rollback');

async function inAgentTx<T>(setup: string[], fn: (tx: Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  let out!: T;
  await conn!.db
    .transaction(async (tx) => {
      for (const s of setup) await tx.execute(sql.raw(s));
      await tx.execute(sql`set local role bydp_agent`);
      out = await fn(tx);
      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
  return out;
}
const proposals = (tx: { execute: (s: ReturnType<typeof sql>) => Promise<unknown> }, kind: string) =>
  tx.execute(sql`select "subject", "proposal", "source", "status" from "review_item" where "kind" = ${kind} order by "subject"`) as Promise<
    { subject: string; proposal: Record<string, unknown>; source: string; status: string }[]
  >;

const user = (id: string) => `insert into "app_user" ("id","displayName") values ('${id}','测试')`;
const complaint = (id: string, userId: string, brandId: string, amount = 500, ago = '1 hour') =>
  `insert into "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","status","createdAt")
   values ('${id}','${brandId}','${userId}','refused','t',${amount},'2026-09-20','x','screening', now() - interval '${ago}')`;

describe.skipIf(!url)('投诉初筛（规则基线，只写 review_item）', () => {
  it('24h 内同用户同品牌重复 → reject；黑名单品牌 → accept（附规则）；金额 0 → needs_info；同设备他人投诉过同品牌 → needs_info；已有提议不重复', async () => {
    const r = await inAgentTx(
      [
        `set local bydp.allow_backfill = 'on'`,
        user('u_s1'), user('u_s2'), user('u_s3'), user('u_s4'),
        complaint('cp_s1a', 'u_s1', 'br_winner', 500, '3 hours'),
        complaint('cp_s1b', 'u_s1', 'br_winner', 500, '1 hour'),
        `update "brand" set "status" = 'blacklist' where "id" = 'br_starlight'`,
        complaint('cp_s2', 'u_s2', 'br_starlight'),
        complaint('cp_s3', 'u_s3', 'br_crown', 0),
        `insert into "device" ("id","userId","fingerprint") values ('dv_s4','u_s4','${'7'.repeat(64)}'), ('dv_s1','u_s1','${'7'.repeat(64)}')`,
        complaint('cp_s4', 'u_s4', 'br_winner', 300, '30 minutes'),
      ],
      async (tx) => {
        const first = await runScreening(tx);
        const again = await runScreening(tx);
        const rows = (await proposals(tx, 'complaint_screening')).filter((p) => p.subject.startsWith('cp_s'));
        return { first, again, rows };
      },
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.subject, x.proposal as { suggest: string; rules: { rule: string }[] }]));
    expect(by.cp_s1b!.suggest).toBe('reject');
    expect(by.cp_s1b!.rules.map((x) => x.rule)).toContain('duplicate_24h');
    // 同设备规则是对称的：u_s1 与 u_s4 共用设备且都投诉过 br_winner，两边都标记
    expect(by.cp_s1a!.suggest).toBe('needs_info');
    expect(by.cp_s1a!.rules.map((x) => x.rule)).toEqual(['same_device_multi_account', 'brand_watch']);
    expect(by.cp_s2).toMatchObject({ suggest: 'accept', rules: [{ rule: 'brand_blacklisted' }] });
    expect(by.cp_s3!.suggest).toBe('needs_info');
    expect(by.cp_s3!.rules.map((x) => x.rule)).toContain('missing_amount');
    expect(by.cp_s4!.suggest).toBe('needs_info');
    expect(by.cp_s4!.rules.map((x) => x.rule)).toContain('same_device_multi_account');
    expect(r.rows.every((x) => x.status === 'pending' && x.source === 'screening-rules@0.1')).toBe(true);
    expect(r.again.proposed).toBe(0);
  });
});

describe.skipIf(!url)('本地化初稿（OpenCC 简 → 台繁 + 术语表）', () => {
  it('转换器：台湾口径用语；术语表条目优先', () => {
    expect(makeHansToHant([])('软件 提款被拒 先行赔付保障')).toBe('軟體 提款被拒 先行賠付保障');
    expect(makeHansToHant([{ hans: '黑盘', hant: '黑平台' }])('查黑盘')).toBe('查黑平台');
  });
  it('品牌名缺繁体 → 提议；内容缺繁体译本 → 提议；已有提议不重复', async () => {
    const r = await inAgentTx(
      [
        `update "brand" set "name" = jsonb_build_object('zhHans', '赢家体育') where "id" = 'br_winner'`,
        `insert into "content" ("id","type","key","locale","title","body") values ('ct_l1','advice','test-key','zh-Hans','防骗指南','先查黑盘再存款')`,
      ],
      async (tx) => {
        const first = await runLocalization(tx);
        const again = await runLocalization(tx);
        const rows = await proposals(tx, 'localization');
        return { first, again, rows };
      },
    );
    const brand = r.rows.find((x) => x.subject === 'brand:br_winner:zh-Hant')!;
    expect(brand.proposal).toMatchObject({ target: { type: 'brand_name', brandId: 'br_winner' }, locale: 'zh-Hant', engine: 'opencc', title: '贏家體育' });
    const content = r.rows.find((x) => x.subject === 'content:ct_l1:zh-Hant')!;
    expect(content.proposal).toMatchObject({ target: { type: 'content', contentId: 'ct_l1' }, title: '防騙指南' });
    expect(r.again.proposed).toBe(0);
  });
});
