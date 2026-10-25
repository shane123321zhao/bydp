/** 只读连接与全量计算（需 DATABASE_URL_SCORING_RO：bydp_scoring_ro 连接串） */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { computeAll, connectReadOnly, loadInputs } from '../src/index';

const url = process.env.DATABASE_URL_SCORING_RO;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL_SCORING_RO');

describe.skipIf(!url)('bydp_scoring_ro 只读计算', () => {
  it('C4：连接显式只读；写入被拒', async () => {
    const sql = connectReadOnly(url);
    try {
      // 自检 I6：来源为 client（连接启动参数），而非仅靠角色级设置
      const [r] = await sql<{ setting: string; source: string }[]>`select "setting", "source" from pg_settings where "name" = 'default_transaction_read_only'`;
      expect(r).toEqual({ setting: 'on', source: 'client' });
      await expect(sql`insert into "score_snapshot" ("id","brandId","algorithmVersion","confidence","factorsAvailable","factorsTotal") values ('x','br_jinlong','x','none',0,5)`).rejects.toThrow(
        /read-only transaction/,
      );
      await expect(sql`select 1 from "offer" limit 1`).rejects.toThrow(/permission denied/);
    } finally {
      await sql.end();
    }
  });

  // A-019：读数只计已审行——待审 / 驳回的出款凭证与评价不进计分（过滤在 read.ts，故以真实只读连接验证）
  it.skipIf(!process.env.DATABASE_URL)('A-019：pending / rejected 的出款凭证与评价不计入；accepted / published 计入', async () => {
    const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const ro = connectReadOnly(url);
    const tag = Math.random().toString(36).slice(2, 8);
    const count = async () => {
      const b = (await loadInputs(ro)).find((x) => x.id === 'br_longteng')!;
      return { w: b.withdrawals.length, r: b.reviews.length };
    };
    try {
      const before = await count();
      await owner.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL bydp.allow_backfill = 'on'`); // owner 回填可显式写入状态（应用角色写入一律被强制 pending）
        for (const st of ['pending', 'rejected', 'accepted'] as const)
          await tx.unsafe(
            `INSERT INTO withdrawal_report (id, "brandId", kind, "amountUsdt", method, "requestedAt", "receivedAt", outcome, status, "decidedBy", "rejectReason")
             VALUES ('wr_a019_${st}_${tag}', 'br_longteng', 'official', 10, 'x', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'paid', '${st}', 'test', ${st === 'rejected' ? `'x'` : 'NULL'})`,
          );
        for (const [st, user] of [['pending', 'u_102'], ['rejected', 'u_233'], ['published', 'u_412']] as const)
          await tx.unsafe(
            `INSERT INTO review (id, "brandId", "userId", rating, text, "trustWeight", status, "decidedBy", "rejectReason")
             VALUES ('rv_a019_${st}_${tag}', 'br_longteng', '${user}', 1, 't', 1, '${st}', 'test', ${st === 'rejected' ? `'x'` : 'NULL'})`,
          );
      });
      expect(await count()).toEqual({ w: before.w + 1, r: before.r + 1 });
    } finally {
      // 只读连接看得到的数据必须真实提交；用完由 owner 删除（应用角色无 DELETE 权限），不污染同库其他包的测试
      await owner.unsafe(`DELETE FROM review WHERE id LIKE 'rv_a019_%_${tag}'`);
      await owner.unsafe(`DELETE FROM withdrawal_report WHERE id LIKE 'wr_a019_%_${tag}'`);
      await ro.end();
      await owner.end();
    }
  });

  it('C5：同一库状态 + 同一时刻，两次全量计算结果一致；黑名单为 null', async () => {
    const at = new Date('2026-09-23T02:00:00Z');
    const a = await computeAll(at, url);
    const b = await computeAll(at, url);
    expect(a).toEqual(b);
    expect(a.length).toBe(8);
    for (const s of a.filter((x) => ['br_caishen', 'br_haoyun'].includes(x.brandId))) expect(s.score).toBeNull();
  });
});
