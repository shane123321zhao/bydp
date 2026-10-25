/**
 * 负责任博彩偏好 + 隐私数据请求（A-011 · §7 v1.8 · 契约 /me/preferences、/me/data-requests · design-system §16）。
 * - 偏好：限额提醒仅提醒不代扣；null = 关闭该项；无记录时全部关闭。
 * - 数据请求：M2 只做提交落库 + 站内确认通知；处理动作（脱敏 / 删原文 / 导出 / 匿名化执行）属 M3 后台，状态变更写 audit_log。
 *   证据类请求未指定证据时，取本人案件中「原文仍在」的全部证据（脱敏：未脱敏且未删除；删除：未删除）。
 *   同类请求仍在处理中时不重复创建，直接返回原请求。
 * - 注销（anonymize）须二次验证（审核 M2 · D-014）：会话签发时刻 authTime 距今 ≤ REAUTH_WINDOW_SEC，web 与 Bearer 两个入口共用本规则。
 * - 请求落库与站内确认通知在同一事务内。
 */
import { randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';
import { MeInputError } from './me';

type Exec = Pick<Db, 'execute'>;
type Tx = Pick<Db, 'execute' | 'transaction'>;

/** 注销二次验证窗口：会话须在 10 分钟内签发（重新登录） */
export const REAUTH_WINDOW_SEC = 10 * 60;

/** 注销前未在窗口内重新验证身份 → web 引导重新登录；接口 401 reauth_required */
export class ReauthRequiredError extends Error {
  constructor() {
    super('注销前需要重新验证身份（10 分钟内登录过）');
    this.name = 'ReauthRequiredError';
  }
}
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export type Preferences = { dailyDepositAlertUsdt: number | null; sessionAlertMinutes: number | null; nightAlert: boolean };
export const PREFERENCES_OFF: Preferences = { dailyDepositAlertUsdt: null, sessionAlertMinutes: null, nightAlert: false };

export async function getPreferences(db: Exec, userId: string): Promise<Preferences> {
  const [r] = await q<Preferences>(
    db,
    sql`select "dailyDepositAlertUsdt", "sessionAlertMinutes", "nightAlert" from ${schema.userPreferences} where "userId" = ${userId}`,
  );
  return r ?? PREFERENCES_OFF;
}

/** PUT /me/preferences：整体替换（契约 Preferences 三字段必填；值域由调用方按契约校验，DB CHECK 兜底） */
export async function putPreferences(db: Exec, userId: string, p: Preferences): Promise<Preferences> {
  const [r] = await q<Preferences>(
    db,
    sql`insert into ${schema.userPreferences} ("userId", "dailyDepositAlertUsdt", "sessionAlertMinutes", "nightAlert")
        values (${userId}, ${p.dailyDepositAlertUsdt}, ${p.sessionAlertMinutes}, ${p.nightAlert})
        on conflict ("userId") do update set "dailyDepositAlertUsdt" = excluded."dailyDepositAlertUsdt",
          "sessionAlertMinutes" = excluded."sessionAlertMinutes", "nightAlert" = excluded."nightAlert", "updatedAt" = now()
        returning "dailyDepositAlertUsdt", "sessionAlertMinutes", "nightAlert"`,
  );
  return r!;
}

export type DataRequestKind = 'redact_evidence' | 'delete_evidence' | 'export' | 'anonymize';
export const DATA_REQUEST_TEXT: Record<DataRequestKind, string> = {
  redact_evidence: '证据原文脱敏',
  delete_evidence: '删除证据原文',
  export: '导出我的数据',
  anonymize: '注销账号（匿名化）',
};
const EVIDENCE_KINDS: DataRequestKind[] = ['redact_evidence', 'delete_evidence'];
const MAX_TARGETS = 50;

export type DataRequestCreated = { id: string; kind: DataRequestKind; created: boolean; notificationIds: string[] };

/** POST /me/data-requests（202）：落库 + 站内确认通知 */
export async function createDataRequest(
  db: Tx,
  userId: string,
  input: { kind: DataRequestKind; evidenceIds?: string[]; note?: string | null },
  session: { authTime: number | null | undefined; nowSec?: number },
): Promise<DataRequestCreated> {
  if (input.kind === 'anonymize') {
    const now = session.nowSec ?? Math.floor(Date.now() / 1000);
    if (typeof session.authTime !== 'number' || now - session.authTime > REAUTH_WINDOW_SEC || session.authTime > now + 60) throw new ReauthRequiredError();
  }
  try {
    return await db.transaction((tx) => createDataRequestTx(tx, userId, input));
  } catch (e) {
    // A-012 #20：并发提交撞上「同类处理中唯一」→ 返回已有请求（先查后插的兜底）
    const c = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
    if ((c.code ?? c.cause?.code) === '23505' && (c.constraint_name ?? c.cause?.constraint_name) === 'data_request_pending_uq') {
      const [p] = await q<{ id: string }>(db, sql`select "id" from ${schema.dataRequests} where "userId" = ${userId} and "kind" = ${input.kind} and "status" = 'pending' limit 1`);
      if (p) return { id: p.id, kind: input.kind, created: false, notificationIds: [] };
    }
    throw e;
  }
}

async function createDataRequestTx(db: Exec, userId: string, input: { kind: DataRequestKind; evidenceIds?: string[]; note?: string | null }): Promise<DataRequestCreated> {
  const note = input.note?.trim() || null;
  if (note && note.length > 200) throw new MeInputError('备注不超过 200 字');
  const isEvidence = EVIDENCE_KINDS.includes(input.kind);
  if (!isEvidence && input.evidenceIds?.length) throw new MeInputError('该类请求不需要指定证据');

  const [pending] = await q<{ id: string }>(
    db,
    sql`select "id" from ${schema.dataRequests} where "userId" = ${userId} and "kind" = ${input.kind} and "status" = 'pending' order by "createdAt" desc limit 1`,
  );
  if (pending) return { id: pending.id, kind: input.kind, created: false, notificationIds: [] };

  let targets: string[] = [];
  if (isEvidence) {
    // 只允许本人案件的证据，且原文仍在（删除：未删除；脱敏：未脱敏且未删除）
    const still = input.kind === 'redact_evidence' ? sql`and not e."redacted" and e."deletedAt" is null` : sql`and e."deletedAt" is null`;
    const mine = await q<{ id: string }>(
      db,
      sql`select e."id" from ${schema.evidence} e join ${schema.complaints} c on c."id" = e."complaintId"
          where c."userId" = ${userId} ${still} order by e."uploadedAt", e."id"`,
    );
    // D-024：「删除证据原文」同样覆盖本人出款凭证的截图（submission_evidence）；脱敏只针对投诉证据
    const subs =
      input.kind === 'delete_evidence'
        ? await q<{ id: string }>(
            db,
            sql`select se."id" from ${schema.submissionEvidence} se join ${schema.withdrawalReports} w on w."id" = se."withdrawalReportId"
                where w."userId" = ${userId} and se."deletedAt" is null order by se."uploadedAt", se."id"`,
          )
        : [];
    const own = new Set([...mine, ...subs].map((r) => r.id));
    if (input.evidenceIds?.length) {
      const ids = [...new Set(input.evidenceIds)];
      if (ids.some((id) => !own.has(id))) throw new MeInputError('只能申请处理本人案件中原文仍在的证据');
      targets = ids;
    } else targets = [...own];
    if (!targets.length) throw new MeInputError('没有可处理的证据原文');
    if (targets.length > MAX_TARGETS) throw new MeInputError(`单次最多 ${MAX_TARGETS} 份证据，请分批申请`);
  }

  const id = `dr_${randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql`insert into ${schema.dataRequests} ("id", "userId", "kind", "targetIds", "note")
        values (${id}, ${userId}, ${input.kind}, ${JSON.stringify(targets)}::jsonb, ${note})`,
  );
  const nid = `nt_${randomUUID().replaceAll('-', '')}`;
  const extra = isEvidence ? `（${targets.length} 份证据）` : '';
  await db.execute(
    sql`insert into ${schema.notifications} ("id", "userId", "type", "title", "body")
        values (${nid}, ${userId}, 'data_request', ${`已收到你的数据请求：${DATA_REQUEST_TEXT[input.kind]}`},
                ${`请求编号 ${id}${extra}。处理期 7 天，结果会在站内通知你。`})`,
  );
  return { id, kind: input.kind, created: true, notificationIds: [nid] };
}

/** 隐私页：本人最近的数据请求（状态展示） */
export async function listMyDataRequests(db: Exec, userId: string) {
  const rows = await q<{ id: string; kind: DataRequestKind; status: 'pending' | 'done' | 'rejected'; createdAt: Date | string; targets: number }>(
    db,
    sql`select "id", "kind", "status", "createdAt", jsonb_array_length("targetIds")::int as "targets"
        from ${schema.dataRequests} where "userId" = ${userId} order by "createdAt" desc, "id" limit 20`,
  );
  return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
}
