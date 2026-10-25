/** Candidate 去刷计数（D-016 第 6 项）：查询者键、爬虫 / 预览 UA、规范值大小写、计数衰减（DB 部分需 DATABASE_URL，事务内执行后回滚） */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { purgeCandidateQueries, recordCandidateQuery, viewerKey } from '../src/trust/candidate-queries';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url, { max: 1 }) : undefined;
afterAll(async () => conn?.client.end());
const KEY = Buffer.alloc(32, 5);
const UA = 'Mozilla/5.0 (iPhone)';

describe('查询者键', () => {
  it('v4 取 /24；v6 展开后取 /48（不同写法同网段一致）；v4 映射按 v4；无 IP 退回设备号', () => {
    expect(viewerKey({ ip: '203.0.113.10', deviceId: null })).toBe('ip4:203.0.113');
    expect(viewerKey({ ip: '2001:db8::1', deviceId: null })).toBe(viewerKey({ ip: '2001:0db8:0000:1::1', deviceId: null }));
    expect(viewerKey({ ip: '2001:db8:0:1::1', deviceId: null })).toBe('ip6:2001:db8:0');
    expect(viewerKey({ ip: '::ffff:203.0.113.77', deviceId: null })).toBe('ip4:203.0.113');
    expect(viewerKey({ ip: null, deviceId: 'd'.repeat(32) })).toBe(`dev:${'d'.repeat(32)}`);
    expect(viewerKey({ ip: null, deviceId: null })).toBeNull();
  });
});

describe.skipIf(!url)('计数（DB）', () => {
  const inTx = async <T>(fn: (tx: Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0]) => Promise<T>) => {
    let out!: T;
    const RB = new Error('rb');
    await conn!.db
      .transaction(async (tx) => {
        await tx.execute(sql`set local role bydp_app`);
        out = await fn(tx);
        throw RB;
      })
      .catch((e) => {
        if (e !== RB) throw e;
      });
    return out;
  };
  it('爬虫 / 链接预览 UA 不计；钱包地址保留原大小写；7 日外的记录在每日重算后不再计入（衰减）', async () => {
    const r = await inTx(async (tx) => {
      const bots = [];
      for (const ua of ['WhatsApp/2.23', 'TelegramBot (like TwitterBot)', 'Go-http-client/1.1', 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)', 'Scrapy/2.11']) {
        bots.push(await recordCandidateQuery(tx, { type: 'domain', value: 'bot-test.com' }, { ip: '198.51.100.1', deviceId: null, userAgent: ua }, KEY));
      }
      const wallet = await recordCandidateQuery(tx, { type: 'wallet', value: 'TXyZaBcD1234567890AbCdEfGhIjKlMnOp' }, { ip: '198.51.100.1', deviceId: null, userAgent: UA }, KEY);
      const [w] = (await tx.execute(sql`select "value" from "candidate" where "id" = ${wallet!.candidateId}`)) as unknown as { value: string }[];
      const a = await recordCandidateQuery(tx, { type: 'domain', value: 'decay-test.com' }, { ip: '198.51.100.1', deviceId: null, userAgent: UA }, KEY);
      await recordCandidateQuery(tx, { type: 'domain', value: 'decay-test.com' }, { ip: '203.0.113.1', deviceId: null, userAgent: UA }, KEY);
      // 把这两条记录挪到 10 天前（模拟时间流逝；candidate_query 不可改，故 owner 删后重插）
      await tx.execute(sql`reset role`);
      const rows = (await tx.execute(sql`select "id", "viewerHash" from "candidate_query" where "candidateId" = ${a!.candidateId}`)) as unknown as { id: string; viewerHash: string }[];
      await tx.execute(sql`delete from "candidate_query" where "candidateId" = ${a!.candidateId}`);
      for (const x of rows) await tx.execute(sql`insert into "candidate_query" ("id","candidateId","viewerHash","day") values (${x.id}, ${a!.candidateId}, ${x.viewerHash}, current_date - 10)`);
      await tx.execute(sql`set local role bydp_app`);
      const [before] = (await tx.execute(sql`select "weightedPriority"::float as w from "candidate" where "id" = ${a!.candidateId}`)) as unknown as { w: number }[];
      const purge = await purgeCandidateQueries(tx);
      const [after] = (await tx.execute(sql`select "weightedPriority"::float as w, "queryCount7d" as q from "candidate" where "id" = ${a!.candidateId}`)) as unknown as { w: number; q: number }[];
      return { bots, walletValue: w!.value, before: before!.w, after, recomputed: purge.recomputed };
    });
    expect(r.bots).toEqual([null, null, null, null, null]);
    expect(r.walletValue).toBe('TXyZaBcD1234567890AbCdEfGhIjKlMnOp');
    expect(r.before).toBe(2);
    expect(r.after).toEqual({ w: 0, q: 0 });
    expect(r.recomputed).toBeGreaterThanOrEqual(1);
  });
});
