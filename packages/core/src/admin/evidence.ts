/**
 * 仲裁台证据原文下载（admin 契约 v0.2 · 上线前置 #21）：一律 attachment + nosniff + 沙箱 CSP，文件名只用证据 id；
 * 下载写 audit_log（预览不写，预览见下一轮）。原文已删除 → GoneError（410，哈希仍在）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { evidenceDownloadHeaders } from '../complaint/evidence-type';
import type { EvidenceStore } from '../complaint/write';
import { writeAudit, type Actor } from './rbac';

export class GoneError extends Error {
  constructor(message = '原文已删除（哈希仍在）') {
    super(message);
    this.name = 'GoneError';
  }
}
export class EvidenceNotFoundError extends Error {
  constructor() {
    super('证据不存在');
    this.name = 'EvidenceNotFoundError';
  }
}

export async function downloadEvidence(
  db: Pick<Db, 'execute'>,
  store: EvidenceStore,
  actor: Actor,
  evidenceId: string,
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const [e] = (await db.execute(
    sql`select "id", "complaintId", "storageKey", "deletedAt" is not null as "deleted", "redacted" from ${schema.evidence} where "id" = ${evidenceId}`,
  )) as unknown as { id: string; complaintId: string; storageKey: string | null; deleted: boolean; redacted: boolean }[];
  if (!e) throw new EvidenceNotFoundError();
  if (!e.storageKey || e.deleted) throw new GoneError();
  if (!store.get) throw new Error('证据存储未配置读取');
  const body = await store.get(e.storageKey);
  if (!body) throw new GoneError('原文对象不存在');
  await writeAudit(db, actor, 'evidence_download', { type: 'evidence', id: e.id }, null, { complaintId: e.complaintId, redacted: e.redacted, bytes: body.byteLength });
  return { body, headers: evidenceDownloadHeaders(e.id, body) };
}

/** 预览缓存键（契约 v0.2 Q2）：与原文同桶，原文删除 / 脱敏替换时一并删除 */
export const PREVIEW_PAGES = 5;
export const previewKey = (evidenceId: string, page: number) => `preview/${evidenceId}/${page}.png`;

/** 读取原文供预览（不写 audit；仲裁台预览不下发原文件）。原文已删 → GoneError */
export async function readEvidenceForPreview(db: Pick<Db, 'execute'>, store: EvidenceStore, evidenceId: string): Promise<{ id: string; content: Uint8Array }> {
  const [e] = (await db.execute(
    sql`select "id", "storageKey", "deletedAt" is not null as "deleted" from ${schema.evidence} where "id" = ${evidenceId}`,
  )) as unknown as { id: string; storageKey: string | null; deleted: boolean }[];
  if (!e) throw new EvidenceNotFoundError();
  if (!e.storageKey || e.deleted) throw new GoneError();
  if (!store.get) throw new Error('证据存储未配置读取');
  const content = await store.get(e.storageKey);
  if (!content) throw new GoneError('原文对象不存在');
  return { id: e.id, content };
}

/**
 * 删除一个对象；失败写告警日志（evt = evidence_object_delete_failed，带 key）并返回 false——不静默吞掉（审核 admin 第 2 轮（下）须改）。
 * 调用方的数据库事务已提交，不回滚；遗留对象由 worker 对账任务重删（object-reconcile.ts）。
 */
export async function deleteObjectOrAlert(store: EvidenceStore, key: string, ctx: Record<string, string | null> = {}): Promise<boolean> {
  if (!store.delete) return false;
  try {
    await store.delete(key);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ evt: 'evidence_object_delete_failed', alert: true, key, ...ctx, error: (e as Error).message }));
    return false;
  }
}

/** 清理某证据的全部预览缓存（原文删除 / 脱敏替换后调用） */
export async function purgePreviewCache(store: EvidenceStore, evidenceId: string): Promise<void> {
  if (!store.delete) return;
  for (let p = 1; p <= PREVIEW_PAGES; p++) await deleteObjectOrAlert(store, previewKey(evidenceId, p), { evidenceId, via: 'preview_purge' });
}
