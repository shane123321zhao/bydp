/**
 * 证据对象删除的兑现保障（审核 admin 第 2 轮（下）须改 · 随 A-015 交付）：
 * - 删除失败不再静默：写一条告警日志（evt = evidence_object_delete_failed，带对象 key 与上下文），由日志告警捕获；
 * - 对账任务（worker 每日）：从 audit_log 的 evidence_delete_original / evidence_redact / submission_evidence_delete_original（D-024 出款凭证截图）取 before.storageKey，
 *   对象仍存在则重删；同时清理该证据的预览缓存。只读 DB、只删对象存储，不改任何表。
 */
import { schema, sql, type Db } from '@bydp/db';
import type { EvidenceStore } from '../complaint/write';
import { deleteObjectOrAlert, PREVIEW_PAGES, previewKey } from './evidence';

export { deleteObjectOrAlert };

type Exec = Pick<Db, 'execute'>;

export const RECONCILE_WINDOW_DAYS = 90;

export type ReconcileResult = { checked: number; redeleted: number; failed: number };

/** 对账：近 windowDays 天内「已删 / 已替换」的原文对象，若仍在存储中则重删（预览缓存一并） */
export async function reconcileDeletedObjects(db: Exec, store: EvidenceStore, windowDays = RECONCILE_WINDOW_DAYS): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, redeleted: 0, failed: 0 };
  if (!store.exists || !store.delete) return out;
  const rows = (await db.execute(
    sql`select "targetId" as "evidenceId", "action", "before"->>'storageKey' as "key" from ${schema.auditLogs}
        where "action" in ('evidence_delete_original', 'evidence_redact', 'submission_evidence_delete_original') and "at" > now() - make_interval(days => ${windowDays})
          and "before"->>'storageKey' is not null
        order by "at"`,
  )) as unknown as { evidenceId: string; action: string; key: string }[];
  for (const r of rows) {
    const keys = [r.key, ...Array.from({ length: PREVIEW_PAGES }, (_, i) => previewKey(r.evidenceId, i + 1))];
    // 脱敏替换后预览缓存可能已按脱敏件重新生成，不能删；只对「删除原文」清预览
    const targets = r.action === 'evidence_redact' ? [r.key] : keys;
    for (const key of targets) {
      out.checked++;
      let present: boolean;
      try {
        present = await store.exists(key);
      } catch (e) {
        console.error(JSON.stringify({ evt: 'evidence_object_reconcile_check_failed', alert: true, key, error: (e as Error).message }));
        out.failed++;
        continue;
      }
      if (!present) continue;
      if (await deleteObjectOrAlert(store, key, { evidenceId: r.evidenceId, via: 'reconcile' })) out.redeleted++;
      else out.failed++;
    }
  }
  return out;
}
