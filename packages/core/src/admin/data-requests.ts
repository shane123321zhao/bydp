/**
 * 隐私数据请求处理（admin 契约 v0.2 · §9.2 v1.9 / v1.10）。所有写操作同事务写 audit_log；对象存储删除在事务提交后进行。
 * - 脱敏：admin 上传每份证据的脱敏版本替换原文（evidence.redacted = true，原 sha256 不变，另存 redactedSha256）；旧原文对象与预览缓存删除。
 * - 删除原文：**未结案案件只能脱敏、不能删原文**；结案后置 deletedAt + 清空 storageKey（哈希与状态日志保留），对象与预览缓存删除。
 * - 导出：done 时生成本人数据 JSON 包（不含他人数据），存证据桶私有前缀 exports/<userId>/<requestId>.json；本人经公开接口取 7 天预签名链接。
 * - 注销：须先经登记联系方式确认（/contact-confirmed）；done 在同事务内调用 owner 级 bydp_anonymize_user（迁移 0012 / §9.2 v1.10）。
 *   前提：有未结案案件 → 409 open_complaints（DB 函数同样兜底）；排除期内可注销（0013 identity_block 拦截重新注册，A-015 过渡拦截已解除）。
 *   已结案案件：函数删除证据原文（哈希保留）并覆盖原文 / 未公开标题；core 为每份证据写 evidence_delete_original audit 并在提交后删对象。
 *   身份与通知已被清除，注销结果不发站内通知；audit 只记 request_id 与计数，不含被清除内容。
 * 结果（done / rejected）站内通知申请人（注销 done 除外）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';
import { sniffEvidenceType } from '../complaint/evidence-type';
import type { ComplaintStatus } from '../complaint/state';
import { ComplaintInputError, type EvidenceStore } from '../complaint/write';
import { listIdentitiesForExport } from '../identity/auth';
import { listBindingsForUser } from '../identity/bindings';
import { DATA_REQUEST_TEXT, type DataRequestKind } from '../identity/privacy';
import { ConflictOfInterestError } from './complaints';
import { deleteObjectOrAlert, purgePreviewCache } from './evidence';
import { ROLE_LOCK, writeAudit, type Actor } from './rbac';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

/** 结案态（删除原文的前提，§9.2 v1.9） */
const CLOSED: ComplaintStatus[] = ['resolved', 'rejected', 'exposed'];
export const EXPORT_LINK_TTL_SEC = 7 * 86400;
export const exportKey = (userId: string, requestId: string) => `exports/${userId}/${requestId}.json`;

/** 注销执行被前提拦下（409，code = open_complaints；self_excluded 自 0013 起不再出现，保留类型兼容契约枚举） */
export class AnonymizeBlockedError extends Error {
  constructor(
    public readonly code: 'self_excluded' | 'open_complaints',
    message: string,
  ) {
    super(message);
    this.name = 'AnonymizeBlockedError';
  }
}

export class DataRequestStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataRequestStateError';
  }
}

type Req = { id: string; userId: string; kind: DataRequestKind; status: 'pending' | 'done' | 'rejected'; targetIds: string[]; note: string | null; contactConfirmedAt: Date | null; contactChannel: string | null; createdAt: Date; resolvedAt: Date | null };
type Target = { evidenceId: string; complaintId: string; complaintClosed: boolean; redacted: boolean; originalAvailable: boolean };

async function targetsOf(db: Exec, ids: string[]): Promise<Target[]> {
  if (!ids.length) return [];
  const rows = await q<{ id: string; complaintId: string; status: ComplaintStatus; redacted: boolean; available: boolean }>(
    db,
    sql`select e."id", e."complaintId", c."status", e."redacted", e."storageKey" is not null and e."deletedAt" is null as "available"
        from ${schema.evidence} e join ${schema.complaints} c on c."id" = e."complaintId"
        where e."id" in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) order by e."id"`,
  );
  // D-024：出款凭证截图（se_）——「案件」位置给凭证 id，已判定（accepted / rejected）视同已结案
  const se = await q<{ id: string; reportId: string; status: string; redacted: boolean; available: boolean }>(
    db,
    sql`select se."id", se."withdrawalReportId" as "reportId", w."status", se."redacted", se."storageKey" is not null and se."deletedAt" is null as "available"
        from ${schema.submissionEvidence} se join ${schema.withdrawalReports} w on w."id" = se."withdrawalReportId"
        where se."id" in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) order by se."id"`,
  );
  return [
    ...rows.map((r) => ({ evidenceId: r.id, complaintId: r.complaintId, complaintClosed: CLOSED.includes(r.status), redacted: r.redacted, originalAvailable: r.available })),
    ...se.map((r) => ({ evidenceId: r.id, complaintId: r.reportId, complaintClosed: r.status !== 'pending', redacted: r.redacted, originalAvailable: r.available })),
  ];
}

const view = async (db: Exec, r: Req) => ({
  id: r.id,
  userId: r.userId,
  kind: r.kind,
  status: r.status,
  targets: await targetsOf(db, r.targetIds ?? []),
  note: r.note,
  contactConfirmedAt: iso(r.contactConfirmedAt),
  contactChannel: r.contactChannel,
  createdAt: iso(r.createdAt)!,
  resolvedAt: iso(r.resolvedAt),
});
export type AdminDataRequest = Awaited<ReturnType<typeof view>>;

const REQ_COLS = sql`"id", "userId", "kind", "status", "targetIds", "note", "contactConfirmedAt", "contactChannel", "createdAt", "resolvedAt"`;

export async function listAdminDataRequests(db: Exec, p: { status?: 'pending' | 'done' | 'rejected'; cursor?: string | null }): Promise<{ items: AdminDataRequest[]; next: string | null }> {
  const limit = 50;
  const [cAt, cId] = p.cursor ? p.cursor.split('|') : [];
  const rows = await q<Req>(
    db,
    sql`select ${REQ_COLS} from ${schema.dataRequests}
        where "status" = ${p.status ?? 'pending'}
          and (${cAt ?? null}::timestamptz is null or ("createdAt", "id") > (${cAt ?? null}::timestamptz, ${cId ?? ''}))
        order by "createdAt", "id" limit ${limit + 1}`,
  );
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map((r) => view(db, r)));
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null };
}

export async function getAdminDataRequest(db: Exec, id: string): Promise<AdminDataRequest | null> {
  const [r] = await q<Req>(db, sql`select ${REQ_COLS} from ${schema.dataRequests} where "id" = ${id}`);
  return r ? view(db, r) : null;
}

async function lockPending(tx: Exec, id: string): Promise<Req> {
  const [r] = await q<Req>(tx, sql`select ${REQ_COLS} from ${schema.dataRequests} where "id" = ${id} for update`);
  if (!r) throw new ComplaintInputError('数据请求不存在');
  if (r.status !== 'pending') throw new DataRequestStateError('该请求已处理');
  return r;
}

/** 注销执行前经登记联系方式向本人确认一次（只对 anonymize；时刻由 DB 守卫置服务端时间） */
export async function confirmContact(db: Tx, actor: Actor, id: string, channel: 'telegram' | 'email'): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await lockPending(tx, id);
    if (r.kind !== 'anonymize') throw new ComplaintInputError('只有注销请求需要联系确认');
    if (r.contactChannel) throw new DataRequestStateError('已确认过联系方式');
    await tx.execute(sql`update ${schema.dataRequests} set "contactChannel" = ${channel} where "id" = ${id}`);
    await writeAudit(tx, actor, 'data_request_contact_confirmed', { type: 'data_request', id }, null, { channel });
  });
}

/** 脱敏替换一份证据（kind = redact_evidence，证据须在本请求范围内、原文仍在、未脱敏） */
export async function redactEvidenceForRequest(db: Tx, store: EvidenceStore, actor: Actor, id: string, evidenceId: string, content: Uint8Array): Promise<void> {
  const mime = sniffEvidenceType(content);
  if (!mime) throw new ComplaintInputError('脱敏件只接受图片 / PDF / 纯文本');
  if (content.byteLength === 0 || content.byteLength > 20 * 1024 * 1024) throw new ComplaintInputError('脱敏件须为 1 字节至 20MB');
  const oldKey = await db.transaction(async (tx) => {
    const r = await lockPending(tx, id);
    if (r.kind !== 'redact_evidence') throw new ComplaintInputError('该请求不是脱敏请求');
    if (!(r.targetIds ?? []).includes(evidenceId)) throw new ComplaintInputError('证据不在本请求范围内');
    const [e] = await q<{ storageKey: string | null; redacted: boolean; deleted: boolean }>(
      tx,
      sql`select "storageKey", "redacted", "deletedAt" is not null as "deleted" from ${schema.evidence} where "id" = ${evidenceId} for update`,
    );
    if (!e || !e.storageKey || e.deleted) throw new ComplaintInputError('原文已删除，无需脱敏');
    if (e.redacted) throw new ComplaintInputError('该证据已脱敏');
    const newKey = `${e.storageKey}.redacted`;
    const sha = createHash('sha256').update(content).digest('hex');
    await store.put(newKey, content, mime);
    await tx.execute(
      sql`update ${schema.evidence} set "redacted" = true, "redactedAt" = now(), "storageKey" = ${newKey}, "redactedSha256" = ${sha} where "id" = ${evidenceId}`,
    );
    await writeAudit(tx, actor, 'evidence_redact', { type: 'evidence', id: evidenceId }, { storageKey: e.storageKey }, { requestId: id, redactedSha256: sha });
    return e.storageKey;
  });
  await deleteObjectOrAlert(store, oldKey, { evidenceId, via: 'redact' });
  await purgePreviewCache(store, evidenceId);
}

async function notifyResult(tx: Exec, r: Req, result: 'done' | 'rejected', note: string | null): Promise<string> {
  const nid = `nt_${randomUUID().replaceAll('-', '')}`;
  const title = result === 'done' ? `数据请求已完成：${DATA_REQUEST_TEXT[r.kind]}` : `数据请求未通过：${DATA_REQUEST_TEXT[r.kind]}`;
  const body =
    result === 'done'
      ? r.kind === 'export'
        ? `请求编号 ${r.id}。导出包已生成，可在「隐私与数据」下载（链接 7 天有效）。`
        : `请求编号 ${r.id}。已按你的申请处理；证据哈希与状态日志按规则保留。`
      : `请求编号 ${r.id}。${note ? `原因：${note}` : ''}`;
  await tx.execute(sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body") values (${nid}, ${r.userId}, 'data_request', ${title}, ${body})`);
  return nid;
}

/** 导出包（本人数据，不含他人数据；账号只给掩码；不含证据原文，只给哈希） */
export async function buildExport(db: Exec, userId: string): Promise<Record<string, unknown>> {
  const one = async (s: ReturnType<typeof sql>) => (await q<Record<string, unknown>>(db, s))[0] ?? null;
  const all = (s: ReturnType<typeof sql>) => q<Record<string, unknown>>(db, s);
  return {
    format: 'bydp-export-v1',
    generatedAt: new Date().toISOString(),
    user: await one(sql`select "id", "displayName", "joinedAt"::text, "region", "locale", "level", "points" from ${schema.users} where "id" = ${userId}`),
    identities: await listIdentitiesForExport(db, userId),
    bindings: await listBindingsForUser(db, userId),
    complaints: await all(
      sql`select "id", "brandId", "title", "category", "status", "amountUsdt", "eventDate"::text, "description", "createdAt", "resolvedAt", "exposedAt"
          from ${schema.complaints} where "userId" = ${userId} order by "createdAt"`,
    ),
    evidence: await all(
      sql`select e."id", e."complaintId", e."type", e."sha256", e."redacted", e."uploadedAt", e."deletedAt"
          from ${schema.evidence} e join ${schema.complaints} c on c."id" = e."complaintId" where c."userId" = ${userId} order by e."uploadedAt"`,
    ),
    // D-024：本人出款凭证与评价（截图只给哈希，不含原文）
    withdrawalReports: await all(
      sql`select "id", "brandId", "amountUsdt", "method", "requestedAt", "receivedAt", "outcome", "status", "rejectReason", "decidedAt", "outcomeAmendedAt", "createdAt"
          from ${schema.withdrawalReports} where "userId" = ${userId} order by "createdAt"`,
    ),
    submissionEvidence: await all(
      sql`select se."id", se."withdrawalReportId", se."sha256", se."mime", se."bytes", se."uploadedAt", se."deletedAt"
          from ${schema.submissionEvidence} se join ${schema.withdrawalReports} w on w."id" = se."withdrawalReportId" where w."userId" = ${userId} order by se."uploadedAt"`,
    ),
    reviews: await all(sql`select "id", "brandId", "rating", "text", "status", "rejectReason", "createdAt" from ${schema.reviews} where "userId" = ${userId} order by "createdAt"`),
    clicks: await all(sql`select "id", "brandId", "offerId", "createdAt" from ${schema.clicks} where "userId" = ${userId} order by "createdAt"`),
    subscriptions: await all(sql`select "targetType", "targetId", "channel", "createdAt" from ${schema.subscriptions} where "userId" = ${userId}`),
    notifications: await all(sql`select "type", "title", "body", "sentAt" from ${schema.notifications} where "userId" = ${userId} order by "sentAt"`),
    pointsEvents: await all(sql`select "event", "points", "refType", "refId", "createdAt" from ${schema.pointsEvents} where "userId" = ${userId} order by "createdAt"`),
    selfExclusions: await all(sql`select "period", "startsAt", "endsAt" from ${schema.selfExclusions} where "userId" = ${userId} order by "startsAt"`),
    preferences: await one(sql`select "dailyDepositAlertUsdt", "sessionAlertMinutes", "nightAlert" from ${schema.userPreferences} where "userId" = ${userId}`),
    dataRequests: await all(sql`select "id", "kind", "status", "createdAt", "resolvedAt" from ${schema.dataRequests} where "userId" = ${userId} order by "createdAt"`),
  };
}

/** 结案（契约 /resolve）。返回新通知 id 供入队 */
export async function resolveDataRequest(
  db: Tx,
  store: EvidenceStore,
  actor: Actor,
  id: string,
  result: 'done' | 'rejected',
  note: string | null,
): Promise<{ notificationIds: string[] }> {
  const cleanup: { keys: { key: string; evidenceId: string; via: string }[]; evidenceIds: string[]; exports: string[] } = { keys: [], evidenceIds: [], exports: [] };
  const out = await db.transaction(async (tx) => {
    const r = await lockPending(tx, id);
    const targets = await targetsOf(tx, r.targetIds ?? []);
    if (result === 'done') {
      if (r.kind === 'redact_evidence' && targets.some((t) => !t.redacted && t.originalAvailable)) throw new ComplaintInputError('仍有证据未上传脱敏件');
      if (r.kind === 'delete_evidence') {
        if (targets.some((t) => !t.complaintClosed && t.originalAvailable)) throw new ComplaintInputError('未结案案件的证据只能脱敏、不能删除原文（§9.2 v1.9）');
        for (const t of targets.filter((x) => x.originalAvailable)) {
          // D-024：se_ 为出款凭证截图（submission_evidence），其余为投诉证据
          const table = t.evidenceId.startsWith('se_') ? schema.submissionEvidence : schema.evidence;
          const [e] = await q<{ storageKey: string }>(tx, sql`select "storageKey" from ${table} where "id" = ${t.evidenceId} for update`);
          await tx.execute(sql`update ${table} set "deletedAt" = now(), "storageKey" = null where "id" = ${t.evidenceId}`);
          await writeAudit(
            tx,
            actor,
            t.evidenceId.startsWith('se_') ? 'submission_evidence_delete_original' : 'evidence_delete_original',
            { type: t.evidenceId.startsWith('se_') ? 'submission_evidence' : 'evidence', id: t.evidenceId },
            { storageKey: e!.storageKey },
            { requestId: id },
          );
          cleanup.keys.push({ key: e!.storageKey, evidenceId: t.evidenceId, via: 'delete_original' });
          cleanup.evidenceIds.push(t.evidenceId);
        }
      }
      if (r.kind === 'export') {
        if (!store.put) throw new Error('证据存储未配置');
        const pkg = new TextEncoder().encode(JSON.stringify(await buildExport(tx, r.userId), null, 1));
        await store.put(exportKey(r.userId, r.id), pkg, 'application/json');
      }
      if (r.kind === 'anonymize') {
        if (!r.contactChannel) throw new ComplaintInputError('注销须先经登记联系方式确认');
        // 回避：不得执行本人的注销；角色清除与角色变更同一把锁串行，且不能清掉系统中最后一个管理员（与 setUserRoles 同口径）
        if (r.userId === actor.id) throw new ConflictOfInterestError('不得执行本人的注销请求（回避）');
        // 锁序与 setUserRoles / grant-role 一致：先角色锁，再锁申请人行（user_role 外键会对 app_user 行取 KEY SHARE，反序会死锁）；
        // 两把锁都拿到后才做各项检查——新建投诉 / 排除 / 请求 / 绑定的触发器对同一行加共享锁，检查与执行之间不会穿插写入（0013）
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ROLE_LOCK}))`);
        await tx.execute(sql`select 1 from ${schema.users} where "id" = ${r.userId} for update`);
        const [lastAdmin] = await q<{ last: boolean }>(
          tx,
          sql`select exists (select 1 from ${schema.userRoles} where "userId" = ${r.userId} and "roleKey" = 'admin')
                 and not exists (select 1 from ${schema.userRoles} where "roleKey" = 'admin' and "userId" <> ${r.userId}) as "last"`,
        );
        if (lastAdmin?.last) throw new ComplaintInputError('申请人是系统中最后一个管理员，须先把管理员角色交给他人再执行注销');
        // 自我排除期内可以注销（0013 起解除 A-015 过渡拦截）：函数把身份哈希写入 identity_block，同一身份重新注册被拦到排除期满（permanent 永久）
        const [open] = await q<{ n: number }>(
          tx,
          sql`select count(*)::int as "n" from ${schema.complaints} where "userId" = ${r.userId} and "status" not in (${sql.join(CLOSED.map((c) => sql`${c}`), sql`, `)})`,
        );
        if (open && open.n > 0) throw new AnonymizeBlockedError('open_complaints', `本人有 ${open.n} 件未结案投诉，须先结案或撤诉再执行注销`);
        // 其他待处理的数据请求须先处理完（否则之后结案会给已注销用户重新写通知 / 生成导出包）
        const [other] = await q<{ n: number }>(
          tx,
          sql`select count(*)::int as "n" from ${schema.dataRequests} where "userId" = ${r.userId} and "status" = 'pending' and "id" <> ${id}`,
        );
        if (other && other.n > 0) throw new ComplaintInputError('申请人还有其他待处理的数据请求，请先处理完再执行注销');
        // 已生成的导出包含本人身份与通知内容：事务提交后一并删除
        const exps = await q<{ id: string }>(tx, sql`select "id" from ${schema.dataRequests} where "userId" = ${r.userId} and "kind" = 'export' and "status" = 'done'`);
        cleanup.exports = exps.map((x) => exportKey(r.userId, x.id));
        const [res] = await q<{
          result: Record<string, number> & { evidenceKeys: { evidenceId: string; storageKey: string }[]; submissionEvidenceKeys?: { submissionEvidenceId: string; storageKey: string }[] };
        }>(tx, sql`select bydp_anonymize_user(${r.userId}, ${id}) as "result"`);
        const { evidenceKeys, submissionEvidenceKeys = [], ...counts } = res!.result;
        // A-019：出款凭证截图原文同样由函数置删除，提交后删对象与预览缓存
        for (const k of submissionEvidenceKeys) {
          await writeAudit(tx, actor, 'submission_evidence_delete_original', { type: 'submission_evidence', id: k.submissionEvidenceId }, { storageKey: k.storageKey }, { requestId: id, via: 'anonymize' });
          cleanup.keys.push({ key: k.storageKey, evidenceId: k.submissionEvidenceId, via: 'anonymize' });
          cleanup.evidenceIds.push(k.submissionEvidenceId);
        }
        // 已结案案件的证据原文由函数置删除：逐条写 evidence_delete_original（对账任务据此兜底），提交后删对象与预览缓存
        for (const k of evidenceKeys) {
          await writeAudit(tx, actor, 'evidence_delete_original', { type: 'evidence', id: k.evidenceId }, { storageKey: k.storageKey }, { requestId: id, via: 'anonymize' });
          cleanup.keys.push({ key: k.storageKey, evidenceId: k.evidenceId, via: 'anonymize' });
          cleanup.evidenceIds.push(k.evidenceId);
        }
        await tx.execute(sql`update ${schema.dataRequests} set "status" = 'done' where "id" = ${id}`);
        await writeAudit(tx, actor, 'data_request_resolve', { type: 'data_request', id }, { status: 'pending' }, { status: 'done', kind: r.kind, counts });
        return { notificationIds: [] };
      }
    }
    await tx.execute(sql`update ${schema.dataRequests} set "status" = ${result} where "id" = ${id}`);
    const nid = await notifyResult(tx, r, result, note?.trim() || null);
    await writeAudit(tx, actor, 'data_request_resolve', { type: 'data_request', id }, { status: 'pending' }, { status: result, kind: r.kind, note: note?.trim() || null });
    return { notificationIds: [nid] };
  });
  for (const k of cleanup.keys) await deleteObjectOrAlert(store, k.key, { requestId: id, evidenceId: k.evidenceId, via: k.via });
  for (const k of cleanup.exports) await deleteObjectOrAlert(store, k, { requestId: id, via: 'anonymize_export' });
  for (const e of cleanup.evidenceIds) await purgePreviewCache(store, e);
  return out;
}

/** 公开接口 GET /me/data-requests/{id}/download：本人、导出类、已完成 → 7 天预签名链接 */
export async function getExportDownload(db: Exec, store: EvidenceStore, userId: string, id: string): Promise<{ url: string; expiresAt: string } | null> {
  const [r] = await q<{ kind: string; status: string }>(db, sql`select "kind", "status" from ${schema.dataRequests} where "id" = ${id} and "userId" = ${userId}`);
  if (!r || r.kind !== 'export' || r.status !== 'done') return null;
  const key = exportKey(userId, id);
  if (!store.presign || (store.exists && !(await store.exists(key)))) return null;
  return { url: store.presign(key, EXPORT_LINK_TTL_SEC), expiresAt: new Date(Date.now() + EXPORT_LINK_TTL_SEC * 1000).toISOString() };
}

/**
 * UAT 收尾清理（W2#011 同口径扩展，W3#090）：把指定用户仍待处理的数据请求逐条「驳回」（走 resolveDataRequest 正常路径：audit_log + 通知申请人），
 * 避免后台「数据请求」列表（每页 50 条、按申请先后）随每轮 UAT 累积，挤掉本轮请求。驳回不动任何证据对象（store 仅为签名需要）。
 */
export async function rejectPendingDataRequestsOf(db: Tx, store: EvidenceStore, userIds: string[], actor: Actor, reason: string) {
  const done = { rejected: 0, failed: 0 };
  if (!userIds.length) return done;
  const ids = await q<{ id: string }>(
    db,
    sql`select "id" from ${schema.dataRequests} where "status" = 'pending' and "userId" in (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)}) order by "createdAt"`,
  );
  for (const r of ids)
    try {
      await resolveDataRequest(db, store, actor, r.id, 'rejected', reason);
      done.rejected++;
    } catch {
      done.failed++;
    }
  return done;
}
