/** 投诉写路径（M2）：状态机纯函数 + 证据哈希 + DB 集成（事务内回滚；需 DATABASE_URL，已迁移 + seed） */
import { createDb } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, evidenceSha256 } from '../src/complaint/evidence-hash';
import { assertTransition, TRANSITIONS, TransitionError } from '../src/complaint/state';
import { addEvidence, ComplaintInputError, recordSecondNotice, submitComplaint, transitionComplaint, type EvidenceStore } from '../src/complaint/write';

const base = { brandStatus: 'watch' as const, operatorNotifiedAt: null, secondNoticeAt: null, operatorRepliedAt: null, replyDeadline: null, now: new Date('2026-09-28T00:00:00Z') };

describe('状态机（§9.2）', () => {
  it('终态无出边', () => {
    for (const s of ['resolved', 'rejected', 'exposed'] as const) expect(TRANSITIONS[s]).toEqual([]);
  });
  it('不允许跳步', () => expect(() => assertTransition('screening', 'arbitrating', base)).toThrow(TransitionError));
  it('受理后直接曝光仅限黑名单品牌', () => {
    expect(() => assertTransition('accepted', 'exposed', base)).toThrow(/黑名单/);
    expect(() => assertTransition('accepted', 'exposed', { ...base, brandStatus: 'blacklist' })).not.toThrow();
  });
  it('失联 = 两次通知 + 答辩期届满 + 无答辩', () => {
    const n = new Date('2026-09-10T00:00:00Z');
    const ok = { ...base, operatorNotifiedAt: n, secondNoticeAt: new Date('2026-09-14T00:00:00Z'), replyDeadline: new Date('2026-09-17T00:00:00Z') };
    expect(() => assertTransition('awaiting_reply', 'exposed', ok)).not.toThrow();
    expect(() => assertTransition('awaiting_reply', 'exposed', { ...ok, secondNoticeAt: null })).toThrow(/失联/);
    expect(() => assertTransition('awaiting_reply', 'exposed', { ...ok, replyDeadline: new Date('2026-10-01T00:00:00Z') })).toThrow(/失联/);
    expect(() => assertTransition('awaiting_reply', 'exposed', { ...ok, operatorRepliedAt: n })).toThrow(/失联/);
  });
  it('进入仲裁须有答辩', () => expect(() => assertTransition('awaiting_reply', 'arbitrating', base)).toThrow(/答辩/));
});

describe('证据哈希 v1', () => {
  const i = { complaintId: 'cp_x', type: 'screenshot' as const, content: Buffer.from('hello') };
  it('确定性、64 位小写十六进制', () => {
    expect(evidenceSha256(i)).toBe(evidenceSha256({ ...i, content: Buffer.from('hello') }));
    expect(evidenceSha256(i)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('元数据参与哈希：同内容不同案件 → 不同哈希', () => expect(evidenceSha256(i)).not.toBe(evidenceSha256({ ...i, complaintId: 'cp_y' })));
  it('规范化 JSON 键序无关', () => expect(canonicalJson({ b: 1, a: null })).toBe('{"a":null,"b":1}'));
});

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type TxOf = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];
async function inTx<T>(fn: (tx: TxOf) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}
const store = (): EvidenceStore & { keys: string[] } => {
  const keys: string[] = [];
  return { keys, put: async (k) => void keys.push(k) };
};
const input = { brandId: 'br_winner', category: 'refused' as const, amountUsdt: 1200, eventDate: '2026-09-20', description: '提款被拒' };

describe.skipIf(!url)('投诉写路径（DB）', () => {
  it('提交 → screening、不公开、标题由类型 + 金额生成', async () => {
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx, 'u_102', input);
      const [row] = (await tx.execute((await import('@bydp/db')).sql`select "title", "publicSummary", "status" from "complaint" where "id" = ${c.id}`)) as unknown as {
        title: string;
        publicSummary: boolean;
        status: string;
      }[];
      return row;
    });
    expect(r).toEqual({ title: '提款被拒 1,200 USDT', publicSummary: false, status: 'screening' });
  });

  it('bindingId 不属于本人 / 不属于该品牌 → 拒绝', async () => {
    await expect(inTx((tx) => submitComplaint(tx, 'u_233', { ...input, brandId: 'br_jinlong', bindingId: 'ubb_001' }))).rejects.toThrow(ComplaintInputError);
    await expect(inTx((tx) => submitComplaint(tx, 'u_102', { ...input, bindingId: 'ubb_001' }))).rejects.toThrow(ComplaintInputError);
  });

  it('eventDate 晚于提交日 → DB CHECK 拒绝（迁移 0003）', async () => {
    await expect(inTx((tx) => submitComplaint(tx, 'u_102', { ...input, eventDate: '2099-01-01' }))).rejects.toThrow();
  });

  it('全流程：受理 → 待答辩（7 天答辩期）→ 二次通知；状态日志自动写入且带 actor', async () => {
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx, 'u_102', input);
      await transitionComplaint(tx, c.id, 'accepted', { id: 'arbitrator_1', reason: '初筛通过' });
      await transitionComplaint(tx, c.id, 'awaiting_reply', { id: 'arbitrator_1' });
      await recordSecondNotice(tx, c.id);
      const { sql } = await import('@bydp/db');
      const [row] = (await tx.execute(sql`select "acceptedAt" is not null as a, ("replyDeadline" - "operatorNotifiedAt") = interval '7 days' as d, "secondNoticeAt" is not null as s from "complaint" where "id" = ${c.id}`)) as unknown as { a: boolean; d: boolean; s: boolean }[];
      const hist = (await tx.execute(sql`select "to", "actor" from "status_history" where "complaintId" = ${c.id} order by "id"`)) as unknown as { to: string; actor: string }[];
      return { row, hist };
    });
    expect(r.row).toEqual({ a: true, d: true, s: true });
    expect(r.hist).toEqual([
      { to: 'accepted', actor: 'arbitrator_1' },
      { to: 'awaiting_reply', actor: 'arbitrator_1' },
    ]);
  });

  it('契约 v1.6：ComplaintCreate.title 可覆盖自动标题；空白标题回落为自动生成', async () => {
    const r = await inTx(async (tx) => {
      const { sql } = await import('@bydp/db');
      const a = await submitComplaint(tx, 'u_102', { ...input, title: '  出款卡了三天  ' });
      const b = await submitComplaint(tx, 'u_102', { ...input, title: '   ' });
      return (await tx.execute(sql`select "title" from "complaint" where "id" in (${a.id}, ${b.id}) order by "title"`)) as unknown as { title: string }[];
    });
    expect(r.map((x) => x.title).sort()).toEqual(['出款卡了三天', '提款被拒 1,200 USDT'].sort());
    await expect(inTx((tx) => submitComplaint(tx, 'u_102', { ...input, title: 'x'.repeat(61) }))).rejects.toThrow();
  });

  it('§9.2 v1.6 初筛驳回：须填原因；驳回后不公开、不通知运营商，状态日志带原因', async () => {
    await expect(
      inTx(async (tx) => {
        const c = await submitComplaint(tx, 'u_102', input);
        return transitionComplaint(tx, c.id, 'rejected', { id: 'arbitrator_1', reason: '  ' });
      }),
    ).rejects.toThrow(/驳回原因/);
    const r = await inTx(async (tx) => {
      const { sql } = await import('@bydp/db');
      const c = await submitComplaint(tx, 'u_102', input);
      await transitionComplaint(tx, c.id, 'rejected', { id: 'arbitrator_1', reason: '重复提交（同 cp_001）' });
      const [row] = (await tx.execute(sql`select "status", "publicSummary", "operatorNotifiedAt" is null as "notNotified" from "complaint" where "id" = ${c.id}`)) as unknown as object[];
      const hist = (await tx.execute(sql`select "to", "reason" from "status_history" where "complaintId" = ${c.id}`)) as unknown as object[];
      return { row, hist };
    });
    expect(r.row).toEqual({ status: 'rejected', publicSummary: false, notNotified: true });
    expect(r.hist).toEqual([{ to: 'rejected', reason: '重复提交（同 cp_001）' }]);
  });

  it('非法流转被拒：screening → exposed；未到期不得判失联', async () => {
    await expect(
      inTx(async (tx) => {
        const c = await submitComplaint(tx, 'u_102', input);
        return transitionComplaint(tx, c.id, 'exposed', { id: 'a' });
      }),
    ).rejects.toThrow(TransitionError);
    await expect(
      inTx(async (tx) => {
        const c = await submitComplaint(tx, 'u_102', input);
        await transitionComplaint(tx, c.id, 'accepted', { id: 'a' });
        await transitionComplaint(tx, c.id, 'awaiting_reply', { id: 'a' });
        await recordSecondNotice(tx, c.id);
        return transitionComplaint(tx, c.id, 'exposed', { id: 'a' });
      }),
    ).rejects.toThrow(/失联/);
  });

  it('证据：服务端哈希、原文入存储、只允许本人；tx_hash 类型无文件', async () => {
    const s = store();
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx, 'u_102', input);
      const file = await addEvidence(tx, s, 'u_102', c.id, { type: 'screenshot', label: '截图', content: Buffer.from('png-bytes'), contentType: 'image/png' });
      const tx1 = await addEvidence(tx, s, 'u_102', c.id, { type: 'tx_hash', txHash: '0xabc' });
      const other = await addEvidence(tx, s, 'u_233', c.id, { type: 'other', content: Buffer.from('x') }).catch((e) => e);
      return { file, tx1, other, want: evidenceSha256({ complaintId: c.id, type: 'screenshot', content: Buffer.from('png-bytes') }) };
    });
    expect(r.file.sha256).toBe(r.want);
    expect(r.tx1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.keys).toHaveLength(1); // tx_hash 不写对象存储
    expect(r.other).toBeInstanceOf(ComplaintInputError);
  });
});
