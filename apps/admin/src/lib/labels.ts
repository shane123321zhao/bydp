/** 后台显示用中文标签（与 web / core 口径一致：STATUS_TEXT · 投诉类别 · DATA_REQUEST_TEXT） */
export const ROLE_TEXT: Record<string, string> = { arbitrator: '仲裁员', commerce: '商务', editor: '编辑', admin: '管理员' };

export const STATUS_TEXT: Record<string, string> = {
  screening: '待初筛',
  accepted: '已受理',
  awaiting_reply: '待答辩',
  arbitrating: '仲裁中',
  resolved: '已解决',
  rejected: '驳回',
  unresolved: '未解决',
  exposed: '已曝光',
};

export const CATEGORY_TEXT: Record<string, string> = { refused: '拒付', delay: '提款延迟', frozen: '冻结账号', bonus: '优惠争议', closed: '关站失联' };

export const FLAG_TEXT: Record<string, string> = {
  second_notice_due: '待二次通知',
  pending_exposure_decision: '待决定曝光',
  awaiting_publish: '待公开',
};

export const BINDING_TEXT: Record<string, string> = {
  none: '未绑定',
  self_reported: '自报绑定',
  postback_confirmed: '回传确认',
  operator_confirmed: '运营商确认',
};

export const BRAND_STATUS_TEXT: Record<string, string> = { certified: '平台认证', watch: '观察', blacklist: '黑名单' };

export const DATA_REQUEST_TEXT: Record<string, string> = {
  redact_evidence: '证据原文脱敏',
  delete_evidence: '删除证据原文',
  export: '导出我的数据',
  anonymize: '注销账号（匿名化）',
};
export const DR_STATUS_TEXT: Record<string, string> = { pending: '待处理', done: '已完成', rejected: '已驳回' };

export const REVIEW_KIND_TEXT: Record<string, string> = {
  brand_attribute: '品牌属性',
  site_monitor: '站点监测',
  complaint_screening: '投诉初筛',
  localization: '本地化',
};

export const DASHBOARD_TEXT: [key: string, label: string, href: string | null][] = [
  ['complaintsScreening', '待初筛', '/complaints?status=screening'],
  ['awaitingFirstNotice', '待首次通知', '/complaints?status=accepted'],
  ['secondNoticeDue', '待二次通知', '/complaints?flag=second_notice_due'],
  ['pendingExposureDecision', '待决定曝光', '/complaints?flag=pending_exposure_decision'],
  ['awaitingPublish', '待公开', '/complaints?flag=awaiting_publish'],
  ['dataRequestsPending', '数据请求待处理', '/data-requests'],
  ['reviewPending', 'Agent 待确认', '/review'],
  ['deviceFlags7d', '近 7 日多账号标记', '/risk'],
];

/** 时间显示：UTC+8 分钟精度（后台统一口径，悬停看原值） */
export function fmt(at: string | null | undefined): string {
  if (!at) return '—';
  const d = new Date(new Date(at).getTime() + 8 * 3600_000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}`;
}
