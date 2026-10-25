'use server';
/**
 * D-024 提交出款凭证（契约 POST /me/withdrawal-reports + /evidence 同一用例）。userId 只取自会话。
 * 凭证与截图在同一事务内写入：截图（≥ 1 张，裁定 ②）任何一张失败则整笔回滚，不留下无截图、永远无法采纳的凭证；已写入的截图对象随之删除。
 * 数据库命名约束（绑定 / 限额 / 未来时间 / 金额）按 core 映射表给出中文提示。
 */
import { RateLimitedError } from '@bydp/core/abuse/limits';
import { SubmissionInputError, submitWithdrawalWithEvidence } from '@bydp/core/trust/submissions';
import { constraintOf, submissionError } from '@bydp/core/trust/submission-errors';
import { auth } from '../../../../auth';
import { db } from '../../../../lib/db';
import { evidenceStore } from '../../../../lib/evidence-store';
import { rateCounter } from '../../../../lib/rate-counter';

export type WithdrawalState = { step: 'form'; error?: string } | { step: 'done'; id: string; files: number };

const MAX_FILES = 3;
const MAX_FILE = 20 * 1024 * 1024;

export async function submitWithdrawalAction(_prev: WithdrawalState, form: FormData): Promise<WithdrawalState> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { step: 'form', error: '登录已失效，请重新登录' };
  const files = form.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { step: 'form', error: '请至少上传 1 张出款截图（没有截图的凭证不能采纳）' };
  if (files.length > MAX_FILES) return { step: 'form', error: `一次最多 ${MAX_FILES} 张截图` };
  if (files.some((f) => f.size > MAX_FILE)) return { step: 'form', error: '单张截图不超过 20MB' };
  const store = evidenceStore();
  if (!store) return { step: 'form', error: '截图存储暂不可用，请稍后再试' };
  const outcome = String(form.get('outcome') ?? '');
  const input = {
    brandId: String(form.get('brandId') ?? ''),
    amountUsdt: String(form.get('amountUsdt') ?? '').replace(/,/g, ''),
    method: String(form.get('method') ?? ''),
    requestedAt: String(form.get('requestedAt') ?? ''),
    receivedAt: outcome === 'paid' ? String(form.get('receivedAt') ?? '') || null : null,
    outcome: outcome as 'paid' | 'refused' | 'pending',
  };
  const contents = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  try {
    // 同一事务写凭证与截图；失败时 core 删除本次已写入的截图对象（W2#005 收尾 2）
    const r = await submitWithdrawalWithEvidence(db(), store, uid, input as never, contents, { counter: rateCounter() });
    return { step: 'done', id: r.id, files: r.files };
  } catch (e) {
    if (e instanceof SubmissionInputError || e instanceof RateLimitedError) return { step: 'form', error: e.message };
    const mapped = submissionError(constraintOf(e));
    if (mapped) return { step: 'form', error: mapped.body.message };
    if (e instanceof Error && e.name === 'ZodError') return { step: 'form', error: '请检查金额、出款方式与时间是否填写正确' };
    throw e;
  }
}
