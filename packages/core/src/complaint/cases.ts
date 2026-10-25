/**
 * 公开案件页 GET /cases/{id}（field-mapping 05 案件页）：仅 publicSummary=true，否则视为不存在。只读。
 * userStatement 对外脱敏：邮箱、手机号、长账号 / 地址串打码（原文仍在库内）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { getBindingLevel } from '../identity/bindings';
import { loadBrandCards } from '../trust/brand-card';
import type { TimelineEvent } from '../shared/index';
import type { CasePublic } from './index';

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;
const iso = (d: Date | string) => new Date(d).toISOString();
const DAY = 86_400_000;
const REPLY_WINDOW_DAYS = 7; // §5：运营商答辩期（建议 7 天）

/**
 * 对外脱敏（自动兜底；公开前仍需审核台人工确认，M3）：邮箱、TG / 社交 @句柄、≥ 6 位纯数字（手机 / QQ）、
 * 字母数字混合 ≥ 5 位的串（运营商账号、微信号、钱包地址）。金额（含千分位逗号）与日期不受影响。
 */
export function redactStatement(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***')
    .replace(/@[A-Za-z0-9_]{3,}/g, '@***')
    .replace(/\+?\d[\d\s-]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? m.slice(0, 2) + '***' + m.slice(-2) : m))
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/g, (m) =>
      m.length >= 12 ? m.slice(0, 3) + '…' + m.slice(-3) : m.slice(0, 1) + '***',
    );
}

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

export async function getCase(db: Reader, id: string): Promise<CasePublic | null> {
  const [c] = await q<{
    id: string;
    brandId: string;
    bindingId: string | null;
    title: string;
    category: CasePublic['category'];
    status: NonNullable<CasePublic['status']>;
    amountUsdt: string;
    /** A-014：公开陈述（仲裁员人工脱敏）；公开路径一律不读投诉原文 description（DB CHECK 保证公开必有本列） */
    publicDescription: string;
    createdAt: Date;
    acceptedAt: Date | null;
    operatorNotifiedAt: Date | null;
    secondNoticeAt: Date | null;
    replyDeadline: Date | null;
    resolvedAt: Date | null;
    exposedAt: Date | null;
    resolution: string | null;
  }>(
    db,
    sql`select "id", "brandId", "bindingId", "title", "category", "status", "amountUsdt", "publicDescription", "createdAt", "acceptedAt",
               "operatorNotifiedAt", "secondNoticeAt", "replyDeadline", "resolvedAt", "exposedAt", "resolution"
        from ${schema.complaints} where "id" = ${id} and "publicSummary"`,
  );
  if (!c) return null;
  const brand = (await loadBrandCards(db, [c.brandId])).get(c.brandId)!;
  const bindingLevel = c.bindingId ? await getBindingLevel(db, c.bindingId) : null;
  const [reply] = await q<{ repliedAt: Date; summary: string; attachments: number }>(
    db,
    sql`select "repliedAt", "summary", "attachments" from ${schema.operatorReplies} where "complaintId" = ${c.id} order by "repliedAt" desc limit 1`,
  );
  const evidence = await q<{ type: string; sha256: string; redacted: boolean }>(
    db,
    sql`select "type", "sha256", "redacted" from ${schema.evidence} where "complaintId" = ${c.id} order by "uploadedAt"`,
  );
  const notices = [c.operatorNotifiedAt, c.secondNoticeAt].filter(Boolean).length;
  const windowTo = c.replyDeadline ?? (c.operatorNotifiedAt ? new Date(new Date(c.operatorNotifiedAt).getTime() + REPLY_WINDOW_DAYS * DAY) : null);
  const exposureDays = c.acceptedAt && c.exposedAt ? Math.round((new Date(c.exposedAt).getTime() - new Date(c.acceptedAt).getTime()) / DAY) : null;

  const history = await q<{ from: string | null; to: string; reason: string | null; at: Date }>(
    db,
    sql`select "from", "to", "reason", "at" from ${schema.statusHistory} where "complaintId" = ${c.id} order by "at"`,
  );
  const timeline: TimelineEvent[] = [
    { date: iso(c.createdAt), subject: '提交', rest: c.title, kind: 'info' as const },
    ...(c.acceptedAt ? [{ date: iso(c.acceptedAt), subject: '已受理', rest: '', kind: 'info' as const }] : []),
    ...(c.operatorNotifiedAt ? [{ date: iso(c.operatorNotifiedAt), subject: '通知运营商', rest: '答辩期开始', kind: 'info' as const }] : []),
    ...(c.secondNoticeAt ? [{ date: iso(c.secondNoticeAt), subject: '二次通知', rest: '', kind: 'warning' as const }] : []),
    ...(reply ? [{ date: iso(reply.repliedAt), subject: '运营商答辩', rest: reply.summary, kind: 'info' as const }] : []),
    // 状态日志的 reason 为内部裁决文本，公开页只出状态名（审查建议）
    ...history.map((h) => ({ date: iso(h.at), subject: STATUS_TEXT[h.to] ?? h.to, rest: '', kind: 'decision' as const })),
    ...(c.resolvedAt ? [{ date: iso(c.resolvedAt), subject: '已解决', rest: c.resolution ?? '', kind: 'decision' as const }] : []),
    ...(c.exposedAt ? [{ date: iso(c.exposedAt), subject: '转曝光', rest: c.resolution ?? '', kind: 'warning' as const }] : []),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    id: c.id,
    title: c.title,
    category: c.category,
    status: c.status,
    amountUsdt: Number(c.amountUsdt),
    createdAt: iso(c.createdAt),
    resolvedAt: c.resolvedAt ? iso(c.resolvedAt) : null,
    exposedAt: c.exposedAt ? iso(c.exposedAt) : null,
    brand,
    facts: [
      { v: `${Number(c.amountUsdt).toLocaleString('en-US')} U`, k: '涉案金额', tone: 'neutral' },
      { v: `${notices} 次`, k: '通知运营商', tone: notices >= 2 && !reply ? 'red' : 'neutral' },
      ...(exposureDays != null ? [{ v: `${exposureDays} 天`, k: '受理至曝光', tone: 'red' as const }] : []),
    ],
    // 人工脱敏之外仍保留自动兜底（邮箱 / 手机 / 账号样式）
    userStatement: redactStatement(c.publicDescription),
    userBindingLevel: bindingLevel ?? 'none',
    operatorReply: reply ? { repliedAt: iso(reply.repliedAt), summary: reply.summary, attachments: reply.attachments } : null,
    ...(c.operatorNotifiedAt && windowTo ? { replyWindow: { from: iso(c.operatorNotifiedAt), to: iso(windowTo), notices } } : {}),
    evidenceHashes: evidence,
    timeline,
  };
}
