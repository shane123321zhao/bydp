/**
 * D-024 出款凭证 / 评价：用户提交 → 截图 → 后台判定（积分 / 通知 / 审计）→ 判定后补录提醒；导出与「删除证据原文」覆盖截图。
 * 已迁移 + seed 的库；事务内执行后回滚；业务用例以 bydp_app 执行（库触发器为最后一道防线，见 db guards 0016）。
 * seed：ubb_002 = u_233 · br_winner · 自报级 · boundAt 2026-08-14；ubb_004 = u_412 · br_crown · 回传确认。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { addWithdrawalEvidence, amendWithdrawalOutcome, createReview, createWithdrawalReport, listMySubmissions, SubmissionInputError, submitWithdrawalWithEvidence } from '../src/trust/submissions';
import { reconcileDeletedObjects } from '../src/admin/object-reconcile';
import { previewKey } from '../src/admin/evidence';
import { decideSubmission, listAdminReviews, listAdminWithdrawals, rejectPendingSubmissionsOf, SubmissionStateError } from '../src/admin/submissions';
import { buildExport, rejectPendingDataRequestsOf, resolveDataRequest } from '../src/admin/data-requests';
import { createDataRequest } from '../src/identity/privacy';
import type { EvidenceStore } from '../src/complaint/write';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];
const ARB = { id: 'u_arb_t', role: 'arbitrator' as const, ip: null };
const ED = { id: 'u_ed_t', role: 'editor' as const, ip: null };
const ADMIN = { id: 'u_adm_t', role: 'admin' as const, ip: null };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const memStore = () => {
  const m = new Map<string, Uint8Array>();
  const s: EvidenceStore & { m: Map<string, Uint8Array> } = {
    m,
    put: async (k, v) => void m.set(k, v),
    get: async (k) => m.get(k) ?? null,
    delete: async (k) => void m.delete(k),
    exists: async (k) => m.has(k),
  };
  return s;
};
const ago = (d: number) => new Date(Date.now() - d * 86_400_000);

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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
const asApp = (tx: Tx) => tx.execute(sql`set local role bydp_app`);
const one = async <T>(tx: Tx, s: ReturnType<typeof sql>) => ((await tx.execute(s)) as unknown as T[])[0]!;

describe.skipIf(!url)('D-024 出款凭证', () => {
  it('提交 → 无截图不能采纳 → 上传截图 → 采纳（积分 +50、通知本人、audit）；scoring 口径 accepted', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const wr = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 120, method: 'USDT-TRC20', requestedAt: ago(2), receivedAt: ago(2), outcome: 'paid' });
      const noShot = await decideSubmission(tx, ARB, 'withdrawal', wr.id, 'accept', null).catch((e: Error) => e);
      const ev = await addWithdrawalEvidence(tx, store, 'u_233', wr.id, PNG);
      const pending = await listAdminWithdrawals(tx, { status: 'pending' });
      const decided = await decideSubmission(tx, ARB, 'withdrawal', wr.id, 'accept', null);
      const row = await one<{ status: string; decidedBy: string }>(tx, sql`select "status", "decidedBy" from "withdrawal_report" where "id" = ${wr.id}`);
      const pts = await one<{ n: number }>(tx, sql`select count(*)::int as "n" from "points_event" where "dedupeKey" = ${`withdrawal_report_accepted:${wr.id}`}`);
      const nt = await one<{ title: string }>(tx, sql`select "title" from "notification" where "id" = ${decided.notificationIds[0]!}`);
      const audit = await one<{ n: number }>(tx, sql`select count(*)::int as "n" from "audit_log" where "targetId" = ${wr.id} and "action" = 'withdrawal_report_accepted'`);
      const lateShot = await addWithdrawalEvidence(tx, store, 'u_233', wr.id, PNG).catch((e: Error) => e.message);
      return { wr, noShot, ev, pending: pending.find((x) => x.id === wr.id), row, pts, nt, audit, lateShot };
    });
    expect(r.wr.status).toBe('pending');
    expect(r.noShot).toBeInstanceOf(SubmissionStateError);
    expect(r.ev.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.pending?.evidence).toHaveLength(1);
    expect(r.pending?.bindingLevel).toBe('self_reported');
    expect(r.row).toEqual({ status: 'accepted', decidedBy: 'u_arb_t' });
    expect(r.pts.n).toBe(1);
    expect(r.nt.title).toMatch(/^出款凭证已采纳：/);
    expect(r.audit.n).toBe(1);
    expect(r.lateShot).toMatch(/已审核/);
    expect(store.m.size).toBe(1);
  });

  it('输入校验：无本人绑定 / 绑定晚于申请 → SubmissionInputError；已到账须到账时间；截图只收图片 / PDF；他人不能上传', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const noBinding = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_jinlong', amountUsdt: 1, method: 'x', requestedAt: ago(1), outcome: 'refused' }).catch((e) => e);
      const before = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 1, method: 'x', requestedAt: new Date('2026-08-01'), outcome: 'refused' }).catch((e) => e);
      const paidNoTime = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 1, method: 'x', requestedAt: ago(1), outcome: 'paid' }).catch((e: Error) => e.message);
      const wr = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 1, method: 'x', requestedAt: ago(1), outcome: 'pending' });
      const txt = await addWithdrawalEvidence(tx, store, 'u_233', wr.id, new TextEncoder().encode('hello')).catch((e: Error) => e.message);
      const other = await addWithdrawalEvidence(tx, store, 'u_102', wr.id, PNG).catch((e: Error) => e.message);
      return { noBinding, before, paidNoTime, txt, other };
    });
    expect(r.noBinding).toBeInstanceOf(SubmissionInputError);
    expect(r.before).toBeInstanceOf(SubmissionInputError);
    expect(r.paidNoTime).toMatch(/到账时间/);
    expect(r.txt).toMatch(/只接受图片/);
    expect(r.other).toMatch(/不属于本人/);
  });

  it('判定后补录：pending → paid 写 outcomeAmendedAt、audit，并给仲裁组发提醒；列表带「判定后补录」标记且可筛选', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "app_user" ("id", "displayName") values ('u_arb_t', 'arb') on conflict do nothing`);
      await tx.execute(sql`insert into "role" ("key", "name") values ('arbitrator', '仲裁员') on conflict do nothing`);
      await tx.execute(sql`insert into "user_role" ("userId", "roleKey") values ('u_arb_t', 'arbitrator') on conflict do nothing`);
      await asApp(tx);
      const wr = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 50, method: 'x', requestedAt: ago(3), outcome: 'pending' });
      await addWithdrawalEvidence(tx, store, 'u_233', wr.id, PNG);
      await decideSubmission(tx, ARB, 'withdrawal', wr.id, 'accept', null);
      const amended = await amendWithdrawalOutcome(tx, 'u_233', wr.id, { outcome: 'paid', receivedAt: ago(1) });
      const again = await amendWithdrawalOutcome(tx, 'u_233', wr.id, { outcome: 'refused' }).catch((e: Error) => e.message);
      const flagged = await listAdminWithdrawals(tx, { status: 'accepted', amended: true });
      const staff = await one<{ n: number }>(tx, sql`select count(*)::int as "n" from "notification" where "userId" = 'u_arb_t' and "type" = 'submission_amended'`);
      const audit = await one<{ n: number }>(tx, sql`select count(*)::int as "n" from "audit_log" where "targetId" = ${wr.id} and "action" = 'withdrawal_outcome_amended_after_decision'`);
      return { wr, amended, again, flagged: flagged.find((x) => x.id === wr.id), staff, audit };
    });
    expect(r.amended.notificationIds.length).toBeGreaterThanOrEqual(1);
    expect(r.again).toMatch(/补录一次/);
    expect(r.flagged?.amendedAfterDecision).toBe(true);
    expect(r.staff.n).toBe(1);
    expect(r.audit.n).toBe(1);
  });
});

describe.skipIf(!url)('D-024 评价', () => {
  it('提交（权重由库写入：回传确认 1.0）→ 驳回须原因 → 发布（积分 +20、通知）；同品牌第二条被拒；文字只在后台可见', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const rv = await createReview(tx, 'u_412', { brandId: 'br_crown', rating: 4, text: '出款稳定' });
      const dup = await tx.transaction((t2) => createReview(t2, 'u_412', { brandId: 'br_crown', rating: 5 })).catch((e: { cause?: { constraint_name?: string } }) => e.cause?.constraint_name ?? String(e));
      const noReason = await decideSubmission(tx, ED, 'review', rv.id, 'reject', ' ').catch((e) => e);
      const list = await listAdminReviews(tx, { status: 'pending' });
      await decideSubmission(tx, ED, 'review', rv.id, 'accept', null);
      const row = await one<{ status: string; trustWeight: string }>(tx, sql`select "status", "trustWeight" from "review" where "id" = ${rv.id}`);
      const pts = await one<{ n: number }>(tx, sql`select count(*)::int as "n" from "points_event" where "dedupeKey" = ${`review_published:${rv.id}`}`);
      const noBinding = await tx.transaction((t2) => createReview(t2, 'u_412', { brandId: 'br_jinlong', rating: 3 })).catch((e) => e);
      return { rv, dup, noReason, item: list.find((x) => x.id === rv.id), row, pts, noBinding };
    });
    expect(r.rv.status).toBe('pending');
    expect(r.dup).toBe('review_user_brand_active_uq');
    expect(r.noReason).toBeInstanceOf(SubmissionStateError);
    expect(r.item).toMatchObject({ text: '出款稳定', trustWeight: 1, verifiedBinding: true });
    expect(r.row).toEqual({ status: 'published', trustWeight: '1.00' });
    expect(r.pts.n).toBe(1);
    expect(r.noBinding).toBeInstanceOf(SubmissionInputError);
  });
});

describe.skipIf(!url)('D-024 隐私：导出与「删除证据原文」覆盖凭证截图', () => {
  it('导出含本人凭证 / 截图哈希 / 评价；删除原文请求在凭证判定后删除截图对象（哈希保留）', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "app_user" ("id", "displayName") values ('u_adm_t', 'adm') on conflict do nothing`);
      await asApp(tx);
      const wr = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 80, method: 'x', requestedAt: ago(2), receivedAt: ago(1), outcome: 'paid' });
      const ev = await addWithdrawalEvidence(tx, store, 'u_233', wr.id, PNG);
      const mine = await listMySubmissions(tx, 'u_233');
      const exp = await buildExport(tx, 'u_233');
      const pendingDel = await createDataRequest(tx, 'u_233', { kind: 'delete_evidence', evidenceIds: [ev.id] }, { authTime: null });
      const blocked = await resolveDataRequest(tx, store, ADMIN, pendingDel.id, 'done', null).catch((e: Error) => e.message);
      await decideSubmission(tx, ARB, 'withdrawal', wr.id, 'accept', null);
      await resolveDataRequest(tx, store, ADMIN, pendingDel.id, 'done', null);
      const se = await one<{ deleted: boolean; key: string | null; sha256: string }>(tx, sql`select "deletedAt" is not null as "deleted", "storageKey" as "key", "sha256" from "submission_evidence" where "id" = ${ev.id}`);
      return { wr, ev, mine, exp, blocked, se };
    });
    expect(r.mine.withdrawals.find((w) => w.id === r.wr.id)).toMatchObject({ status: 'pending', evidenceCount: 1 });
    expect((r.exp.withdrawalReports as { id: string }[]).some((w) => w.id === r.wr.id)).toBe(true);
    expect((r.exp.submissionEvidence as { sha256: string }[]).some((e) => e.sha256 === r.ev.sha256)).toBe(true);
    expect(r.blocked).toMatch(/未结案/);
    expect(r.se).toEqual({ deleted: true, key: null, sha256: r.ev.sha256 });
    expect(store.m.size).toBe(0);
  });
});

describe.skipIf(!url)('D-024 收尾（W2#005）', () => {
  it('收尾 1：对账覆盖截图——submission_evidence_delete_original 的原文与预览缓存仍在则重删', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await tx.execute(
        sql`insert into "audit_log" ("actorId", "actorRole", "action", "targetType", "targetId", "before")
            values ('u_adm_t', 'admin', 'submission_evidence_delete_original', 'submission_evidence', 'se_rec_t', ${JSON.stringify({ storageKey: 'submission/wr_x/se_rec_t' })}::jsonb)`,
      );
      await store.put('submission/wr_x/se_rec_t', PNG, 'image/png');
      await store.put(previewKey('se_rec_t', 1), PNG, 'image/png');
      return reconcileDeletedObjects(tx, store);
    });
    expect(r.redeleted).toBe(2);
    expect(store.m.size).toBe(0);
  });

  it('收尾 2：一次提交中第 2 张截图非法 → 整笔回滚，第 1 张已写入的对象被删除', async () => {
    const store = memStore();
    const err = await inTx(async (tx) => {
      await asApp(tx);
      return submitWithdrawalWithEvidence(
        tx,
        store,
        'u_233',
        { brandId: 'br_winner', amountUsdt: 10, method: 'x', requestedAt: ago(1), outcome: 'refused' },
        [PNG, new TextEncoder().encode('not an image')],
      ).catch((e: Error) => e.message);
    });
    expect(err).toMatch(/只接受图片/);
    expect(store.m.size).toBe(0);
  });

  it('收尾 3：不能审核本人的提交（凭证与评价）', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const wr = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 10, method: 'x', requestedAt: ago(1), outcome: 'refused' });
      await addWithdrawalEvidence(tx, store, 'u_233', wr.id, PNG);
      const self = { id: 'u_233', role: 'arbitrator' as const, ip: null };
      const w = await decideSubmission(tx, self, 'withdrawal', wr.id, 'accept', null).catch((e: Error) => e.message);
      const rv = await createReview(tx, 'u_412', { brandId: 'br_crown', rating: 4 });
      const v = await decideSubmission(tx, { id: 'u_412', role: 'editor', ip: null }, 'review', rv.id, 'accept', null).catch((e: Error) => e.message);
      return { w, v };
    });
    expect(r).toEqual({ w: '不能审核本人的提交', v: '不能审核本人的提交' });
  });

  it('W2#011 UAT 清理：只驳回指定用户的待审凭证 / 评价（原因、执行身份、audit）；其他用户与已判定的不动', async () => {
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const mine = await createWithdrawalReport(tx, 'u_233', { brandId: 'br_winner', amountUsdt: 10, method: 'x', requestedAt: ago(1), outcome: 'refused' });
      const other = await createReview(tx, 'u_412', { brandId: 'br_crown', rating: 4 });
      const SYS = { id: 'system:uat-cleanup', role: 'admin' as const, ip: null };
      const done = await rejectPendingSubmissionsOf(tx, ['u_233'], SYS, 'UAT 自动清理');
      const [w] = (await tx.execute(sql`select "status", "rejectReason", "decidedBy" from "withdrawal_report" where "id" = ${mine.id}`)) as unknown as Record<string, string>[];
      const [v] = (await tx.execute(sql`select "status" from "review" where "id" = ${other.id}`)) as unknown as Record<string, string>[];
      const [a] = (await tx.execute(sql`select "actorId" from "audit_log" where "targetId" = ${mine.id} and "action" = 'withdrawal_report_rejected'`)) as unknown as Record<string, string>[];
      const again = await rejectPendingSubmissionsOf(tx, ['u_233'], SYS, 'UAT 自动清理');
      return { done, w, v: v!.status, a: a!.actorId, again };
    });
    expect(r.done.withdrawal).toBeGreaterThanOrEqual(1);
    expect(r.done.failed).toBe(0);
    expect(r.w).toEqual({ status: 'rejected', rejectReason: 'UAT 自动清理', decidedBy: 'system:uat-cleanup' });
    expect(r.v).toBe('pending');
    expect(r.a).toBe('system:uat-cleanup');
    expect(r.again).toEqual({ withdrawal: 0, review: 0, failed: 0 });
  });

  it('W3#090 UAT 清理：只驳回指定用户待处理的数据请求（原因、执行身份、audit），其他用户不动；再跑一次为 0', async () => {
    const store = memStore();
    const r = await inTx(async (tx) => {
      await asApp(tx);
      const mine = await createDataRequest(tx, 'u_233', { kind: 'export' }, { authTime: null });
      const other = await createDataRequest(tx, 'u_412', { kind: 'export' }, { authTime: null });
      const SYS = { id: 'system:uat-cleanup', role: 'admin' as const, ip: null };
      const done = await rejectPendingDataRequestsOf(tx, store, ['u_233'], SYS, 'UAT 自动清理');
      const st = async (id: string) => ((await tx.execute(sql`select "status" from "data_request" where "id" = ${id}`)) as unknown as { status: string }[])[0]!.status;
      const [a] = (await tx.execute(sql`select "actorId" from "audit_log" where "targetId" = ${mine.id} order by "id" desc limit 1`)) as unknown as { actorId: string }[];
      const again = await rejectPendingDataRequestsOf(tx, store, ['u_233'], SYS, 'UAT 自动清理');
      return { done, mine: await st(mine.id), other: await st(other.id), a: a?.actorId, again };
    });
    expect(r.done.failed).toBe(0);
    expect(r.done.rejected).toBeGreaterThanOrEqual(1);
    expect(r.mine).toBe('rejected');
    expect(r.other).toBe('pending');
    expect(r.a).toBe('system:uat-cleanup');
    expect(r.again).toEqual({ rejected: 0, failed: 0 });
    expect(store.m.size).toBe(0);
  });
});
