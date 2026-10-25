/**
 * 反滥用（D-015 #2 · 审核 M2 签收提醒 1）：投诉 / 证据按用户限流，计数走共享 RateCounter（部署环境 Redis，上线前置 #8）。
 * 阈值（审核定稿 2026-10-01）：每用户 24 小时内 投诉 ≤ 3 件；证据 ≤ 30 份、累计 ≤ 200MB。
 * 窗口为「首次计数起 24 小时」的固定窗口（交界处最多连续 6 件投诉，作为防刷存储可接受）。
 * 口径：先只读预判（peek）再执行用例，成功后才计数——失败的提交不占额度；并发下可能略超 1 次，可接受（只为防刷存储，不是计费）。
 * 超额 → RateLimitedError → 接口 429 `rate_limited`（契约 Error 枚举）。
 */
import type { RateCounter } from '../identity/auth';

const DAY = 86_400;

export const ABUSE_LIMITS = {
  complaintsPerUserDay: 3,
  evidenceFilesPerUserDay: 30,
  evidenceBytesPerUserDay: 200 * 1024 * 1024,
} as const;

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

const keys = (userId: string) => ({ complaints: `cp:u:${userId}`, files: `ev:n:${userId}`, bytes: `ev:b:${userId}` });

export async function assertComplaintQuota(counter: RateCounter, userId: string): Promise<void> {
  if ((await counter.peek(keys(userId).complaints)) >= ABUSE_LIMITS.complaintsPerUserDay) {
    throw new RateLimitedError(`24 小时内最多提交 ${ABUSE_LIMITS.complaintsPerUserDay} 件投诉，请稍后再试`);
  }
}
export async function countComplaint(counter: RateCounter, userId: string): Promise<void> {
  await counter.hit(keys(userId).complaints, DAY);
}

/** bytes：本次上传的原文字节数（交易哈希类证据计 0 字节，但计 1 份） */
export async function assertEvidenceQuota(counter: RateCounter, userId: string, bytes: number): Promise<void> {
  const k = keys(userId);
  if ((await counter.peek(k.files)) >= ABUSE_LIMITS.evidenceFilesPerUserDay) {
    throw new RateLimitedError(`24 小时内最多上传 ${ABUSE_LIMITS.evidenceFilesPerUserDay} 份证据，请稍后再试`);
  }
  if ((await counter.peek(k.bytes)) + bytes > ABUSE_LIMITS.evidenceBytesPerUserDay) {
    throw new RateLimitedError('24 小时内证据累计不超过 200MB，请稍后再试');
  }
}
export async function countEvidence(counter: RateCounter, userId: string, bytes: number): Promise<void> {
  const k = keys(userId);
  await counter.hit(k.files, DAY);
  if (bytes > 0) await counter.add(k.bytes, bytes, DAY);
}
