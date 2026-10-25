/**
 * 投诉状态机（架构 §9.2）。只实现图中的边；「转赔付」属 P3（Claim），不在 P1 枚举内。
 *   screening → accepted | rejected（初筛驳回，v1.6：仅垃圾 / 恶意 / 重复 / 非受理范围；原因必填、不公开、不通知运营商）
 *   accepted → awaiting_reply | exposed（仅当品牌已为黑名单：跳过答辩直接曝光）
 *   awaiting_reply → arbitrating（答辩期内有答辩）| exposed（失联：两次通知且答辩期届满无响应）
 *   arbitrating → resolved | rejected | unresolved
 *   unresolved → exposed
 */
export type ComplaintStatus = 'screening' | 'accepted' | 'awaiting_reply' | 'arbitrating' | 'resolved' | 'rejected' | 'unresolved' | 'exposed';

export const TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  screening: ['accepted', 'rejected'],
  accepted: ['awaiting_reply', 'exposed'],
  awaiting_reply: ['arbitrating', 'exposed'],
  arbitrating: ['resolved', 'rejected', 'unresolved'],
  unresolved: ['exposed'],
  resolved: [],
  rejected: [],
  exposed: [],
};

export const REPLY_WINDOW_DAYS = 7; // §5 / §9.2 答辩期

export type TransitionContext = {
  brandStatus: 'certified' | 'watch' | 'blacklist';
  operatorNotifiedAt: Date | null;
  secondNoticeAt: Date | null;
  operatorRepliedAt: Date | null;
  replyDeadline: Date | null;
  now: Date;
};

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** 校验一条状态边是否合法（纯函数） */
export function assertTransition(from: ComplaintStatus, to: ComplaintStatus, c: TransitionContext): void {
  if (!TRANSITIONS[from].includes(to)) throw new TransitionError(`不允许 ${from} → ${to}`);
  if (from === 'accepted' && to === 'exposed' && c.brandStatus !== 'blacklist')
    throw new TransitionError('跳过答辩直接曝光仅适用于品牌已为黑名单的案件');
  if (from === 'awaiting_reply' && to === 'arbitrating' && !c.operatorRepliedAt) throw new TransitionError('尚无运营商答辩');
  if (from === 'awaiting_reply' && to === 'exposed') {
    // 失联定义（§9.2）：答辩期内经官方联系渠道两次通知无响应
    const lapsed = c.replyDeadline != null && c.now.getTime() >= c.replyDeadline.getTime();
    if (c.operatorRepliedAt || !c.operatorNotifiedAt || !c.secondNoticeAt || !lapsed)
      throw new TransitionError('未满足失联条件：须两次通知、答辩期届满且无答辩');
  }
}
