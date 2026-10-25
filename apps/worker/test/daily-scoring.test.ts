/** 每日评分任务：scoring（只读）→ core（bydp_app 写）；幂等（A-003 C5）。需 DATABASE_URL 与 DATABASE_URL_SCORING_RO */
import { connect } from '@bydp/core/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { runDailyScoring, scheduledSlot } from '../src/jobs/daily-scoring';

describe('scheduledSlot（自检 B1）', () => {
  it('取计划槽位 prevMillis，而非任务创建时刻', () => {
    const slot = Date.parse('2026-09-28T18:00:00Z');
    expect(scheduledSlot({ timestamp: slot - 86_400_000 + 5_000, opts: { prevMillis: slot, delay: 86_395_000 } }).toISOString()).toBe('2026-09-28T18:00:00.000Z');
    expect(scheduledSlot({ timestamp: 1_000, opts: { delay: 500 } }).getTime()).toBe(1_500);
  });
});

const url = process.env.DATABASE_URL;
const ro = process.env.DATABASE_URL_SCORING_RO;
if (process.env.BYDP_CI === '1' && (!url || !ro)) throw new Error('CI 必须提供 DATABASE_URL 与 DATABASE_URL_SCORING_RO');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());

describe.skipIf(!url || !ro)('runDailyScoring', () => {
  it('写入全部品牌快照；同一计划时刻重跑不重复写入', async () => {
    const at = new Date('2030-01-01T02:00:30Z'); // 未来时刻，避免与 seed 快照冲突；取整到分
    let first: Awaited<ReturnType<typeof runDailyScoring>> | undefined;
    let second: typeof first;
    await conn!.db
      .transaction(async (tx) => {
        first = await runDailyScoring(tx as never, at, ro);
        second = await runDailyScoring(tx as never, at, ro);
        tx.rollback();
      })
      .catch((e: Error) => {
        if (!/rollback/i.test(e.message)) throw e;
      });
    expect(first).toMatchObject({ brands: 8, inserted: 8, skipped: 0 });
    expect(first!.computedAt.toISOString()).toBe('2030-01-01T02:00:00.000Z');
    expect(second).toMatchObject({ inserted: 0, skipped: 8 });
  });
});
