'use server';
/** 本人案件补充证据（契约 POST /complaints/{id}/evidence 同一用例）：服务端 SHA-256，原文存 R2；结案后不再接收（core 判定）。 */
import { ComplaintInputError, addEvidence } from '@bydp/core/complaint/write';
import { RateLimitedError } from '@bydp/core/abuse/limits';
import { rateCounter } from '../../../../../lib/rate-counter';
import { auth } from '../../../../../auth';
import { db } from '../../../../../lib/db';
import { evidenceStore } from '../../../../../lib/evidence-store';

export type EvidenceResult = { ok: true; sha256: string } | { ok: false; error: string };
const FILE_TYPES = ['screenshot', 'chat_log', 'other'] as const;

export async function addEvidenceAction(complaintId: string, form: FormData): Promise<EvidenceResult> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { ok: false, error: '登录已失效，请重新登录' };
  const file = form.get('file');
  const txHash = String(form.get('txHash') ?? '').trim();
  const fileType = String(form.get('fileType') ?? 'screenshot') as (typeof FILE_TYPES)[number];
  try {
    if (file instanceof File && file.size > 0) {
      if (!FILE_TYPES.includes(fileType)) return { ok: false, error: '证据类型不识别' };
      if (file.size > 20 * 1024 * 1024) return { ok: false, error: '单个证据不超过 20MB' };
      const store = evidenceStore();
      if (!store) return { ok: false, error: '证据存储暂不可用，请稍后再试' };
      const r = await addEvidence(db(), store, uid, complaintId, { type: fileType, content: new Uint8Array(await file.arrayBuffer()), contentType: file.type || null }, { counter: rateCounter() });
      return { ok: true, sha256: r.sha256 };
    }
    if (!txHash) return { ok: false, error: '请选择文件或填写交易哈希' };
    if (txHash.length > 200) return { ok: false, error: '交易哈希过长' };
    const r = await addEvidence(db(), { put: async () => {} }, uid, complaintId, { type: 'tx_hash', txHash }, { counter: rateCounter() });
    return { ok: true, sha256: r.sha256 };
  } catch (e) {
    if (e instanceof ComplaintInputError || e instanceof RateLimitedError) return { ok: false, error: e.message };
    throw e;
  }
}
