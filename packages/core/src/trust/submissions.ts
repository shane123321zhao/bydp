/**
 * D-024 用户提交：出款凭证（withdrawal_report kind = user）与评价（review）。迁移 0016（A-019）的触发器是最后一道防线：
 * 强制待审、本人绑定、绑定早于申请、同绑定 30 天 ≤ 3 份、时间不得在未来、trustWeight 由库写入；此处做输入校验与友好报错，
 * 数据库命名约束由 api / web 层统一映射（apps/api/src/submission-errors.ts）。
 * - 自我排除期：两类提交都允许（非商业动作，与投诉一致）；黑名单品牌：允许提交，评分端照旧不计分。
 * - 凭证须附截图（裁定 ②）：截图只能挂在仍待审的本人凭证上；只收图片 / PDF（按文件头判定），计入投诉证据同一日配额。
 * - 判定后补录出款结果（W2#002 小改 3）：允许（方案已批），但写 audit_log 并给仲裁组发站内提醒。
 */
import { createHash, randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';
import { z } from 'zod';
import { assertEvidenceQuota, countEvidence } from '../abuse/limits';
import type { RateCounter } from '../identity/auth';
import type { EvidenceStore } from '../complaint/write';
import { sniffEvidenceType } from '../complaint/evidence-type';
import { activeBindingForSubmission } from '../identity/bindings';
import { deleteObjectOrAlert } from '../admin/evidence';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
type TxDb = Pick<Db, 'transaction'>;
const q = async <T>(db: Exec, s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];

export class SubmissionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionInputError';
  }
}

export const WithdrawalReportCreate = z.object({
  brandId: z.string().min(1).max(64),
  amountUsdt: z.coerce.number().positive().max(10_000_000),
  method: z.string().trim().min(1).max(40),
  requestedAt: z.coerce.date(),
  receivedAt: z.coerce.date().nullish(),
  outcome: z.enum(['paid', 'refused', 'pending']),
});
export const WithdrawalOutcomeAmend = z.object({ outcome: z.enum(['paid', 'refused']), receivedAt: z.coerce.date().nullish() });
export const ReviewCreate = z.object({ brandId: z.string().min(1).max(64), rating: z.coerce.number().int().min(1).max(5), text: z.string().trim().max(500).nullish() });

export async function createWithdrawalReport(db: Exec, userId: string, raw: z.input<typeof WithdrawalReportCreate>): Promise<{ id: string; status: 'pending' }> {
  const p = WithdrawalReportCreate.parse(raw);
  if (p.outcome === 'paid' && !p.receivedAt) throw new SubmissionInputError('已到账须填写到账时间');
  if (p.outcome !== 'paid' && p.receivedAt) throw new SubmissionInputError('未到账 / 被拒付时不填到账时间');
  const bindingId = await activeBindingForSubmission(db, userId, p.brandId, p.requestedAt);
  if (!bindingId) throw new SubmissionInputError('须先绑定该平台的账号，且绑定时间早于申请提款时间');
  const id = `wr_${randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql`insert into ${schema.withdrawalReports} ("id", "brandId", "kind", "amountUsdt", "method", "requestedAt", "receivedAt", "outcome", "bindingId", "userId")
        values (${id}, ${p.brandId}, 'user', ${p.amountUsdt}, ${p.method}, ${p.requestedAt.toISOString()}, ${p.receivedAt?.toISOString() ?? null}, ${p.outcome}, ${bindingId}, ${userId})`,
  );
  return { id, status: 'pending' };
}

/** 凭证截图：服务端 SHA-256（原文字节），原文存对象存储 submission/<凭证>/<id>，哈希入只追加表 */
export async function addWithdrawalEvidence(
  db: Exec,
  store: EvidenceStore,
  userId: string,
  reportId: string,
  content: Uint8Array,
  opts: { counter?: RateCounter } = {},
): Promise<{ id: string; sha256: string }> {
  const [r] = await q<{ userId: string | null; status: string }>(db, sql`select "userId", "status" from ${schema.withdrawalReports} where "id" = ${reportId}`);
  if (!r || r.userId !== userId) throw new SubmissionInputError('凭证不存在或不属于本人');
  if (r.status !== 'pending') throw new SubmissionInputError('凭证已审核，不能再补充截图');
  if (!content.byteLength) throw new SubmissionInputError('截图为空');
  if (content.byteLength > 20 * 1024 * 1024) throw new SubmissionInputError('单张截图不超过 20MB');
  const mime = sniffEvidenceType(content);
  if (!mime || mime === 'text/plain') throw new SubmissionInputError('截图只接受图片（PNG / JPEG / GIF / WebP）或 PDF');
  if (opts.counter) await assertEvidenceQuota(opts.counter, userId, content.byteLength);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const id = `se_${randomUUID().replaceAll('-', '')}`;
  const storageKey = `submission/${reportId}/${id}`;
  await store.put(storageKey, content, mime);
  await db.execute(
    sql`insert into ${schema.submissionEvidence} ("id", "withdrawalReportId", "sha256", "mime", "bytes", "storageKey")
        values (${id}, ${reportId}, ${sha256}, ${mime}, ${content.byteLength}, ${storageKey})`,
  );
  if (opts.counter) await countEvidence(opts.counter, userId, content.byteLength);
  return { id, sha256 };
}

/**
 * 网页「提交出款凭证」一次提交：凭证 + 1–n 张截图在同一事务内写入；任一步失败整笔回滚。
 * W2#005 收尾 2：截图对象在事务内已写入对象存储，回滚后库里没有记录、对账也找不到 → 记录本次已写入的 key，失败时逐个删除（失败写告警）。
 */
export async function submitWithdrawalWithEvidence(
  db: TxDb,
  store: EvidenceStore,
  userId: string,
  raw: z.input<typeof WithdrawalReportCreate>,
  contents: Uint8Array[],
  opts: { counter?: RateCounter } = {},
): Promise<{ id: string; files: number }> {
  if (!contents.length) throw new SubmissionInputError('请至少上传 1 张出款截图（没有截图的凭证不能采纳）');
  const written: string[] = [];
  const tracked: EvidenceStore = {
    ...store,
    put: async (key, content, type) => {
      await store.put(key, content, type);
      written.push(key);
    },
  };
  try {
    const id = await db.transaction(async (tx) => {
      const r = await createWithdrawalReport(tx, userId, raw);
      for (const c of contents) await addWithdrawalEvidence(tx, tracked, userId, r.id, c, opts);
      return r.id;
    });
    return { id, files: contents.length };
  } catch (e) {
    for (const key of written) await deleteObjectOrAlert(store, key, { userId, via: 'submission_rollback' });
    throw e;
  }
}

/**
 * 补录出款结果（只能由 pending 补一次，库触发器兜底）。若凭证已判定（判定后补录），写 audit 并给仲裁员 / 管理员各发一条站内提醒；
 * 返回新通知 id 供入队推送。
 */
export async function amendWithdrawalOutcome(db: Tx, userId: string, reportId: string, raw: z.input<typeof WithdrawalOutcomeAmend>): Promise<{ notificationIds: string[] }> {
  const p = WithdrawalOutcomeAmend.parse(raw);
  if (p.outcome === 'paid' && !p.receivedAt) throw new SubmissionInputError('已到账须填写到账时间');
  if (p.outcome === 'refused' && p.receivedAt) throw new SubmissionInputError('被拒付时不填到账时间');
  return db.transaction(async (tx) => {
    const [r] = await q<{ userId: string | null; status: string; outcome: string; brandId: string }>(
      tx,
      sql`select "userId", "status", "outcome", "brandId" from ${schema.withdrawalReports} where "id" = ${reportId} for update`,
    );
    if (!r || r.userId !== userId) throw new SubmissionInputError('凭证不存在或不属于本人');
    if (r.outcome !== 'pending') throw new SubmissionInputError('出款结果只能由「未到账」补录一次');
    await tx.execute(
      sql`update ${schema.withdrawalReports} set "outcome" = ${p.outcome}, "receivedAt" = ${p.receivedAt?.toISOString() ?? null} where "id" = ${reportId}`,
    );
    if (r.status === 'pending') return { notificationIds: [] };
    await tx.execute(
      sql`insert into ${schema.auditLogs} ("actorId", "actorRole", "action", "targetType", "targetId", "before", "after")
          values (${userId}, null, 'withdrawal_outcome_amended_after_decision', 'withdrawal_report', ${reportId},
                  ${JSON.stringify({ outcome: 'pending', status: r.status })}::jsonb, ${JSON.stringify({ outcome: p.outcome })}::jsonb)`,
    );
    const staff = await q<{ userId: string }>(tx, sql`select distinct "userId" from ${schema.userRoles} where "roleKey" in ('arbitrator', 'admin')`);
    const ids: string[] = [];
    for (const s of staff) {
      const id = `nt_${randomUUID().replaceAll('-', '')}`;
      await tx.execute(
        sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body")
            values (${id}, ${s.userId}, 'submission_amended', ${`出款凭证判定后补录：${reportId}`}, ${`凭证已${r.status === 'accepted' ? '采纳' : '驳回'}后，本人把出款结果补录为「${p.outcome === 'paid' ? '已到账' : '被拒付'}」，请在后台「提交审核」复看。`})`,
      );
      ids.push(id);
    }
    return { notificationIds: ids };
  });
}

export async function createReview(db: Exec, userId: string, raw: z.input<typeof ReviewCreate>): Promise<{ id: string; status: 'pending' }> {
  const p = ReviewCreate.parse(raw);
  const bindingId = await activeBindingForSubmission(db, userId, p.brandId);
  if (!bindingId) throw new SubmissionInputError('须先绑定该平台的账号才能评价');
  const id = `rv_${randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql`insert into ${schema.reviews} ("id", "brandId", "userId", "rating", "text", "bindingId")
        values (${id}, ${p.brandId}, ${userId}, ${p.rating}, ${p.text || null}, ${bindingId})`,
  );
  return { id, status: 'pending' };
}

/** 「我的」与导出用：本人提交列表（不含证据原文，只给哈希与数量） */
export async function listMySubmissions(db: Exec, userId: string) {
  const withdrawals = await q<Record<string, unknown>>(
    db,
    sql`select w."id", w."brandId", w."amountUsdt"::float as "amountUsdt", w."method", w."requestedAt", w."receivedAt", w."outcome", w."status", w."rejectReason", w."decidedAt", w."outcomeAmendedAt", w."createdAt",
               (select count(*)::int from ${schema.submissionEvidence} se where se."withdrawalReportId" = w."id" and se."deletedAt" is null) as "evidenceCount"
        from ${schema.withdrawalReports} w where w."userId" = ${userId} order by w."createdAt" desc`,
  );
  const reviews = await q<Record<string, unknown>>(
    db,
    sql`select "id", "brandId", "rating", "text", "trustWeight"::float as "trustWeight", "status", "rejectReason", "decidedAt", "createdAt"
        from ${schema.reviews} where "userId" = ${userId} order by "createdAt" desc`,
  );
  return { withdrawals, reviews };
}
