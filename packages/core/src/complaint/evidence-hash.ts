/**
 * 证据哈希（架构 §7 / §16：SHA-256（文件 + 规范化元数据），P1 定死以便 P3 上链锚定）。
 * v1 规范：sha256( content ‖ 0x00 ‖ canonicalJSON(meta) )
 *   content = 文件字节；tx_hash 类型无文件时为 UTF-8(txHash)
 *   meta    = { v: 1, complaintId, type, size, txHash }（键按字典序；size = content 字节数；txHash 无则 null）
 * label 为展示文本、可能被编辑，不入哈希。改规范必须升 v 并经 PO 定稿（见 to-po）。
 */
import { createHash } from 'node:crypto';

export const EVIDENCE_HASH_VERSION = 1;

export type EvidenceHashInput = { complaintId: string; type: 'screenshot' | 'chat_log' | 'tx_hash' | 'other'; content: Uint8Array; txHash?: string | null };

export function canonicalJson(o: Record<string, unknown>): string {
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k] ?? null)}`)
    .join(',')}}`;
}

export function evidenceSha256(i: EvidenceHashInput): string {
  const meta = canonicalJson({ v: EVIDENCE_HASH_VERSION, complaintId: i.complaintId, type: i.type, size: i.content.byteLength, txHash: i.txHash ?? null });
  return createHash('sha256').update(i.content).update(Buffer.from([0])).update(meta, 'utf8').digest('hex');
}
