/** 连 DB 的只读用例（apps 经此引入）；schema 模块保持无 DB 依赖 */
export { checkIdentifier } from './trust/check';
export { getBrandComplaints, getBrandIdentifiers, getBrandScore, getBrandWithdrawals, getList, getRelatedPartyBrands, type Lib } from './trust/brands';
export { getBrandOffers, getOffers, type OfferFilter } from './commerce/offers';
export { getCase } from './complaint/cases';
export { getOfficialChannels, getPointsConfig } from './identity/config';
export { getBrandDetail, getHome } from './api/views';
export { writeScoreSnapshots, type SnapshotWrite } from './trust/snapshots';
export { addEvidence, ComplaintInputError, recordSecondNotice, submitComplaint, transitionComplaint, type EvidenceStore } from './complaint/write';
export { TransitionError } from './complaint/state';
