/**
 * A-019（迁移 0016）：api / web 共用的评价 / 出款凭证提交触发器与 CHECK 的命名约束 → 对外 HTTP（契约 Error 体）。
 * 只映射本表列出的约束名；其他 check_violation 不在此处理（照常抛出）。
 */
import type { ApiError } from '../shared/index';

export const SUBMISSION_CONSTRAINTS: Record<string, { status: 409 | 422 | 429; body: ApiError }> = {
  withdrawal_report_binding_required: { status: 409, body: { code: 'binding_required', message: '须先绑定该平台的账号，且只能用本人绑定提交' } },
  withdrawal_report_binding_after_request: { status: 409, body: { code: 'binding_required', message: '绑定时间须早于申请提款时间' } },
  withdrawal_report_binding_limit: { status: 429, body: { code: 'report_limit', message: '同一绑定账号 30 天内最多提交 3 份出款凭证' } },
  withdrawal_report_time_in_future: { status: 422, body: { code: 'invalid_time', message: '申请提款 / 到账时间不能晚于当前时间' } },
  withdrawal_report_received_after_requested: { status: 422, body: { code: 'invalid_time', message: '到账时间不能早于申请提款时间' } },
  withdrawal_report_amount_positive: { status: 422, body: { code: 'invalid_argument', message: '金额须大于 0' } },
  withdrawal_report_outcome_amend: { status: 409, body: { code: 'invalid_argument', message: '出款结果只能由「未到账」补录一次' } },
  submission_evidence_report_pending: { status: 409, body: { code: 'invalid_argument', message: '凭证已审核，不能再补充截图' } },
  review_binding_required: { status: 409, body: { code: 'binding_required', message: '须先绑定该平台的账号才能评价' } },
  review_user_brand_active_uq: { status: 409, body: { code: 'already_reviewed', message: '你已评价过该平台' } },
  review_text_len: { status: 422, body: { code: 'invalid_argument', message: '评价不超过 500 字' } },
};

export function submissionError(constraint: string | undefined) {
  return constraint ? SUBMISSION_CONSTRAINTS[constraint] : undefined;
}

/** postgres 约束名（触发器 RAISE … CONSTRAINT 同样带出；drizzle 会把驱动错误包在 cause 里） */
export function constraintOf(e: unknown): string | undefined {
  for (let x: unknown = e, i = 0; x && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const n = (x as { constraint_name?: unknown; constraint?: unknown }).constraint_name ?? (x as { constraint?: unknown }).constraint;
    if (typeof n === 'string' && n) return n;
  }
  return undefined;
}
