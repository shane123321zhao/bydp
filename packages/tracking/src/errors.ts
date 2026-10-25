export type TrackingErrorCode =
  | 'offer_not_found'
  | 'offer_expired'
  | 'brand_blacklisted'
  | 'related_party_exclusive'
  | 'partner_invalid'
  | 'click_not_found'
  | 'click_brand_mismatch'
  | 'reversal_target_not_found'
  | 'reversal_target_invalid';

/** 业务拒绝（调用方映射为 4xx）；其余异常一律按 5xx 处理 */
export class TrackingError extends Error {
  constructor(public readonly code: TrackingErrorCode) {
    super(code);
    this.name = 'TrackingError';
  }
}
