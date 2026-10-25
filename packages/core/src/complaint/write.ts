/**
 * 投诉写路径（M2）：提交 / 状态流转 / 通知记录 / 证据上传。以 bydp_app 连接；时间戳由 DB 触发器取服务端时间。
 * 状态变更由 R1 触发器自动写 status_history（actor / reason 经 SET LOCAL 传入）。
 */
import { schema, sql, type Db } from '@bydp/db';
import { awardPoints } from '../identity/points';
import { z } from 'zod';
import { getBindingOwner } from '../identity/bindings';
import { createComplaintNotifications } from '../notify/complaint';
import { ComplaintCategory, ComplaintCreate, EvidenceType } from './index';
import { evidenceSha256 } from './evidence-hash';
import { assertTransition, REPLY_WINDOW_DAYS, type ComplaintStatus } from './state';
import { sniffEvidenceType } from './evidence-type';
import { assertComplaintQuota, assertEvidenceQuota, countComplaint, countEvidence } from '../abuse/limits';
import type { RateCounter } from '../identity/auth';

/** 反滥用（D-015 #2）：传入共享计数器即按用户限流（web / api 均传；测试可不传） */
export type QuotaOpts = { counter?: RateCounter };

type Tx = Pick<Db, 'execute' | 'transaction'>;
const q = <T>(db: Pick<Db, 'execute'>, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;

export class ComplaintInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplaintInputError';
  }
}

const CATEGORY_TITLE: Record<z.infer<typeof ComplaintCategory>, string> = {
  refused: '提款被拒',
  delay: '提款延迟',
  frozen: '账号冻结',
  bonus: '优惠纠纷',
  closed: '网站关闭 / 失联',
};

/**
 * 提交投诉：状态 screening、不公开；标题缺省由类型 + 金额生成，契约 v1.6 允许用 ComplaintCreate.title 覆盖（§9.2），
 * 受理时可由审核台修改。bindingId 必须属于本人且属于该品牌。
 */
export async function submitComplaint(db: Tx, userId: string, raw: z.infer<typeof ComplaintCreate>, opts: QuotaOpts = {}) {
  const input = ComplaintCreate.parse(raw);
  if (opts.counter) await assertComplaintQuota(opts.counter, userId);
  const [brand] = await q<{ id: string }>(db, sql`select "id" from ${schema.brands} where "id" = ${input.brandId}`);
  if (!brand) throw new ComplaintInputError('品牌不存在');
  if (input.bindingId) {
    const owner = await getBindingOwner(db, input.bindingId);
    if (!owner || owner.userId !== userId || owner.brandId !== input.brandId) throw new ComplaintInputError('绑定不属于本人或不属于该品牌');
  }
  const title = input.title?.trim() || `${CATEGORY_TITLE[input.category]} ${input.amountUsdt.toLocaleString('en-US')} USDT`;
  const created = await db.transaction(async (tx) => {
    const [row] = await q<{ id: string; status: ComplaintStatus; createdAt: Date }>(
      tx,
      sql`insert into ${schema.complaints} ("id", "brandId", "userId", "bindingId", "category", "title", "amountUsdt", "eventDate", "description", "status", "publicSummary")
          values (${`cp_${crypto.randomUUID().replaceAll('-', '')}`}, ${input.brandId}, ${userId}, ${input.bindingId ?? null}, ${input.category}, ${title},
                  ${input.amountUsdt}, ${input.eventDate}, ${input.description}, 'screening', false)
          returning "id", "status", "createdAt"`,
    );
    // M2 通知：同一事务内写站内通知；推送由调用方在提交后按 notificationIds 入队
    const notificationIds = await createComplaintNotifications(tx, row!.id, 'screening');
    return { ...row!, notificationIds };
  });
  if (opts.counter) await countComplaint(opts.counter, userId);
  return created;
}

type Row = {
  id: string;
  status: ComplaintStatus;
  brandStatus: 'certified' | 'watch' | 'blacklist';
  operatorNotifiedAt: Date | null;
  secondNoticeAt: Date | null;
  operatorRepliedAt: Date | null;
  replyDeadline: Date | null;
};

/** 状态流转（审核台 / worker 调用）。按目标状态补写对应时间点；所有时间取 DB now()。 */
export async function transitionComplaint(db: Tx, id: string, to: ComplaintStatus, actor: { id: string; reason?: string }) {
  return db.transaction(async (tx) => {
    const [c] = await q<Row & { now: Date }>(
      tx,
      sql`select c."id", c."status", b."status" as "brandStatus", c."operatorNotifiedAt", c."secondNoticeAt", c."operatorRepliedAt", c."replyDeadline", now() as "now"
          from ${schema.complaints} c join ${schema.brands} b on b."id" = c."brandId" where c."id" = ${id} for update of c`,
    );
    if (!c) throw new ComplaintInputError('投诉不存在');
    // §9.2 v1.6：初筛驳回须填原因（通知投诉人；不公开、不通知运营商——publicSummary 保持 false，也不写 operatorNotifiedAt）
    if (c.status === 'screening' && to === 'rejected' && !actor.reason?.trim()) throw new ComplaintInputError('初筛驳回须填写驳回原因');
    // 原生查询返回的时间戳可能是字符串：统一转 Date 再判规则
    const d = (v: Date | string | null) => (v == null ? null : new Date(v));
    assertTransition(c.status, to, {
      brandStatus: c.brandStatus,
      operatorNotifiedAt: d(c.operatorNotifiedAt),
      secondNoticeAt: d(c.secondNoticeAt),
      operatorRepliedAt: d(c.operatorRepliedAt),
      replyDeadline: d(c.replyDeadline),
      now: new Date(c.now),
    });
    await tx.execute(sql`select set_config('bydp.actor', ${actor.id}, true), set_config('bydp.status_reason', ${actor.reason ?? ''}, true)`);
    const extra =
      to === 'accepted'
        ? sql`, "acceptedAt" = now()`
        : to === 'awaiting_reply'
          ? sql`, "operatorNotifiedAt" = now(), "replyDeadline" = now() + ${`${REPLY_WINDOW_DAYS} days`}::interval`
          : to === 'resolved'
            ? sql`, "resolvedAt" = now()`
            : to === 'exposed'
              ? sql`, "exposedAt" = now()`
              : sql``;
    const [r] = await q<{ status: ComplaintStatus }>(tx, sql`update ${schema.complaints} set "status" = ${to} ${extra} where "id" = ${id} returning "status"`);
    const notificationIds = await createComplaintNotifications(tx, id, to, actor.reason);
    // A-010：投诉解决 +100 给投诉人（每案一次）
    if (to === 'resolved') {
      const [owner] = await q<{ userId: string }>(tx, sql`select "userId" from ${schema.complaints} where "id" = ${id}`);
      if (owner) await awardPoints(tx, { userId: owner.userId, event: 'complaint_resolved', refType: 'complaint', refId: id, dedupeKey: `complaint_resolved:${id}` });
    }
    return { ...r!, notificationIds };
  });
}

/** 第二次通知（失联判定前置条件之一，§9.2） */
export async function recordSecondNotice(db: Tx, id: string) {
  const rows = await q<{ id: string }>(
    db,
    sql`update ${schema.complaints} set "secondNoticeAt" = now()
        where "id" = ${id} and "status" = 'awaiting_reply' and "operatorNotifiedAt" is not null and "secondNoticeAt" is null
        returning "id"`,
  );
  if (!rows.length) throw new ComplaintInputError('仅待答辩且已首次通知、未二次通知的案件可记录二次通知');
}

export type EvidenceStore = {
  put(key: string, content: Uint8Array, contentType: string | null): Promise<void>;
  /** 后台读取原文（仲裁台下载 / 预览）；上传路径不需要 */
  get?(key: string): Promise<Uint8Array | null>;
  /** 删除对象（预览缓存随原文删除 / 脱敏替换清理） */
  delete?(key: string): Promise<void>;
  /** 对象是否存在（导出包下载前校验） */
  exists?(key: string): Promise<boolean>;
  /** 预签名下载链接（导出包，≤ 7 天） */
  presign?(key: string, expiresSec: number): string;
};

/**
 * 上传证据：服务端计算 SHA-256（evidence-hash v1），原文存对象存储（R2；本地 / 测试注入实现），哈希入只追加表。
 * 只有投诉人本人、且案件未结案时可上传。
 */
export async function addEvidence(
  db: Tx,
  store: EvidenceStore,
  userId: string,
  complaintId: string,
  raw: { type: z.infer<typeof EvidenceType>; label?: string; content?: Uint8Array; contentType?: string | null; txHash?: string | null },
  opts: QuotaOpts = {},
) {
  const type = EvidenceType.parse(raw.type);
  const [c] = await q<{ userId: string; status: ComplaintStatus }>(db, sql`select "userId", "status" from ${schema.complaints} where "id" = ${complaintId}`);
  if (!c || c.userId !== userId) throw new ComplaintInputError('投诉不存在或不属于本人');
  if (['resolved', 'rejected', 'exposed'].includes(c.status)) throw new ComplaintInputError('案件已结案，不再接收证据');
  const txHash = raw.txHash?.trim() || null;
  const content = raw.content ?? (txHash ? Buffer.from(txHash, 'utf8') : null);
  if (!content || content.byteLength === 0) throw new ComplaintInputError('证据内容为空');
  if (content.byteLength > 20 * 1024 * 1024) throw new ComplaintInputError('单个证据不超过 20MB');
  // #21：原文按文件头判定类型，只收图片 / PDF / 纯文本；存储的 Content-Type 取判定结果，不信任客户端声明
  const mime = raw.content ? sniffEvidenceType(raw.content) : null;
  if (raw.content && !mime) throw new ComplaintInputError('证据文件只接受图片（PNG / JPEG / GIF / WebP）、PDF 或纯文本');
  const bytes = raw.content ? raw.content.byteLength : 0;
  if (opts.counter) await assertEvidenceQuota(opts.counter, userId, bytes);
  const sha256 = evidenceSha256({ complaintId, type, content, txHash });
  const id = `ev_${crypto.randomUUID().replaceAll('-', '')}`;
  const storageKey = raw.content ? `evidence/${complaintId}/${id}` : null;
  if (storageKey) await store.put(storageKey, content, mime);
  const [row] = await q<{ id: string; sha256: string; uploadedAt: Date }>(
    db,
    sql`insert into ${schema.evidence} ("id", "complaintId", "type", "label", "sha256", "txHash", "storageKey")
        values (${id}, ${complaintId}, ${type}, ${raw.label ?? null}, ${sha256}, ${txHash}, ${storageKey})
        returning "id", "sha256", "uploadedAt"`,
  );
  if (opts.counter) await countEvidence(opts.counter, userId, bytes);
  return row!;
}
