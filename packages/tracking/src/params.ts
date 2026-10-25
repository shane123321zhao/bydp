/** tracking 参数（A-007 §2）。改动须随双签。 */
/** 同一用户、同一 offer 重复领码返回同一条 Click 的时间窗 */
export const CLAIM_DEDUPE_HOURS = 24;
/** G4：末次点击归因窗口 */
export const ATTRIBUTION_WINDOW_DAYS = 30;
/** postback 密钥最短长度（环境变量 / KMS 取值） */
export const POSTBACK_SECRET_MIN_LENGTH = 32;
/** commission_event.actor */
export const TRACKING_ACTOR = 'tracking';
