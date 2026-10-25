'use server';
/**
 * 05 提交投诉（契约 POST /complaints + POST /complaints/{id}/evidence 同一用例）。userId 只取自会话。
 * 绑定：自动挂本人在该品牌最近一条绑定（赔付资格口径由 core 判定）。证据在投诉落库后逐项写入（服务端 SHA-256，原文存 R2）；
 * 证据失败不回滚投诉，返回提示，用户可在案件页补充。站内通知由 core 同事务写入，提交后入队推送。
 */
import { ComplaintInputError, addEvidence, submitComplaint } from '@bydp/core/complaint/write';
import { listComplainableBrands } from '@bydp/core/complaint/form';
import { RateLimitedError } from '@bydp/core/abuse/limits';
import { rateCounter } from '../../../lib/rate-counter';
import { auth } from '../../../auth';
import { db } from '../../../lib/db';
import { evidenceStore } from '../../../lib/evidence-store';
import { enqueueNotifications } from '../../../lib/notify';

export type SubmitResult = { ok: true; id: string; warning?: string } | { ok: false; error: string };

const CATEGORIES = ['refused', 'delay', 'frozen', 'bonus', 'closed'] as const;
const FILE_TYPES = ['screenshot', 'chat_log', 'other'] as const;
const MAX_FILE = 20 * 1024 * 1024;

export async function submitComplaintAction(form: FormData): Promise<SubmitResult> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { ok: false, error: '登录已失效，请重新登录' };
  const brandId = String(form.get('brandId') ?? '');
  const category = String(form.get('category') ?? '') as (typeof CATEGORIES)[number];
  const amount = Number(String(form.get('amountUsdt') ?? '').replace(/,/g, ''));
  const eventDate = String(form.get('eventDate') ?? '');
  const description = String(form.get('description') ?? '').trim();
  if (!CATEGORIES.includes(category)) return { ok: false, error: '请选择投诉类型' };
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) return { ok: false, error: '请填写涉及金额（USDT）' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { ok: false, error: '请填写事件日期' };
  if (!description) return { ok: false, error: '请填写经过' };
  if (description.length > 500) return { ok: false, error: '经过不超过 500 字' };

  const target = (await listComplainableBrands(db(), uid)).find((b) => b.brand.id === brandId);
  if (!target) return { ok: false, error: '请选择投诉对象' };

  const file = form.get('file');
  const hasFile = file instanceof File && file.size > 0;
  const fileType = String(form.get('fileType') ?? 'screenshot') as (typeof FILE_TYPES)[number];
  const txHash = String(form.get('txHash') ?? '').trim();
  if (hasFile && file.size > MAX_FILE) return { ok: false, error: '单个证据不超过 20MB' };
  if (hasFile && !FILE_TYPES.includes(fileType)) return { ok: false, error: '证据类型不识别' };
  if (txHash.length > 200) return { ok: false, error: '交易哈希过长' };
  const store = evidenceStore();
  if (hasFile && !store) return { ok: false, error: '证据存储暂不可用，请先只填交易哈希或稍后在案件页补充' };

  let created: { id: string; notificationIds: string[] };
  try {
    created = await submitComplaint(db(), uid, { brandId, category, amountUsdt: amount, eventDate, description, bindingId: target.binding?.id ?? null }, { counter: rateCounter() });
  } catch (e) {
    if (e instanceof ComplaintInputError || e instanceof RateLimitedError) return { ok: false, error: e.message };
    // 事件日期晚于今天（DB CHECK complaint_event_date_not_future）
    if (/event_date_not_future/.test(String((e as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? (e as Error).message))) {
      return { ok: false, error: '事件日期不能晚于今天' };
    }
    throw e;
  }
  await enqueueNotifications(created.notificationIds);

  const failed: string[] = [];
  if (hasFile) {
    await addEvidence(db(), store!, uid, created.id, { type: fileType, content: new Uint8Array(await file.arrayBuffer()), contentType: file.type || null }, { counter: rateCounter() }).catch(() =>
      failed.push('文件'),
    );
  }
  if (txHash) await addEvidence(db(), store ?? { put: async () => {} }, uid, created.id, { type: 'tx_hash', txHash }, { counter: rateCounter() }).catch(() => failed.push('交易哈希'));
  return failed.length ? { ok: true, id: created.id, warning: `投诉已提交，但${failed.join('、')}证据未保存，请在案件页补充` } : { ok: true, id: created.id };
}
