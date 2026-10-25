// @bydp/tracking（A-007 双签：db + tracking）。ADR-0006：packages/scoring 禁止依赖本包。
export { buildTrackingUrl, claimOffer, officialHosts, type ClaimInput, type ClaimResult } from './claim';
export { commissionStatus, settleCommission, type CommissionStatus, type SettleResult } from './commission';
export { PostbackBody, recordConversion, type RecordedConversion, type RecordResult } from './conversion';
export { TrackingError, type TrackingErrorCode } from './errors';
export * from './params';
export { loadPostbackIntegration, signPostback, verifyPostbackSignature, type IntegrationLookup, type SignatureCheck } from './signature';
