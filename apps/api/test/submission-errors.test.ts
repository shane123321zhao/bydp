/** A-019：评价 / 出款凭证命名约束 → HTTP 映射（纯函数；码须在契约 ApiErrorCode 内） */
import { describe, expect, it } from 'vitest';
import { ApiErrorCode } from '@bydp/core/shared';
import { SUBMISSION_CONSTRAINTS, submissionError } from '../src/submission-errors';

describe('A-019 约束映射', () => {
  it('F8 未来时间 → 422 invalid_time；限额 → 429 report_limit；重复评价 → 409 already_reviewed；绑定 → 409 binding_required', () => {
    expect(submissionError('withdrawal_report_time_in_future')).toMatchObject({ status: 422, body: { code: 'invalid_time' } });
    expect(submissionError('withdrawal_report_binding_limit')).toMatchObject({ status: 429, body: { code: 'report_limit' } });
    expect(submissionError('review_user_brand_active_uq')).toMatchObject({ status: 409, body: { code: 'already_reviewed' } });
    expect(submissionError('withdrawal_report_binding_after_request')).toMatchObject({ status: 409, body: { code: 'binding_required' } });
    expect(submissionError('withdrawal_report_amount_positive')).toMatchObject({ status: 422 });
    expect(submissionError('review_text_len')).toMatchObject({ status: 422 });
  });
  it('未列出的约束不映射（照常抛出）；全部码都在契约枚举内', () => {
    expect(submissionError('brand_related_party_never_certified')).toBeUndefined();
    expect(submissionError(undefined)).toBeUndefined();
    for (const v of Object.values(SUBMISSION_CONSTRAINTS)) expect(ApiErrorCode.safeParse(v.body.code).success).toBe(true);
  });
});
