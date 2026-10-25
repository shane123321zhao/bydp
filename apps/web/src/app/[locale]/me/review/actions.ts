'use server';
/** D-024 写评价（契约 POST /me/reviews 同一用例）：须本人绑定该品牌；待审；文字不公开（裁定 ④）。 */
import { createReview, SubmissionInputError } from '@bydp/core/trust/submissions';
import { constraintOf, submissionError } from '@bydp/core/trust/submission-errors';
import { auth } from '../../../../auth';
import { db } from '../../../../lib/db';

export type ReviewState = { step: 'form'; error?: string } | { step: 'done'; id: string };

export async function submitReviewAction(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { step: 'form', error: '登录已失效，请重新登录' };
  const rating = Number(form.get('rating'));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { step: 'form', error: '请选择 1–5 星' };
  const text = String(form.get('text') ?? '').trim();
  if (text.length > 500) return { step: 'form', error: '评价不超过 500 字' };
  try {
    const r = await createReview(db(), uid, { brandId: String(form.get('brandId') ?? ''), rating, text: text || null });
    return { step: 'done', id: r.id };
  } catch (e) {
    if (e instanceof SubmissionInputError) return { step: 'form', error: e.message };
    const mapped = submissionError(constraintOf(e));
    if (mapped) return { step: 'form', error: mapped.body.message };
    throw e;
  }
}
